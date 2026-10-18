//! macOS permission sheets and live recognition for composer dictation.
//!
//! A synchronous Tauri command runs on the webview thread. Waiting there for
//! `requestAccessForMediaType` or `requestAuthorization` stalls the thread that
//! presents the sheet and delivers its completion, so the click times out as
//! denied. Both commands therefore wait on a blocking pool.
//!
//! WKWebView's Web Speech API reports that denial even after the app is
//! allowed, so the microphone is read with AVAudioEngine and transcribed with
//! Speech.framework.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How long a click waits while a system sheet is open.
const PERMISSION_WAIT: Duration = Duration::from_secs(180);
const DICTATION_EVENT: &str = "dictation-update";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DictationAccess {
    pub microphone: &'static str,
    pub speech: &'static str,
}

#[derive(Clone, Serialize)]
struct DictationUpdate {
    kind: &'static str,
    text: String,
}

fn access_error(access: DictationAccess) -> Option<&'static str> {
    if access.microphone == "unsupported" && access.speech == "unsupported" {
        return None;
    }
    if access.microphone != "authorized" {
        return Some("Allow the microphone to dictate.");
    }
    if access.speech == "denied" || access.speech == "restricted" {
        return Some("Allow Speech Recognition to dictate.");
    }
    None
}

/// `AVAuthorizationStatus`: 1 restricted, 2 denied, 3 authorized.
fn av_authorization_label(status: isize) -> &'static str {
    match status {
        0 => "not-determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "denied",
    }
}

/// `SFSpeechRecognizerAuthorizationStatus` before a request is made.
fn speech_authorization_label(status: isize) -> &'static str {
    match status {
        0 => "not-determined",
        1 => "denied",
        2 => "restricted",
        3 => "authorized",
        _ => "denied",
    }
}

/// Apple's completion status. Not-determined is not a grant.
fn speech_label(status: isize) -> &'static str {
    match speech_authorization_label(status) {
        "not-determined" => "denied",
        label => label,
    }
}

/// Dictation may run on Apple's servers when the offline model is missing, so
/// these codes mean the recognition service could not be reached.
const NETWORK_NEEDED: &str = "Dictation needs a network connection.";

