//! Strict display contract. A valid snapshot is never spending authority.
use super::CloudError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const VERSION: &str = "1.1.0-draft.1";
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

macro_rules! wire_enum {
    ($name:ident { $($variant:ident),+ }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all="kebab-case")]
        pub enum $name { $($variant),+ }
    }
}
wire_enum!(Environment {
    Local,
    Staging,
    Production
});
wire_enum!(Mode { Mock, Live });
wire_enum!(AccountStatus { Enabled, Disabled });
wire_enum!(SubscriptionState {
    None,
    CheckoutPending,
    Active,
    CancellationScheduled,
    PaymentProblem,
    Expired,
    Revoked
});
wire_enum!(Source {
    None,
    Test,
    Billing
});
wire_enum!(Reason {
    Entitled,
    NotInPlan,
    NoSubscription,
    Exhausted,
    AccountDisabled,
    ServicePaused,
    NotAvailable
});

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub allowed: bool,
    pub reason: Reason,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub managed_ai: Decision,
    pub selected_sync: Decision,
    pub backup: Decision,
    pub sharing: Decision,
}
impl Capabilities {
    fn all(&self) -> [&Decision; 4] {
        [
            &self.managed_ai,
            &self.selected_sync,
            &self.backup,
            &self.sharing,
        ]
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub id: Uuid,
    pub email_verified: bool,
    pub status: AccountStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub revocation_checked_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subscription {
    pub state: SubscriptionState,
    #[serde(deserialize_with = "nullable")]
    pub plan_id: Option<String>,
    pub source: Source,
    #[serde(deserialize_with = "nullable")]
    pub paid_through: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "nullable")]
    pub renewal_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "nullable")]
    pub cancellation_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Period {
    pub id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub currency: String,
    pub granted_micros: u64,
    pub spent_micros: u64,
    pub reserved_micros: u64,
    pub available_micros: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub contract_version: String,
    pub environment: Environment,
    pub mode: Mode,
    pub snapshot_id: Uuid,
    pub revision: u64,
    pub verified_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub account: Account,
    pub session: Session,
    pub subscription: Subscription,
    pub capabilities: Capabilities,
    #[serde(deserialize_with = "nullable")]
    pub current_period: Option<Period>,
}

impl Snapshot {
    pub fn validate(
        &self,
        environment: Environment,
        mode: Mode,
        account: Uuid,
        session: Uuid,
        minimum_revision: u64,
        now: DateTime<Utc>,
    ) -> Result<(), CloudError> {
        let valid = self.contract_version == VERSION
            && self.environment == environment
            && self.mode == mode
            && !self.snapshot_id.is_nil()
            && !account.is_nil()
            && !session.is_nil()
            && self.account.id == account
            && self.session.id == session
            && self.revision >= minimum_revision
            && self.revision <= MAX_INTEGER
            && self.verified_at <= now + chrono::Duration::seconds(5)
            && self.expires_at > now
            && self.expires_at > self.verified_at
            && self.expires_at - self.verified_at <= chrono::Duration::seconds(60)
            && self.session.expires_at >= self.expires_at
            && self.session.revocation_checked_at <= self.verified_at
            && self.verified_at - self.session.revocation_checked_at
                <= chrono::Duration::seconds(5)
            && !(environment == Environment::Production && mode != Mode::Live)
            && !((environment == Environment::Production || mode == Mode::Live)
                && self.subscription.source == Source::Test);
        if !valid {
            return Err(CloudError::Protocol);
        }
        let active = matches!(
            self.subscription.state,
            SubscriptionState::Active | SubscriptionState::CancellationScheduled
        );
        if self
            .subscription
            .plan_id
            .as_ref()
            .is_some_and(|p| p.is_empty() || p.len() > 120)
            || (active
                && (self.subscription.plan_id.is_none()
                    || self.subscription.source == Source::None
                    || !self
                        .subscription
                        .paid_through
                        .is_some_and(|date| date >= self.expires_at)))
            || (self.subscription.state == SubscriptionState::None
                && (self.subscription.plan_id.is_some()
                    || self.subscription.paid_through.is_some()
                    || self.subscription.source != Source::None))
            || (self.subscription.state == SubscriptionState::CancellationScheduled
                && self.subscription.cancellation_at.is_none())
        {
            return Err(CloudError::Protocol);
        }
        for decision in self.capabilities.all() {
            if decision.allowed != (decision.reason == Reason::Entitled)
                || (decision.allowed
                    && (!active
                        || !self.account.email_verified
                        || self.account.status != AccountStatus::Enabled))
            {
                return Err(CloudError::Protocol);
            }
        }
        if let Some(p) = &self.current_period {
            if p.id.is_nil()
                || p.currency != "USD"
                || p.starts_at > self.verified_at
                || p.ends_at <= self.verified_at
                || [
                    p.granted_micros,
                    p.spent_micros,
                    p.reserved_micros,
                    p.available_micros,
                ]
                .iter()
                .any(|n| *n > MAX_INTEGER)
                || p.available_micros
                    != p.granted_micros
                        .saturating_sub(p.spent_micros.saturating_add(p.reserved_micros))
            {
                return Err(CloudError::Protocol);
            }
        }
        if self.capabilities.managed_ai.allowed
            && !self
                .current_period
                .as_ref()
                .is_some_and(|p| p.available_micros > 0 && p.ends_at >= self.expires_at)
        {
            return Err(CloudError::Protocol);
        }
        Ok(())
    }
}

// Deliberately no Debug or Serialize: tokens never leave native memory.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Login {
    pub contract_version: String,
    pub environment: Environment,
    pub mode: Mode,
    pub account_id: Uuid,
    pub session_id: Uuid,
    pub access_token: String,
    pub snapshot: Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Revoked {
    pub contract_version: String,
    pub session_id: Uuid,
    pub revoked_at: DateTime<Utc>,
    pub scope: String,
    pub local_data_deleted: bool,
}
