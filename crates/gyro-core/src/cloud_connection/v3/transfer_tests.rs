use super::transfer::*;
use super::{project, Error, CHUNK};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, sync::Mutex};
use uuid::Uuid;
struct State {
    id: Uuid,
    begin_calls: usize,
    received: BTreeMap<usize, Vec<u8>>,
    fail_once: bool,
    status: &'static str,
}
struct Server(Mutex<State>);
impl Remote for Server {
    fn begin(&self, _: Value) -> Result<Value, Error> {
        let mut s = self.0.lock().unwrap();
        s.begin_calls += 1;
        if s.status == "cancelled" {
            s.id = Uuid::new_v4();
            s.received.clear();
            s.status = "active";
        }
        Ok(json!({"uploadId":s.id}))
    }
    fn status(&self, id: Uuid) -> Result<Value, Error> {
        let s = self.0.lock().unwrap();
        assert_eq!(s.id, id);
        Ok(
            json!({"uploadId":s.id,"size":s.received.values().map(Vec::len).sum::<usize>(),"status":s.status,"ready":s.received.iter().map(|(i,b)|json!({"index":i,"size":b.len(),"sha256":format!("{:x}",Sha256::digest(b))})).collect::<Vec<_>>()}),
        )
    }
    fn chunk(&self, id: Uuid, index: usize, bytes: &[u8]) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap();
        assert_eq!(s.id, id);
        if index == 1 && s.fail_once {
            s.fail_once = false;
            return Err(Error::Unavailable);
        }
        assert!(!s.received.contains_key(&index));
        s.received.insert(index, bytes.to_vec());
        Ok(())
    }
    fn commit(&self, id: Uuid) -> Result<Value, Error> {
        let mut s = self.0.lock().unwrap();
        assert_eq!(s.id, id);
        s.status = "committed";
        Ok(
            json!({"uploadId":s.id,"size":s.received.values().map(Vec::len).sum::<usize>(),"status":"committed"}),
        )
    }
    fn cancel(&self, id: Uuid) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap();
        assert_eq!(s.id, id);
        if s.status != "committed" {
            s.status = "cancelled";
        }
        Ok(())
    }
    fn revision(&self, _: Uuid) -> Result<Value, Error> {
        Err(Error::Unavailable)
    }
    fn download(&self, _: Uuid, _: usize) -> Result<Vec<u8>, Error> {
        Err(Error::Unavailable)
    }
}
#[test]
fn restart_resumes_only_missing_chunks_and_committed_cleanup_preserves_cloud_version() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    let marker = "private-snapshot-marker-never-in-metadata";
    let mut bytes = vec![97; CHUNK + 123];
    bytes[..marker.len()].copy_from_slice(marker.as_bytes());
    fs::write(source.join("file.txt"), bytes).unwrap();
    let spool = root.path().join("spool");
    let selected = project::preview(&source).unwrap();
    let prepared = project::prepare(&selected, &spool).unwrap();
    let request = Uuid::new_v4();
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    let pending = Pending {
        request_id: request,
        account_id: account,
        device_id: device,
        object_id: Uuid::new_v4(),
        base_revision_id: None,
        label: "Project".into(),
        kind: "project".into(),
        prepared,
        upload_id: None,
        remote_request_id: None,
    };
    let outbox = Outbox::at(spool.clone());
    outbox.save(&pending).unwrap();
    let metadata = fs::read_to_string(spool.join(format!("{request}.json"))).unwrap();
    assert!(metadata.len() < 8192);
    assert!(!metadata.contains(marker));
    let server = Server(Mutex::new(State {
        id: Uuid::new_v4(),
        begin_calls: 0,
        received: BTreeMap::new(),
        fail_once: true,
        status: "active",
    }));
    assert!(outbox.resume(&server, request, account, device).is_err());
    assert_eq!(server.0.lock().unwrap().received.len(), 1);
    drop(outbox);
    let restarted = Outbox::at(spool.clone());
    assert_eq!(
        restarted.resume(&server, request, account, device).unwrap()["status"],
        "committed"
    );
    let completed = restarted.read(request, account, device).unwrap();
    assert_eq!(
        Outbox::at(spool.clone())
            .completed_status(&completed)
            .as_deref(),
        Some("committed")
    );
    assert_eq!(server.0.lock().unwrap().begin_calls, 1);
    assert_eq!(server.0.lock().unwrap().received.len(), 2);
    assert!(restarted.read(request, Uuid::new_v4(), device).is_err());
    assert!(restarted.renew(&server, request, account, device).is_err());
    restarted.cancel(&server, request, account, device).unwrap();
    assert_eq!(server.0.lock().unwrap().status, "committed");
    assert!(!spool.join(format!("{}.pack", pending.prepared.id)).exists());
    assert!(source.join("file.txt").exists());
}
#[test]
fn interrupted_restore_never_overwrites_an_existing_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), "original contents").unwrap();
    let spool = root.path().join("spool");
    let p = project::prepare(&project::preview(&source).unwrap(), &spool).unwrap();
    let pack = spool.join(format!("{}.pack", p.id));
    let mut b = fs::read(&pack).unwrap();
    *b.last_mut().unwrap() ^= 1;
    fs::write(&pack, b).unwrap();
    let destination = root.path().join("restore");
    assert!(project::restore(&pack, &p, &destination).is_err());
    assert!(destination.join(".gyro-restore-incomplete").exists());
    assert!(matches!(
        project::restore(&pack, &p, &destination),
        Err(Error::Destination)
    ));
    assert_eq!(
        fs::read_to_string(source.join("a.txt")).unwrap(),
        "original contents"
    );
}