fn speech_failure(code: isize) -> &'static str {
    match code {
        1110 => "No speech was heard.",
        201 | 1100 | 1101 | 1107 | 1700 => NETWORK_NEEDED,
        _ => "Dictation stopped.",
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: DictationAccess = DictationAccess {
    microphone: "unsupported",
    speech: "unsupported",
};

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn request_dictation_access(app: AppHandle) -> DictationAccess {
    let _ = app;
    UNSUPPORTED
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn start_dictation(app: AppHandle) -> Result<(), String> {
    let _ = app;
    Err("Dictation is not available in this window.".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn stop_dictation(app: AppHandle) -> Result<(), String> {
    let _ = app;
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn request_dictation_access(app: AppHandle) -> DictationAccess {
    tauri::async_runtime::spawn_blocking(move || decide(&app))
        .await
        .unwrap_or(DictationAccess {
            microphone: "denied",
            speech: "unsupported",
        })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn start_dictation(app: AppHandle) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || begin_dictation(app)).await {
        Ok(result) => result,
        Err(_) => Err("Dictation is not available in this window.".to_string()),
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn stop_dictation(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || end_dictation(&app))
        .await
        .map_err(|_| "Dictation stopped.".to_string())
}

#[cfg(target_os = "macos")]
fn decide(app: &AppHandle) -> DictationAccess {
    let microphone = match av_authorization_label(microphone_status()) {
        "not-determined" => ask(app, schedule_microphone),
        label => label,
    };
    if microphone != "authorized" {
        return DictationAccess {
            microphone,
            speech: "unsupported",
        };
    }
    let speech = match speech_authorization_label(speech_status()) {
        "not-determined" => ask(app, schedule_speech),
        label => label,
    };
    DictationAccess { microphone, speech }
}

#[cfg(target_os = "macos")]
fn ask(app: &AppHandle, schedule: fn(Sender<&'static str>)) -> &'static str {
    let (tx, rx) = mpsc::channel();
    // Queue the sheet on the main thread, then wait here so that thread can
    // present it and run the completion.
    if app.run_on_main_thread(move || schedule(tx)).is_err() {
        return "denied";
    }
    rx.recv_timeout(PERMISSION_WAIT).unwrap_or("denied")
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    #[link_name = "OBJC_CLASS_$_AVCaptureDevice"]
    static AV_CAPTURE_DEVICE: objc2::runtime::AnyClass;
    #[allow(non_upper_case_globals)]
    static AVMediaTypeAudio: *const objc2_foundation::NSString;
}

#[cfg(target_os = "macos")]
#[link(name = "Speech", kind = "framework")]
unsafe extern "C" {
    #[link_name = "OBJC_CLASS_$_SFSpeechRecognizer"]
    static SF_SPEECH_RECOGNIZER: objc2::runtime::AnyClass;
    #[link_name = "OBJC_CLASS_$_SFSpeechAudioBufferRecognitionRequest"]
    static SF_SPEECH_REQUEST: objc2::runtime::AnyClass;
}

#[cfg(target_os = "macos")]
#[link(name = "AVFAudio", kind = "framework")]
unsafe extern "C" {
    #[link_name = "OBJC_CLASS_$_AVAudioEngine"]
    static AV_AUDIO_ENGINE: objc2::runtime::AnyClass;
}

#[cfg(target_os = "macos")]
fn capture_device() -> &'static objc2::runtime::AnyClass {
    unsafe { &*std::ptr::addr_of!(AV_CAPTURE_DEVICE) }
}

#[cfg(target_os = "macos")]
fn speech_recognizer_class() -> &'static objc2::runtime::AnyClass {
    unsafe { &*std::ptr::addr_of!(SF_SPEECH_RECOGNIZER) }
}

#[cfg(target_os = "macos")]
fn audio_media_type() -> &'static objc2_foundation::NSString {
    unsafe { &*AVMediaTypeAudio }
}

#[cfg(target_os = "macos")]
fn microphone_status() -> isize {
    use objc2::msg_send;
    unsafe { msg_send![capture_device(), authorizationStatusForMediaType: audio_media_type()] }
}

#[cfg(target_os = "macos")]
fn speech_status() -> isize {
    use objc2::msg_send;
    unsafe { msg_send![speech_recognizer_class(), authorizationStatus] }
}

#[cfg(target_os = "macos")]
fn schedule_microphone(tx: Sender<&'static str>) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::Bool;

    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(if granted.as_bool() {
            "authorized"
        } else {
            "denied"
        });
    });
    let _: () = unsafe {
        msg_send![
            capture_device(),
            requestAccessForMediaType: audio_media_type(),
            completionHandler: &*block
        ]
    };
}

#[cfg(target_os = "macos")]
fn schedule_speech(tx: Sender<&'static str>) {
    use block2::RcBlock;
    use objc2::msg_send;

    let block = RcBlock::new(move |status: isize| {
        let _ = tx.send(speech_label(status));
    });
    let _: () = unsafe { msg_send![speech_recognizer_class(), requestAuthorization: &*block] };
}

#[cfg(target_os = "macos")]
struct EngineSession {
    engine: objc2::rc::Retained<objc2::runtime::AnyObject>,
    request: objc2::rc::Retained<objc2::runtime::AnyObject>,
    task: objc2::rc::Retained<objc2::runtime::AnyObject>,
    /// Released only after the task is cancelled. Speech stops if this drops first.
    _recognizer: objc2::rc::Retained<objc2::runtime::AnyObject>,
    /// Kept for the recognizer's background result queue.
    _queue: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    input: *mut objc2::runtime::AnyObject,
    /// Tap and result blocks. Released only after the tap is removed.
    _blocks: Box<dyn std::any::Any>,
}

#[cfg(target_os = "macos")]
unsafe impl Send for EngineSession {}

#[cfg(target_os = "macos")]
impl Drop for EngineSession {
    fn drop(&mut self) {
        use objc2::msg_send;
        unsafe {
            if !self.input.is_null() {
                let _: () = msg_send![self.input, removeTapOnBus: 0usize];
            }
            let _: () = msg_send![&*self.engine, stop];
            let _: () = msg_send![&*self.request, endAudio];
            let _: () = msg_send![&*self.task, cancel];
        }
    }
}

#[cfg(target_os = "macos")]
fn session_slot() -> &'static Mutex<Option<EngineSession>> {
    static SESSION: Mutex<Option<EngineSession>> = Mutex::new(None);
    &SESSION
}

#[cfg(target_os = "macos")]
fn session_token() -> &'static AtomicU64 {
    static TOKEN: AtomicU64 = AtomicU64::new(0);
    &TOKEN
}

#[cfg(target_os = "macos")]
fn accept_results() -> &'static AtomicBool {
    static ACCEPT: AtomicBool = AtomicBool::new(false);
    &ACCEPT
}

