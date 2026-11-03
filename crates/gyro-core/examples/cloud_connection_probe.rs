//! Headless native-code / local HTTP acceptance. Does not launch Gyro or WebKit.
use gyro_core::cloud_connection::{contract::SubscriptionState, Action, Connection, State};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(debug_assertions) {
        return Err("Mock probe is debug-only".into());
    }
    let c = Connection::from_debug_environment();
    assert_eq!(
        c.view().state,
        State::SignedOut,
        "Set GYRO_CLOUD_MOCK_PORT to a fresh disposable server"
    );
    assert!(
        c.run(Action::Restore).is_err(),
        "Use a fresh mock server for this probe"
    );
    let pending = c.run(Action::SubscribePlus)?.snapshot.unwrap();
    assert_eq!(
        pending.subscription.state,
        SubscriptionState::CheckoutPending
    );
    assert!(!pending.capabilities.managed_ai.allowed);
    let active = c.run(Action::CompleteCheckout)?.snapshot.unwrap();
    assert!(active.capabilities.managed_ai.allowed);
    let spent = c.run(Action::ManagedRequest)?.snapshot.unwrap();
    assert_eq!(spent.current_period.as_ref().unwrap().spent_micros, 10_000);
    c.run(Action::SignOut)?;
    assert!(c.view().snapshot.is_none());
    assert!(!c.view().revocation_pending);
    let restored = c.run(Action::Restore)?.snapshot.unwrap();
    assert_eq!(restored.account.id, active.account.id);
    assert_eq!(
        restored.current_period.as_ref().unwrap().available_micros,
        40_000
    );
    let retry = c.run(Action::CompleteCheckout)?.snapshot.unwrap();
    assert_eq!(
        retry.current_period.as_ref().unwrap().available_micros,
        40_000
    );
    let cancelled = c.run(Action::CancelRenewal)?.snapshot.unwrap();
    assert_eq!(
        cancelled.subscription.state,
        SubscriptionState::CancellationScheduled
    );
    assert!(cancelled.capabilities.managed_ai.allowed);
    for _ in 0..4 {
        c.run(Action::ManagedRequest)?;
    }
    assert!(!c.view().snapshot.unwrap().capabilities.managed_ai.allowed);
    assert!(c.run(Action::ManagedRequest).is_err());
    c.run(Action::Refresh)?;
    let expired = c.run(Action::Expire)?.snapshot.unwrap();
    assert_eq!(expired.subscription.state, SubscriptionState::Expired);
    assert!(!expired.capabilities.managed_ai.allowed);
    c.run(Action::SignOut)?;
    println!("PASS: headless native Rust to local mock HTTP: account-free state, Restore without signup, Subscribe, pending checkout, one grant, preserved balance, cancellation, exhaustion, expiry and revocation. No native UI, hosted Auth, payment, Keychain or real AI exercised.");
    Ok(())
}
