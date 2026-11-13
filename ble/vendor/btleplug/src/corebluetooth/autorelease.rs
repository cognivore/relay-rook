//! Drain Objective-C temporaries after every poll, including Pending. A pool
//! around the entire worker would retain objects for the daemon's lifetime.

use objc2::rc::autoreleasepool;
use std::future::{poll_fn, Future};
use std::pin::pin;

pub(super) async fn with_autorelease_pool<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    poll_fn(|cx| autoreleasepool(|_| future.as_mut().poll(cx))).await
}