#[cfg(target_os = "macos")]
fn run_on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    // This runs inline when already on the main thread, and is queued otherwise.
    // The caller is the blocking pool, so the main thread can run the engine.
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|_| "Dictation is not available in this window.".to_string())?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Dictation is not available in this window.".to_string())
}

#[cfg(target_os = "macos")]
fn take_session() -> Option<EngineSession> {
    session_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
}

#[cfg(target_os = "macos")]
fn drop_engine(app: &AppHandle, session: EngineSession) {
    // A failed hop drops the session on this thread. The mic must not stay open.
    let _ = run_on_main(app, move || drop(session));
}

#[cfg(target_os = "macos")]
fn end_dictation(app: &AppHandle) {
    accept_results().store(false, Ordering::SeqCst);
    session_token().fetch_add(1, Ordering::SeqCst);
    if let Some(session) = take_session() {
        drop_engine(app, session);
    }
}

#[cfg(target_os = "macos")]
fn begin_dictation(app: AppHandle) -> Result<(), String> {
    if let Some(message) = access_error(decide(&app)) {
        return Err(message.to_string());
    }
    let id = session_token().fetch_add(1, Ordering::SeqCst) + 1;
    accept_results().store(true, Ordering::SeqCst);
    if let Some(session) = take_session() {
        drop_engine(&app, session);
    }
    if session_token().load(Ordering::SeqCst) != id {
        accept_results().store(false, Ordering::SeqCst);
        return Ok(());
    }
    let built = run_on_main(&app, {
        let app = app.clone();
        move || build_session(&app, id)
    })?;
    let session = match built {
        Ok(session) => session,
        Err(error) => {
            accept_results().store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    if session_token().load(Ordering::SeqCst) != id {
        drop_engine(&app, session);
        return Ok(());
    }
    *session_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(session);
    Ok(())
}

#[cfg(target_os = "macos")]
fn owned_new(
    class: &objc2::runtime::AnyClass,
) -> Result<objc2::rc::Retained<objc2::runtime::AnyObject>, String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    let object: *mut AnyObject = unsafe { msg_send![class, new] };
    unsafe { Retained::from_raw(object) }
        .ok_or_else(|| "Dictation is not available in this window.".to_string())
}

/// Whether the offline dictation model for the recognizer's locale is
/// installed. Dictation prefers it but no longer requires it.
#[cfg(target_os = "macos")]
fn supports_on_device(recognizer: &objc2::runtime::AnyObject) -> bool {
    use objc2::msg_send;
    use objc2::runtime::Bool;

    let responds: Bool = unsafe {
        msg_send![recognizer, respondsToSelector: objc2::sel!(supportsOnDeviceRecognition)]
    };
    if !responds.as_bool() {
        return false;
    }
    let supported: Bool = unsafe { msg_send![recognizer, supportsOnDeviceRecognition] };
    supported.as_bool()
}

#[cfg(target_os = "macos")]
fn build_session(app: &AppHandle, id: u64) -> Result<EngineSession, String> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSError, NSString};

    let unavailable = "Dictation is not available in this window.";
    let recognizer = owned_new(speech_recognizer_class())?;
    let available: Bool = unsafe { msg_send![&*recognizer, isAvailable] };
    if !available.as_bool() {
        return Err(unavailable.to_string());
    }
    // Prefer on-device recognition; macOS falls back to Apple's dictation
    // service when the offline model for this locale is not installed.
    let on_device = supports_on_device(&recognizer);
    let mut queue = None;
    if let Some(queue_class) = AnyClass::get(c"NSOperationQueue") {
        if let Ok(speech_queue) = owned_new(queue_class) {
            let name = NSString::from_str("Gyro dictation");
            let _: () = unsafe { msg_send![&*speech_queue, setName: &*name] };
            let _: () = unsafe { msg_send![&*recognizer, setQueue: &*speech_queue] };
            queue = Some(speech_queue);
        }
    }

    let request_class = unsafe { &*std::ptr::addr_of!(SF_SPEECH_REQUEST) };
    let request = owned_new(request_class)?;
    let _: () = unsafe {
        msg_send![&*request, setShouldReportPartialResults: Bool::YES]
    };
    // Pin the request to on-device recognition only when the offline model is
    // installed; otherwise let Apple's dictation service transcribe the audio.
    let requires_on_device = if on_device { Bool::YES } else { Bool::NO };
    let _: () = unsafe {
        msg_send![&*request, setRequiresOnDeviceRecognition: requires_on_device]
    };

    let engine_class = unsafe { &*std::ptr::addr_of!(AV_AUDIO_ENGINE) };
    let engine = owned_new(engine_class)?;
    let input: *mut AnyObject = unsafe { msg_send![&*engine, inputNode] };
    if input.is_null() {
        return Err("No microphone is available.".to_string());
    }
    let format = match recording_format(&engine, input) {
        Some(format) => format,
        None => return Err("No microphone is available.".to_string()),
    };

    let request_ptr = Retained::as_ptr(&request) as usize;
    let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
        if buffer.is_null() || request_ptr == 0 {
            return;
        }
        let request = request_ptr as *mut AnyObject;
        let _: () = unsafe { msg_send![request, appendAudioPCMBuffer: buffer] };
    });
    let installed = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
        let _: () = msg_send![
            input,
            installTapOnBus: 0usize,
            bufferSize: 4096u32,
            format: &*format,
            block: &*tap
        ];
    }));
    if installed.is_err() {
        return Err("No microphone is available.".to_string());
    }

    let app_for_results = app.clone();
    let latest = Arc::new(Mutex::new(String::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let handler = {
        let latest = Arc::clone(&latest);
        let closed = Arc::clone(&closed);
        RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            if closed.load(Ordering::SeqCst)
                || !accept_results().load(Ordering::SeqCst)
                || session_token().load(Ordering::SeqCst) != id
            {
                return;
            }
            let mut text = String::new();
            let mut is_final = false;
            if !result.is_null() {
                text = transcription(result);
                let final_value: Bool = unsafe { msg_send![result, isFinal] };
                is_final = final_value.as_bool();
                if !text.is_empty() {
                    if let Ok(mut stored) = latest.lock() {
                        *stored = text.clone();
                    }
                }
            }
            if is_final {
                if closed.swap(true, Ordering::SeqCst) {
                    return;
                }
                emit_update(&app_for_results, "final", text);
                return;
            }
            if !text.is_empty() {
                emit_update(&app_for_results, "partial", text);
            }
            if error.is_null() {
                return;
            }
            let code = unsafe { &*error }.code();
            if matches!(code, 216 | 301) {
                return;
            }
            if closed.swap(true, Ordering::SeqCst) {
                return;
            }
            let spoken = latest.lock().map(|value| value.clone()).unwrap_or_default();
            if spoken.is_empty() {
                emit_update(&app_for_results, "error", speech_failure(code).to_string());
            } else {
                emit_update(&app_for_results, "final", spoken);
            }
        })
    };
    let task: *mut AnyObject = unsafe {
        msg_send![
            &*recognizer,
            recognitionTaskWithRequest: &*request,
            resultHandler: &*handler
        ]
    };
    let task = match unsafe { Retained::retain_autoreleased(task) } {
        Some(task) => task,
        None => {
            let _: () = unsafe { msg_send![input, removeTapOnBus: 0usize] };
            return Err(unavailable.to_string());
        }
    };

    let _: () = unsafe { msg_send![&*engine, prepare] };
    let mut start_error: *mut NSError = std::ptr::null_mut();
    let started = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
        let started: Bool = msg_send![&*engine, startAndReturnError: &mut start_error];
        started.as_bool()
    }));
    if !matches!(started, Ok(true)) {
        accept_results().store(false, Ordering::SeqCst);
        let _: () = unsafe { msg_send![input, removeTapOnBus: 0usize] };
        let _: () = unsafe { msg_send![&*task, cancel] };
        return Err("No microphone is available.".to_string());
    }

    Ok(EngineSession {
        engine,
        request,
        task,
        _recognizer: recognizer,
        _queue: queue,
        input,
        _blocks: Box::new((tap, handler)),
    })
}

