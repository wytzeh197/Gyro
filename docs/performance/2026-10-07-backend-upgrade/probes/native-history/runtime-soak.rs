use std::{time::{Duration,Instant},sync::atomic::{AtomicUsize,Ordering}};
use gyro_core::{execution::{run_command,ExecutionRequest,ExecutionTermination,CancellationToken}, process_guard::{ProcessLeaseScope,enable_crash_cleanup,run_crash_helper}};
use serde_json::json;
fn snapshot(pid:i32)->serde_json::Value {
    let mut info:libc::proc_taskinfo=unsafe{std::mem::zeroed()};
    let size=std::mem::size_of_val(&info) as i32;
    let read=unsafe{libc::proc_pidinfo(pid,libc::PROC_PIDTASKINFO,0,(&mut info as *mut libc::proc_taskinfo).cast(),size)};
    assert_eq!(read,size);
    let mut fds:Vec<libc::proc_fdinfo>=Vec::with_capacity(2048);
    let bytes=unsafe{libc::proc_pidinfo(pid,libc::PROC_PIDLISTFDS,0,fds.as_mut_ptr().cast(),(fds.capacity()*std::mem::size_of::<libc::proc_fdinfo>()) as i32)};
    assert!(bytes>=0);
    json!({"pid":pid,"rssBytes":info.pti_resident_size,"threads":info.pti_threadnum,"fds":bytes as usize/std::mem::size_of::<libc::proc_fdinfo>()})
}
fn children(pid:i32)->Vec<i32> {
    let mut pids=[0i32;64];
    let bytes=unsafe{libc::proc_listpids(6,pid as u32,pids.as_mut_ptr().cast(),std::mem::size_of_val(&pids) as i32)};
    assert!(bytes>=0);pids[..bytes as usize/4].iter().copied().filter(|pid|*pid>0).collect()
}
fn main()->Result<(),Box<dyn std::error::Error>> {
    if let Some(code)=run_crash_helper(){std::process::exit(code);}
    enable_crash_cleanup();
    let pid=std::process::id() as i32;
    let before=snapshot(pid);
    let scope=ProcessLeaseScope::unleased();let owner=scope.owner();
    for _ in 0..10 {assert!(run_command(ExecutionRequest::new("/usr/bin/true"),CancellationToken::default(), |_|{} )?.succeeded());}
    let helpers=children(pid);assert_eq!(helpers.len(),1);
    let helper=helpers[0];let warm=json!({"root":snapshot(pid),"helper":snapshot(helper)});
    let completed=std::sync::Arc::new(AtomicUsize::new(0));
    let started=Instant::now();let mut handles=Vec::new();
    for worker in 0..4 {
        let owner=owner.clone();let completed=completed.clone();
        handles.push(std::thread::spawn(move||{
            let _entered=owner.enter();let mut counts=[0usize;5];
            for i in 0..500 {
                let category=(i%50).min(4);
                let token=CancellationToken::default();
                let mut request=ExecutionRequest::new(if category==0 {"/gyro-runtime-soak-no-such-program"} else if category==4 {"/usr/bin/true"} else {"/bin/sh"});
                request.credentials=gyro_core::credentials::CredentialPolicy::for_provider("soak-mock");
                match category {
                    1=>request.args=["-c","printf ready; sleep 30"].into_iter().map(Into::into).collect(),
                    2=>{request.args=["-c","sleep 30"].into_iter().map(Into::into).collect();request.timeout=Duration::from_millis(30);},
                    3=>{request.args=["-c","printf '%10000s' x"].into_iter().map(Into::into).collect();request.max_total_output_bytes=1024;},
                    _=>{}
                }
                let cancel=token.clone();
                let result=run_command(request,token,|chunk|{if category==1 && chunk.text.contains("ready"){cancel.cancel();}});
                match category {
                    0=>assert!(result.is_err()),
                    1=>assert_eq!(result.unwrap().termination,ExecutionTermination::Cancelled),
                    2=>assert_eq!(result.unwrap().termination,ExecutionTermination::TimedOut),
                    3=>assert_eq!(result.unwrap().termination,ExecutionTermination::OutputLimit),
                    _=>assert!(result.unwrap().succeeded()),
                }
                counts[category]+=1;completed.fetch_add(1,Ordering::Relaxed);
            }
            (worker,counts)
        }));
    }
    let mut samples=Vec::new();
    while handles.iter().any(|handle|!handle.is_finished()) {
        samples.push(json!({"elapsedMs":started.elapsed().as_millis(),"completed":completed.load(Ordering::Relaxed),"root":snapshot(pid),"helper":snapshot(helper)}));
        std::thread::sleep(Duration::from_millis(50));
    }
    let counts=handles.into_iter().map(|handle|handle.join().unwrap()).collect::<Vec<_>>();
    assert_eq!(completed.load(Ordering::Relaxed),2000);
    let idle=json!({"root":snapshot(pid),"helper":snapshot(helper)});
    assert_eq!(children(pid),vec![helper]);
    drop(owner);drop(scope);
    let after=snapshot(pid);let remaining=children(pid);assert!(remaining.is_empty());
    println!("{}",json!({"scope":"Standalone shared core runner; 2000 mock commands across four workers; no providers, accounts or UI", "commands":2000,"countsByWorker":counts,"elapsedMs":started.elapsed().as_millis(),"before":before,"warm":warm,"samples":samples,"idle":idle,"afterScopeDrop":after,"remainingChildren":remaining}));
    Ok(())
}