#[test]
fn cancellation_during_begin_never_dispatches_chunks_or_resurrects_the_outbox() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), "reviewed file").unwrap();
    let outbox = Outbox::at(root.path().join("spool"));
    let prepared = project::prepare(&project::preview(&source).unwrap(), outbox.root()).unwrap();
    let request = Uuid::new_v4();
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    let p = Pending {
        request_id: request,
        account_id: account,
        device_id: device,
        object_id: Uuid::new_v4(),
        base_revision_id: None,
        label: "Project".into(),
        kind: "project".into(),
        prepared,
        upload_id: None,
        remote_request_id: None,
    };
    outbox.save(&p).unwrap();
    struct Cancelling<'a> {
        outbox: &'a Outbox,
        request: Uuid,
        server: Server,
    }
    impl Remote for Cancelling<'_> {
        fn begin(&self, value: Value) -> Result<Value, Error> {
            let response = self.server.begin(value)?;
            fs::write(
                self.outbox
                    .root()
                    .join(format!("{}.cancelled", self.request)),
                b"",
            )?;
            Ok(response)
        }
        fn status(&self, _: Uuid) -> Result<Value, Error> {
            panic!("No status after cancellation")
        }
        fn chunk(&self, _: Uuid, _: usize, _: &[u8]) -> Result<(), Error> {
            panic!("No chunk after cancellation")
        }
        fn commit(&self, _: Uuid) -> Result<Value, Error> {
            panic!("No commit after cancellation")
        }
        fn cancel(&self, id: Uuid) -> Result<(), Error> {
            self.server.cancel(id)
        }
        fn revision(&self, _: Uuid) -> Result<Value, Error> {
            unreachable!()
        }
        fn download(&self, _: Uuid, _: usize) -> Result<Vec<u8>, Error> {
            unreachable!()
        }
    }
    let remote = Cancelling {
        outbox: &outbox,
        request,
        server: Server(Mutex::new(State {
            id: Uuid::new_v4(),
            begin_calls: 0,
            received: BTreeMap::new(),
            fail_once: false,
            status: "active",
        })),
    };
    assert!(matches!(
        outbox.resume(&remote, request, account, device),
        Err(Error::Cancelled)
    ));
    assert_eq!(remote.server.0.lock().unwrap().status, "cancelled");
    assert!(matches!(outbox.save(&p), Err(Error::Cancelled)));
    assert!(matches!(
        outbox.resume_controlled(&remote, request, account, device, &|| false),
        Err(Error::Cancelled)
    ));
    assert!(source.join("a.txt").exists());
}

#[test]
fn known_policy_versions_are_supported_without_accepting_unknown_terms() {
    assert!(super::supported_policy(super::POLICY));
    assert!(super::supported_policy(super::LEGACY_POLICY));
    assert!(!super::supported_policy("unknown-policy"));
}

