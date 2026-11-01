use crate::usage::{UsageCoverage, UsageTokens};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceSnapshot {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub effective_date: String,
    pub currency: String,
    /// Micro-units of currency per million tokens, avoiding floating-point ledger drift.
    pub input_micros_per_million: u64,
    pub cached_micros_per_million: Option<u64>,
    pub cache_write_micros_per_million: Option<u64>,
    pub output_micros_per_million: u64,
}
impl PriceSnapshot {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.id.trim().is_empty()
                && self.id.len() <= 160
                && !self.provider.trim().is_empty()
                && !self.model.trim().is_empty(),
            "Price snapshot needs an identity, provider and model"
        );
        let date = chrono::NaiveDate::parse_from_str(&self.effective_date, "%Y-%m-%d")?;
        anyhow::ensure!(
            date.format("%Y-%m-%d").to_string() == self.effective_date,
            "Effective date must be canonical YYYY-MM-DD"
        );
        anyhow::ensure!(
            self.currency.len() == 3 && self.currency.bytes().all(|b| b.is_ascii_uppercase()),
            "Currency must be a three-letter uppercase code"
        );
        Ok(())
    }
    pub fn price(&self, tokens: UsageTokens) -> Option<Cost> {
        let accounting = tokens.effective_accounting();
        if !matches!(
            accounting.coverage,
            UsageCoverage::Complete | UsageCoverage::Estimated
        ) || !accounting.known.input
            || !accounting.known.output
        {
            return None;
        }
        if tokens.input_tokens > 0
            && ((self.cached_micros_per_million.is_some() && !accounting.known.cache_read)
                || (self.cache_write_micros_per_million.is_some() && !accounting.known.cache_write))
        {
            return None;
        }
        // Reasoning is already a subset of output; cache reads/writes are input subsets.
        let cached = tokens.cached_input_tokens;
        let write = tokens.cache_write_tokens;
        let ordinary = tokens
            .input_tokens
            .checked_sub(cached)?
            .checked_sub(write)?;
        let cached_rate = if cached > 0 {
            self.cached_micros_per_million?
        } else {
            0
        };
        let write_rate = if write > 0 {
            self.cache_write_micros_per_million?
        } else {
            0
        };
        let amount = [
            (ordinary, self.input_micros_per_million),
            (cached, cached_rate),
            (write, write_rate),
            (tokens.output_tokens, self.output_micros_per_million),
        ]
        .into_iter()
        .try_fold(0u128, |total, (count, rate)| {
            total.checked_add(u128::from(count).checked_mul(u128::from(rate))?)
        })?;
        Some(Cost {
            snapshot_id: self.id.clone(),
            currency: self.currency.clone(),
            micros: u64::try_from(amount.div_ceil(1_000_000)).ok()?,
            estimated: true,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub snapshot_id: String,
    pub currency: String,
    pub micros: u64,
    pub estimated: bool,
}
pub fn snapshot<'a>(
    prices: &'a [PriceSnapshot],
    provider: &str,
    model: &str,
    date: &str,
) -> Option<&'a PriceSnapshot> {
    prices
        .iter()
        .filter(|p| p.provider == provider && p.model == model && p.effective_date.as_str() <= date)
        .max_by(|a, b| {
            a.effective_date
                .cmp(&b.effective_date)
                .then(a.id.cmp(&b.id))
        })
}
pub fn validate_append(previous: &[PriceSnapshot], next: &[PriceSnapshot]) -> anyhow::Result<()> {
    let mut ids = std::collections::HashSet::new();
    anyhow::ensure!(next.len() <= 500, "Too many price snapshots");
    for p in next {
        p.validate()?;
        anyhow::ensure!(ids.insert(&p.id), "Duplicate snapshot identity");
    }
    for p in previous {
        anyhow::ensure!(
            next.iter().any(|n| n == p),
            "Existing price snapshots are immutable; append a new snapshot"
        );
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn p() -> PriceSnapshot {
        PriceSnapshot {
            id: "v1".into(),
            provider: "custom:a".into(),
            model: "m".into(),
            effective_date: "2026-10-12".into(),
            currency: "USD".into(),
            input_micros_per_million: 1_000_000,
            cached_micros_per_million: Some(100_000),
            cache_write_micros_per_million: Some(2_000_000),
            output_micros_per_million: 2_000_000,
        }
    }
    #[test]
    fn subsets_are_not_double_counted() {
        let t = UsageTokens::measured(Some(100), Some(50), Some(20), Some(10), Some(120))
            .with_cache_write(Some(10));
        assert_eq!(p().price(t).unwrap().micros, 105);
    }
    #[test]
    fn incomplete_is_unknown() {
        assert!(p()
            .price(UsageTokens::unavailable(
                crate::usage::UsageReason::MissingUsage
            ))
            .is_none());
    }
    #[test]
    fn immutable() {
        let a = p();
        let mut b = a.clone();
        b.output_micros_per_million = 0;
        assert!(validate_append(&[a], &[b]).is_err());
    }
    #[test]
    fn missing_cache_categories_cannot_be_priced_as_zero() {
        let counts = UsageTokens::measured(Some(100), None, Some(10), None, Some(110));
        assert!(p().price(counts).is_none());
    }
}
