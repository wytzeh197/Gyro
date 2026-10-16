//! macOS permission sheets for composer dictation.
//!
//! The webview grants its own media-capture decision without a system sheet.
//! The first microphone click asks AVFoundation, then Speech, so macOS can
//! show “Gyro would like to access the microphone” and the Speech Recognition
//! sheet. A status that is already decided returns immediately.

use serde::Serialize;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;
use tauri::AppHandle;

/// How long the click waits while a system sheet is open.
const PERMISSION_WAIT: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DictationAccess {
    pub microphone: &'static str,
    pub speech: &'static str,
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: DictationAccess = DictationAccess {
    microphone: "unsupported",
    speech: "unsupported",
};

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn request_dictation_access(app: AppHandle) -> DictationAccess {
    let _ = app;
    UNSUPPORTED
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_dictation_access(app: AppHandle) -> DictationAccess {
    let microphone = ask(&app, schedule_microphone);
    if microphone != "authorized" {
        return DictationAccess {
            microphone,
            speech: "unsupported",
        };
    }
    DictationAccess {
        microphone,
        speech: ask(&app, schedule_speech),
    }
}

#[cfg(target_os = "macos")]
fn ask(app: &AppHandle, schedule: fn(Sender<&'static str>)) -> &'static str {
    let (tx, rx) = mpsc::channel();
    // The completion may be queued on the main thread. Schedule the request
    // there, then wait here so the main thread can present the sheet.
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
}

#[cfg(target_os = "macos")]
#[link(name = "Speech", kind = "framework")]
unsafe extern "C" {
    #[link_name = "OBJC_CLASS_$_SFSpeechRecognizer"]
    static SF_SPEECH_RECOGNIZER: objc2::runtime::AnyClass;
}

/// `AVMediaTypeAudio` is the four-character code `soun`.
#[cfg(target_os = "macos")]
fn schedule_microphone(tx: Sender<&'static str>) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::Bool;
    use objc2_foundation::NSString;

    let _ = std::ptr::addr_of!(SF_SPEECH_RECOGNIZER);
    let class = unsafe { &*std::ptr::addr_of!(AV_CAPTURE_DEVICE) };
    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(if granted.as_bool() {
            "authorized"
        } else {
            "denied"
        });
    });
    let media = NSString::from_str("soun");
    // The system copies the block before this call returns.
    let _: () = unsafe {
        msg_send![
            class,
            requestAccessForMediaType: &*media,
            completionHandler: &*block
        ]
    };
}

#[cfg(target_os = "macos")]
fn schedule_speech(tx: Sender<&'static str>) {
    use block2::RcBlock;
    use objc2::msg_send;

    let class = unsafe { &*std::ptr::addr_of!(SF_SPEECH_RECOGNIZER) };
    let block = RcBlock::new(move |status: isize| {
        let _ = tx.send(speech_label(status));
    });
    let _: () = unsafe { msg_send![class, requestAuthorization: &*block] };
}

/// Apple's `SFSpeechRecognizerAuthorizationStatus`: 2 restricted, 3 authorized.
/// Anything else, including not-determined, is not a grant.
fn speech_label(status: isize) -> &'static str {
    match status {
        3 => "authorized",
        2 => "restricted",
        _ => "denied",
    }
}

#[cfg(test)]
mod tests {
    use super::speech_label;

    #[test]
    fn speech_statuses_match_the_system_sheet() {
        assert_eq!(speech_label(0), "denied");
        assert_eq!(speech_label(1), "denied");
        assert_eq!(speech_label(2), "restricted");
        assert_eq!(speech_label(3), "authorized");
        assert_eq!(speech_label(9), "denied");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dictation_frameworks_are_linked() {
        let microphone = std::ptr::addr_of!(super::AV_CAPTURE_DEVICE);
        let speech = std::ptr::addr_of!(super::SF_SPEECH_RECOGNIZER);
        assert!(!microphone.is_null());
        assert!(!speech.is_null());
    }
}