/// macOS reports a 0 Hz output format until the input device has been touched.
#[cfg(target_os = "macos")]
fn recording_format(
    engine: &objc2::rc::Retained<objc2::runtime::AnyObject>,
    input: *mut objc2::runtime::AnyObject,
) -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2_foundation::NSError;

    let _ = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        let hardware: *mut AnyObject = unsafe { msg_send![input, inputFormatForBus: 0usize] };
        let _kept = unsafe { Retained::retain_autoreleased(hardware) };
    }));
    if let Some(format) = bus_output_format(input) {
        if format_is_usable(&format) {
            return Some(format);
        }
    }
    let primed = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
        let _: () = msg_send![&**engine, prepare];
        let mut start_error: *mut NSError = std::ptr::null_mut();
        let started: Bool = msg_send![&**engine, startAndReturnError: &mut start_error];
        started.as_bool()
    }));
    if matches!(primed, Ok(true)) {
        let _: () = unsafe { msg_send![&**engine, stop] };
    } else {
        // A thrown start can still leave the engine running.
        let _ = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            let _: () = msg_send![&**engine, stop];
        }));
    }
    bus_output_format(input).filter(|format| format_is_usable(format))
}

#[cfg(target_os = "macos")]
fn bus_output_format(
    input: *mut objc2::runtime::AnyObject,
) -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    let format: *mut AnyObject = unsafe { msg_send![input, outputFormatForBus: 0usize] };
    unsafe { Retained::retain_autoreleased(format) }
}

