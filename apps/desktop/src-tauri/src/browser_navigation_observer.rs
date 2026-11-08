//! Main-frame provisional-load observation while preserving Wry's delegate.
//! WKWebView's delegate is weak. Its associated observer retains the original
//! delegate and is explicitly detached before closing the browser webview.
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, ProtocolObject, Sel},
    DeclaredClass, MainThreadOnly,
};
use objc2_foundation::{MainThreadMarker, NSError, NSObjectProtocol};
use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView};

static ASSOCIATION_KEY: u8 = 0;
#[cfg(debug_assertions)]
static INSTALLED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(debug_assertions)]
static DETACHED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(debug_assertions)]
static DROPPED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(debug_assertions)]
static FORWARDED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct ObserverIvars {
    original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
    event: Box<dyn Fn(&WKWebView, usize, NavigationEvent) -> bool>,
}

pub(super) enum NavigationEvent {
    Started,
    Committed,
    Finished,
    Failed {
        cancelled: bool,
        code: isize,
        provisional: bool,
    },
}

fn token(navigation: Option<&WKNavigation>) -> usize {
    navigation.map_or(0, |navigation| navigation as *const WKNavigation as usize)
}
impl Drop for ObserverIvars {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ObserverIvars]
    struct GyroBrowserNavigationObserver;

    unsafe impl NSObjectProtocol for GyroBrowserNavigationObserver {}

    impl GyroBrowserNavigationObserver {
        #[unsafe(method(respondsToSelector:))]
        fn responds(&self, selector: Sel) -> bool {
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || self.ivars().original.respondsToSelector(selector)
        }

        #[unsafe(method_id(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> Retained<AnyObject> {
            #[cfg(debug_assertions)]
            FORWARDED.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
            // The retained WKNavigationDelegate is an Objective-C object.
            unsafe { Retained::cast_unchecked(self.ivars().original.clone()) }
        }
    }

    unsafe impl WKNavigationDelegate for GyroBrowserNavigationObserver {
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
            (self.ivars().event)(webview,token(navigation),NavigationEvent::Started);
            let original = &self.ivars().original;
            if original.respondsToSelector(objc2::sel!(webView:didStartProvisionalNavigation:)) {
                unsafe { original.webView_didStartProvisionalNavigation(webview,navigation); }
            }
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
            if !(self.ivars().event)(webview,token(navigation),NavigationEvent::Committed) {return;}
            unsafe { self.ivars().original.webView_didCommitNavigation(webview,navigation); }
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, webview: &WKWebView, navigation: Option<&WKNavigation>) {
            if !(self.ivars().event)(webview,token(navigation),NavigationEvent::Finished) {return;}
            unsafe { self.ivars().original.webView_didFinishNavigation(webview,navigation); }
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, webview: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
            (self.ivars().event)(webview,token(navigation),NavigationEvent::Failed {
                cancelled:error.domain().to_string()=="NSURLErrorDomain" && error.code()==-999,
                code:error.code(), provisional:true,
            });
            let original=&self.ivars().original;
            if original.respondsToSelector(objc2::sel!(webView:didFailProvisionalNavigation:withError:)) {
                unsafe { original.webView_didFailProvisionalNavigation_withError(webview,navigation,error); }
            }
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, webview: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
            (self.ivars().event)(webview,token(navigation),NavigationEvent::Failed {
                cancelled:error.domain().to_string()=="NSURLErrorDomain" && error.code()==-999,
                code:error.code(), provisional:false,
            });
            let original=&self.ivars().original;
            if original.respondsToSelector(objc2::sel!(webView:didFailNavigation:withError:)) {
                unsafe { original.webView_didFailNavigation_withError(webview,navigation,error); }
            }
        }
    }
);

/// Must be called on WebKit's main thread for this live WKWebView.
pub(super) unsafe fn attach(
    view: &WKWebView,
    event: Box<dyn Fn(&WKWebView, usize, NavigationEvent) -> bool>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("navigation observer left the main thread")?;
    let key = (&ASSOCIATION_KEY as *const u8).cast();
    let object = (view as *const WKWebView).cast::<AnyObject>();
    if !objc2::ffi::objc_getAssociatedObject(object, key).is_null() {
        return Ok(());
    }
    let original = view
        .navigationDelegate()
        .ok_or("browser navigation delegate is unavailable")?;
    let observer = mtm
        .alloc::<GyroBrowserNavigationObserver>()
        .set_ivars(ObserverIvars { original, event });
    let observer: Retained<GyroBrowserNavigationObserver> = msg_send![super(observer), init];
    objc2::ffi::objc_setAssociatedObject(
        object.cast_mut(),
        key,
        Retained::as_ptr(&observer).cast_mut().cast(),
        objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
    );
    view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*observer)));
    #[cfg(debug_assertions)]
    INSTALLED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Restore the delegate and release the association before Wry closes its view.
pub(super) unsafe fn detach(view: &WKWebView) {
    let key = (&ASSOCIATION_KEY as *const u8).cast();
    let object = (view as *const WKWebView).cast::<AnyObject>();
    let retained = objc2::ffi::objc_getAssociatedObject(object, key);
    if retained.is_null() {
        return;
    }
    let observer = &*retained.cast::<GyroBrowserNavigationObserver>();
    let original = observer.ivars().original.clone();
    if view
        .navigationDelegate()
        .is_some_and(|current| Retained::as_ptr(&current).cast::<AnyObject>() == retained)
    {
        view.setNavigationDelegate(Some(&original));
    }
    objc2::ffi::objc_setAssociatedObject(
        object.cast_mut(),
        key,
        std::ptr::null_mut(),
        objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
    );
    #[cfg(debug_assertions)]
    DETACHED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
pub(super) fn counts() -> serde_json::Value {
    use std::sync::atomic::Ordering::Relaxed;
    serde_json::json!({"installed":INSTALLED.load(Relaxed),"detached":DETACHED.load(Relaxed),"dropped":DROPPED.load(Relaxed),"forwardedCallbacks":FORWARDED.load(Relaxed)})
}