#[test]
fn parallel_chunks_are_bounded_ordered_and_join_failures() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier,
    };
    let barrier = Barrier::new(4);
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let values = parallel_chunks(4, |i| {
        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(n, Ordering::SeqCst);
        barrier.wait();
        std::thread::sleep(std::time::Duration::from_millis((4 - i) as u64 * 5));
        active.fetch_sub(1, Ordering::SeqCst);
        Ok(i)
    })
    .unwrap()
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .unwrap();
    assert_eq!(values, vec![0, 1, 2, 3]);
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert!(matches!(parallel_chunks(5, |_| Ok(())), Err(Error::Limit)));
    let finished = AtomicUsize::new(0);
    let results = parallel_chunks(4, |i| {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        finished.fetch_add(1, Ordering::SeqCst);
        if i == 0 {
            Err(Error::Unavailable)
        } else {
            Ok(i)
        }
    })
    .unwrap();
    assert!(results[0].is_err());
    assert_eq!(finished.load(Ordering::SeqCst), 4);
}

#[test]
fn parallel_restore_preserves_good_chunks_and_retries_only_corrupt_or_missing_data() {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Download {
        prepared: project::Prepared,
        chunks: Vec<Vec<u8>>,
        requests: Mutex<Vec<usize>>,
        corrupt: AtomicBool,
    }
    impl Remote for Download {
        fn begin(&self, _: Value) -> Result<Value, Error> {
            unreachable!()
        }
        fn status(&self, _: Uuid) -> Result<Value, Error> {
            unreachable!()
        }
        fn chunk(&self, _: Uuid, _: usize, _: &[u8]) -> Result<(), Error> {
            unreachable!()
        }
        fn commit(&self, _: Uuid) -> Result<Value, Error> {
            unreachable!()
        }
        fn cancel(&self, _: Uuid) -> Result<(), Error> {
            unreachable!()
        }
        fn revision(&self, _: Uuid) -> Result<Value, Error> {
            Ok(
                json!({"kind":"project","size_bytes":self.prepared.size,"sha256":self.prepared.sha256,"manifest_sha256":self.prepared.manifest_sha256,"chunks":self.chunks.iter().map(|b|json!({"sha256":format!("{:x}",Sha256::digest(b))})).collect::<Vec<_>>()}),
            )
        }
        fn download(&self, _: Uuid, index: usize) -> Result<Vec<u8>, Error> {
            self.requests.lock().unwrap().push(index);
            let mut bytes = self.chunks[index].clone();
            if index == 1 && self.corrupt.swap(false, Ordering::SeqCst) {
                bytes[0] ^= 1;
            }
            Ok(bytes)
        }
        fn download_batch(
            &self,
            id: Uuid,
            indices: &[usize],
        ) -> Result<Vec<Result<Vec<u8>, Error>>, Error> {
            parallel_chunks(indices.len(), |i| self.download(id, indices[i]))
        }
    }
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("source");
    fs::create_dir(&src).unwrap();
    fs::write(src.join("payload"), vec![42; CHUNK * 4 + 31]).unwrap();
    let prepared = project::prepare(
        &project::preview(&src).unwrap(),
        &root.path().join("upload"),
    )
    .unwrap();
    let bytes = fs::read(
        root.path()
            .join("upload")
            .join(format!("{}.pack", prepared.id)),
    )
    .unwrap();
    let remote = Download {
        prepared: prepared.clone(),
        chunks: bytes.chunks(CHUNK).map(|b| b.to_vec()).collect(),
        requests: Mutex::new(Vec::new()),
        corrupt: AtomicBool::new(true),
    };
    let out = Outbox::at(root.path().join("download"));
    let revision = Uuid::new_v4();
    assert!(matches!(
        out.download(&remote, revision),
        Err(Error::Integrity)
    ));
    let mut first = remote.requests.lock().unwrap().clone();
    first.sort_unstable();
    assert_eq!(first, vec![0, 1, 2, 3]);
    remote.requests.lock().unwrap().clear();
    let got = out.download(&remote, revision).unwrap();
    let mut second = remote.requests.lock().unwrap().clone();
    second.sort_unstable();
    assert_eq!(second, vec![1, 4]);
    let destination = root.path().join("restored");
    out.restore_download(&got, &destination).unwrap();
    assert_eq!(
        fs::read(destination.join("payload")).unwrap(),
        fs::read(src.join("payload")).unwrap()
    );
    assert_eq!(
        out.download(&remote, revision).unwrap().sha256,
        prepared.sha256
    );
    assert_eq!(remote.requests.lock().unwrap().len(), 2);
}
