//! One owned scan session: cancellation of a socket request must not leave
//! CoreBluetooth scanning or let another session race its cleanup.

use anyhow::{Context, Result};
use futures::{Stream, StreamExt};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::Mutex;

pub type Events<I> = Pin<Box<dyn Stream<Item = I> + Send>>;

pub trait ScanBackend: Send + Sync + 'static {
    type Id: Send;
    type Match: Send;

    fn events(&self) -> impl Future<Output = Result<Events<Self::Id>>> + Send;
    fn start(&self) -> impl Future<Output = Result<()>> + Send;
    fn stop(&self) -> impl Future<Output = Result<()>> + Send;
    fn matching(&self, id: Self::Id) -> impl Future<Output = Result<Option<Self::Match>>> + Send;
}

const MAX_SCAN: Duration = Duration::from_secs(30);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct CleanupFailure {
    primary: Option<anyhow::Error>,
    cleanup: anyhow::Error,
    found: usize,
}

impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(primary) = &self.primary {
            write!(f, "scan failed: {primary:#}; ")?;
        }
        write!(
            f,
            "stopping BLE scan failed after finding {} board(s): {:#}",
            self.found, self.cleanup
        )
    }
}

impl std::error::Error for CleanupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.primary.as_ref().unwrap_or(&self.cleanup).as_ref())
    }
}

pub async fn scan<B: ScanBackend>(
    backend: B,
    lock: Arc<Mutex<()>>,
    duration: Duration,
) -> Result<Vec<B::Match>> {
    // The worker owns both the lock and cleanup. Dropping the caller's future
    // leaves this bounded worker running until stop() completes.
    tokio::spawn(async move {
        let _guard = lock.lock().await;
        let mut events = tokio::time::timeout(CONTROL_TIMEOUT, backend.events())
            .await
            .context("timed out subscribing to BLE discovery events")??;
        let result = async {
            tokio::time::timeout(CONTROL_TIMEOUT, backend.start())
                .await
                .context("timed out starting BLE scan")??;
            let discovered = tokio::time::timeout(duration.min(MAX_SCAN), async {
                while let Some(id) = events.next().await {
                    if let Some(board) = backend.matching(id).await? {
                        return Ok(vec![board]);
                    }
                }
                anyhow::bail!("BLE discovery event stream closed during scan")
            })
            .await;
            match discovered {
                Ok(result) => result,
                Err(_) => Ok(Vec::new()), // A quiet scan is a normal outcome.
            }
        }
        .await;
        let cleanup = tokio::time::timeout(CONTROL_TIMEOUT, backend.stop())
            .await
            .context("timed out stopping BLE scan")
            .and_then(|result| result);
        match (result, cleanup) {
            (result, Ok(())) => result,
            (Ok(found), Err(cleanup)) => Err(CleanupFailure {
                primary: None,
                cleanup,
                found: found.len(),
            }
            .into()),
            (Err(primary), Err(cleanup)) => Err(CleanupFailure {
                primary: Some(primary),
                cleanup,
                found: 0,
            }
            .into()),
        }
    })
    .await
    .context("BLE scan worker failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        stopped: Arc<AtomicUsize>,
        quiet: bool,
        lookup_fails: bool,
        stop_fails: bool,
    }

    impl ScanBackend for Fake {
        type Id = u8;
        type Match = u8;
        async fn events(&self) -> Result<Events<u8>> {
            Ok(if self.quiet {
                Box::pin(futures::stream::pending())
            } else {
                Box::pin(futures::stream::iter([0, 1]))
            })
        }
        async fn start(&self) -> Result<()> {
            Ok(())
        }
        async fn stop(&self) -> Result<()> {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            if self.stop_fails {
                anyhow::bail!("stop fault");
            }
            Ok(())
        }
        async fn matching(&self, id: u8) -> Result<Option<u8>> {
            if self.lookup_fails {
                anyhow::bail!("lookup fault");
            }
            Ok((id == 1).then_some(id))
        }
    }

    #[tokio::test]
    async fn discovers_a_board_and_stops() {
        let stopped = Arc::new(AtomicUsize::new(0));
        let fake = Fake {
            stopped: stopped.clone(),
            quiet: false,
            lookup_fails: false,
            stop_fails: false,
        };
        assert_eq!(
            scan(fake, Arc::new(Mutex::new(())), Duration::from_secs(1))
                .await
                .unwrap(),
            vec![1]
        );
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn preserves_lookup_and_cleanup_faults() {
        let fake = Fake {
            stopped: Arc::new(AtomicUsize::new(0)),
            quiet: false,
            lookup_fails: true,
            stop_fails: true,
        };
        let error = scan(fake, Arc::new(Mutex::new(())), Duration::from_secs(1))
            .await
            .unwrap_err();
        let failure = error.downcast_ref::<CleanupFailure>().unwrap();
        assert_eq!(
            failure.primary.as_ref().unwrap().to_string(),
            "lookup fault"
        );
        assert_eq!(failure.cleanup.to_string(), "stop fault");
    }

    #[tokio::test]
    async fn cancelling_the_caller_still_stops_and_releases_the_scan_lock() {
        let stopped = Arc::new(AtomicUsize::new(0));
        let lock = Arc::new(Mutex::new(()));
        let fake = Fake {
            stopped: stopped.clone(),
            quiet: true,
            lookup_fails: false,
            stop_fails: false,
        };
        let caller = tokio::spawn(scan(fake, lock.clone(), Duration::from_millis(30)));
        tokio::task::yield_now().await;
        caller.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while stopped.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the scan owner must stop even after caller cancellation");
        assert!(lock.try_lock().is_ok());
    }
}
