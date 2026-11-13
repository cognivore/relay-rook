#![cfg(target_vendor = "apple")]

#[path = "../vendor/btleplug/src/corebluetooth/autorelease.rs"]
mod autorelease;

use futures::task::noop_waker_ref;
use objc2::rc::{autoreleasepool, Retained, Weak};
use objc2_foundation::NSObject;
use std::{
    cell::RefCell,
    future::{poll_fn, Future},
    task::{Context, Poll},
};

#[test]
fn releases_native_temporaries_on_every_pending_poll() {
    autoreleasepool(|_| {
        let last: RefCell<Option<Weak<NSObject>>> = RefCell::new(None);
        let worker = poll_fn(|_| {
            let object = NSObject::new();
            *last.borrow_mut() = Some(Weak::from_retained(&object));
            let _ = Retained::autorelease_ptr(object);
            Poll::<()>::Pending
        });
        let mut worker = Box::pin(autorelease::with_autorelease_pool(worker));
        let mut context = Context::from_waker(noop_waker_ref());
        for _ in 0..10_000 {
            assert!(worker.as_mut().poll(&mut context).is_pending());
            assert!(
                last.borrow().as_ref().unwrap().load().is_none(),
                "a pending Bluetooth worker must release its temporary native objects"
            );
        }
    });
}