#[cfg(target_os = "macos")]
fn format_is_usable(format: &objc2::rc::Retained<objc2::runtime::AnyObject>) -> bool {
    use objc2::msg_send;
    let sample_rate: f64 = unsafe { msg_send![&**format, sampleRate] };
    let channels: u32 = unsafe { msg_send![&**format, channelCount] };
    sample_rate.is_finite() && sample_rate > 0.0 && channels > 0
}

#[cfg(target_os = "macos")]
fn transcription(result: *mut objc2::runtime::AnyObject) -> String {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    let best: *mut AnyObject = unsafe { msg_send![result, bestTranscription] };
    if best.is_null() {
        return String::new();
    }
    let text: *mut NSString = unsafe { msg_send![best, formattedString] };
    if text.is_null() {
        return String::new();
    }
    unsafe { &*text }.to_string()
}

#[cfg(target_os = "macos")]
fn emit_update(app: &AppHandle, kind: &'static str, text: String) {
    let _ = app.emit(
        DICTATION_EVENT,
        DictationUpdate { kind, text },
    );
}

#[cfg(test)]
mod tests {
    use super::{
        access_error, av_authorization_label, speech_authorization_label, speech_failure,
        speech_label, DictationAccess, NETWORK_NEEDED,
    };

    #[test]
    fn speech_statuses_match_the_system_sheet() {
        assert_eq!(speech_label(0), "denied");
        assert_eq!(speech_label(1), "denied");
        assert_eq!(speech_label(2), "restricted");
        assert_eq!(speech_label(3), "authorized");
        assert_eq!(speech_label(9), "denied");
    }

    #[test]
    fn authorization_statuses_keep_an_unasked_prompt() {
        assert_eq!(av_authorization_label(0), "not-determined");
        assert_eq!(av_authorization_label(1), "restricted");
        assert_eq!(av_authorization_label(2), "denied");
        assert_eq!(av_authorization_label(3), "authorized");
        assert_eq!(speech_authorization_label(0), "not-determined");
        assert_eq!(speech_authorization_label(1), "denied");
        assert_eq!(speech_authorization_label(2), "restricted");
        assert_eq!(speech_failure(1110), "No speech was heard.");
        assert_eq!(speech_failure(1101), NETWORK_NEEDED);
        assert_eq!(speech_failure(203), "Dictation stopped.");
    }

    #[test]
    fn access_errors_match_the_composer_copy() {
        assert_eq!(
            access_error(DictationAccess {
                microphone: "unsupported",
                speech: "unsupported",
            }),
            None
        );
        assert_eq!(
            access_error(DictationAccess {
                microphone: "authorized",
                speech: "authorized",
            }),
            None
        );
        assert_eq!(
            access_error(DictationAccess {
                microphone: "denied",
                speech: "unsupported",
            }),
            Some("Allow the microphone to dictate.")
        );
        assert_eq!(
            access_error(DictationAccess {
                microphone: "authorized",
                speech: "denied",
            }),
            Some("Allow Speech Recognition to dictate.")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dictation_frameworks_are_linked() {
        let microphone = std::ptr::addr_of!(super::AV_CAPTURE_DEVICE);
        let speech = std::ptr::addr_of!(super::SF_SPEECH_RECOGNIZER);
        let request = std::ptr::addr_of!(super::SF_SPEECH_REQUEST);
        let engine = std::ptr::addr_of!(super::AV_AUDIO_ENGINE);
        assert!(!microphone.is_null());
        assert!(!speech.is_null());
        assert!(!request.is_null());
        assert!(!engine.is_null());
        assert!(!unsafe { super::AVMediaTypeAudio }.is_null());
    }
}
