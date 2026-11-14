use serde::Serialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub owner: String,
    pub generation: u64,
    pub requested_by: Option<String>,
    #[serde(skip)]
    expires: Instant,
}
pub struct Controls {
    entries: HashMap<String, Control>,
    next: u64,
}
impl Default for Controls {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            next: rand::random::<u64>() & ((1u64 << 48) - 1),
        }
    }
}
impl Controls {
    pub fn current(&mut self, session: &str) -> Option<Control> {
        self.entries.retain(|_, c| c.expires > Instant::now());
        self.entries.get(session).cloned()
    }
    pub fn claim(
        &mut self,
        session: &str,
        peer: &str,
        force_local: bool,
    ) -> Result<Control, String> {
        if let Some(c) = self.current(session) {
            if c.owner != peer && !force_local {
                return Err(
                    "This session is controlled on another device. Request control first.".into(),
                );
            }
            if c.owner == peer {
                let c = self.entries.get_mut(session).unwrap();
                c.expires = Instant::now() + Duration::from_secs(30);
                return Ok(c.clone());
            }
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Control generation exhausted")?;
        let c = Control {
            owner: peer.into(),
            generation: self.next,
            requested_by: None,
            expires: Instant::now() + Duration::from_secs(30),
        };
        self.entries.insert(session.into(), c.clone());
        Ok(c)
    }
    pub fn check(
        &mut self,
        session: &str,
        peer: &str,
        generation: Option<u64>,
    ) -> Result<(), String> {
        let c = self
            .current(session)
            .ok_or("Take control of this session first")?;
        if c.owner != peer || generation != Some(c.generation) {
            return Err("Control changed. Refresh this session before acting.".into());
        }
        Ok(())
    }
    pub fn request(&mut self, session: &str, peer: &str) -> Result<Control, String> {
        let mut c = self
            .current(session)
            .ok_or("This session is available; take control")?;
        c.requested_by = Some(peer.into());
        self.entries.insert(session.into(), c.clone());
        Ok(c)
    }
    pub fn transfer(
        &mut self,
        session: &str,
        owner: &str,
        generation: Option<u64>,
        peer: &str,
    ) -> Result<Control, String> {
        self.check(session, owner, generation)?;
        if self
            .current(session)
            .and_then(|c| c.requested_by)
            .as_deref()
            != Some(peer)
        {
            return Err("There is no matching control request".into());
        }
        self.entries.remove(session);
        self.claim(session, peer, false)
    }
    pub fn release(&mut self, session: &str, peer: &str) {
        if self.entries.get(session).is_some_and(|c| c.owner == peer) {
            self.entries.remove(session);
        }
    }
    pub fn revoke(&mut self, peer: &str) {
        self.entries.retain(|_, c| c.owner != peer);
    }
    pub fn all(&mut self) -> HashMap<String, Control> {
        self.entries.retain(|_, c| c.expires > Instant::now());
        self.entries.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfer_fences_stale_inputs_and_host_can_reclaim() {
        let mut c = Controls::default();
        let first = c.claim("s", "a", false).unwrap();
        assert!(c.claim("s", "b", false).is_err());
        c.request("s", "b").unwrap();
        let second = c.transfer("s", "a", Some(first.generation), "b").unwrap();
        assert!(c.check("s", "a", Some(first.generation)).is_err());
        assert!(c.check("s", "b", Some(second.generation)).is_ok());
        c.claim("s", "local", true).unwrap();
        assert!(c.check("s", "b", Some(second.generation)).is_err());
    }
}
