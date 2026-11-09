//! Scale a native container while WebKit keeps an integer CSS-sized frame.
use super::BrowserViewportGeometry;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::NSObjectProtocol, ClassType, DeclaredClass,
    MainThreadOnly,
};
use objc2_app_kit::{NSApplication, NSEventType, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use objc2_web_kit::WKWebView;
use std::cell::{Cell, RefCell};

#[cfg(debug_assertions)]
static INSTALLED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(debug_assertions)]
static DETACHED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(debug_assertions)]
static DROPPED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct ContainerIvars {
    interaction: RefCell<Option<Box<dyn Fn()>>>,
    last_mouse_event: Cell<Option<(isize, u64)>>,
}
impl Drop for ContainerIvars {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind=MainThreadOnly]
    #[ivars=ContainerIvars]
    struct GyroBrowserViewportContainer;

    unsafe impl NSObjectProtocol for GyroBrowserViewportContainer {}

    impl GyroBrowserViewportContainer {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self,point:NSPoint)->Option<Retained<NSView>> {
            let hit:Option<Retained<NSView>>=unsafe {msg_send![super(self),hitTest:point]};
            // The hidden page must not leave an empty native hit target over
            // React's capture/error controls or an occluding dialog.
            let hit=hit.filter(|hit| Retained::as_ptr(hit).cast::<()>() != (self as *const Self).cast());
            if let Some(mtm)=MainThreadMarker::new() {
            if hit.is_some() {
                if let Some(event)=NSApplication::sharedApplication(mtm).currentEvent() {
                    let token=(event.eventNumber(),event.timestamp().to_bits());
                    let mouse_down=matches!(event.r#type(),NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown);
                    let location=self.convertPoint_fromView(event.locationInWindow(),None);
                    let bounds=self.bounds();
                    let inside=location.x>=bounds.origin.x && location.y>=bounds.origin.y && location.x<bounds.origin.x+bounds.size.width && location.y<bounds.origin.y+bounds.size.height;
                    let same_window=self.window().is_some_and(|window|window.windowNumber()==event.windowNumber());
                    if mouse_down && inside && same_window && self.ivars().last_mouse_event.get()!=Some(token) {
                        self.ivars().last_mouse_event.set(Some(token));
                        if let Some(interaction)=self.ivars().interaction.borrow().as_ref() { interaction(); }
                    }
                }
            }
            }
            hit
        }
    }
);

/// Called on the main thread, after the browser resource/cancellation check.
pub(super) unsafe fn apply(
    view: &WKWebView,
    geometry: &BrowserViewportGeometry,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("browser viewport left the main thread")?;
    let auto_inset = objc2::sel!(_setAutomaticallyAdjustsContentInsets:);
    let top_inset = objc2::sel!(_setTopContentInset:);
    if !view.respondsToSelector(auto_inset) || !view.respondsToSelector(top_inset) {
        return Err("this WebKit version cannot preserve the browser viewport inset".into());
    }
    let current = view
        .superview()
        .ok_or("browser viewport has no native parent")?;
    let container: Retained<NSView> =
        if current.isKindOfClass(GyroBrowserViewportContainer::class()) {
            current
        } else {
            let allocated = mtm
                .alloc::<GyroBrowserViewportContainer>()
                .set_ivars(ContainerIvars {
                    interaction: RefCell::new(None),
                    last_mouse_event: Cell::new(None),
                });
            let container: Retained<GyroBrowserViewportContainer> =
                msg_send![super(allocated),initWithFrame:NSRect::ZERO];
            // Preserve Wry's top anchoring while the window is being resized.
            container.setAutoresizingMask(view.autoresizingMask());
            view.removeFromSuperview();
            current.addSubview(&container);
            container.addSubview(view);
            #[cfg(debug_assertions)]
            INSTALLED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Retained::into_super(container)
        };
    let parent = container
        .superview()
        .ok_or("browser viewport container has no parent")?;
    let bounds = parent.bounds();
    let frame = &geometry.frame;
    let y = if parent.isFlipped() {
        bounds.origin.y + frame.y
    } else {
        bounds.origin.y + bounds.size.height - frame.y - frame.height
    };
    container.setFrame(NSRect::new(
        NSPoint::new(bounds.origin.x + frame.x, y),
        NSSize::new(frame.width, frame.height),
    ));
    let viewport = NSSize::new(geometry.state.width, geometry.state.height);
    container.setBounds(NSRect::new(NSPoint::ZERO, viewport));
    view.setFrame(NSRect::new(NSPoint::ZERO, viewport));
    view.setBounds(NSRect::new(NSPoint::ZERO, viewport));
    view.setPageZoom(1.0);
    // WKWebView computes its own titlebar inset, independently of NSView's
    // additionalSafeAreaInsets. These selectors are checked before use.
    let _: () = msg_send![view,_setAutomaticallyAdjustsContentInsets:objc2::runtime::Bool::NO];
    let _: () = msg_send![view,_setTopContentInset:0.0_f64];
    container.layoutSubtreeIfNeeded();
    Ok(())
}

pub(super) unsafe fn on_interaction(view: &WKWebView, callback: Box<dyn Fn()>) {
    if let Some(parent) = view.superview() {
        if let Some(container) = parent.downcast_ref::<GyroBrowserViewportContainer>() {
            *container.ivars().interaction.borrow_mut() = Some(callback);
        }
    }
}

pub(crate) unsafe fn detach(view: &WKWebView) {
    if let Some(parent) = view
        .superview()
        .filter(|parent| parent.isKindOfClass(GyroBrowserViewportContainer::class()))
    {
        parent.removeFromSuperview();
        #[cfg(debug_assertions)]
        DETACHED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(all(debug_assertions, feature = "native-browser-events-smoke"))]
pub(crate) fn counts() -> serde_json::Value {
    use std::sync::atomic::Ordering::Relaxed;
    serde_json::json!({"installed":INSTALLED.load(Relaxed),"detached":DETACHED.load(Relaxed),"dropped":DROPPED.load(Relaxed)})
}
