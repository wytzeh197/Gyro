//! macOS window observations using public CoreGraphics/AppKit APIs.
#![allow(deprecated)] // CoreGraphics remains the no-dependency capture path on supported macOS.
use super::{Frame, Target};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compositor_preserves_pixels_and_coordinate_origin() {
        let bitmap=unsafe{
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),std::ptr::null_mut(),64,40,8,4,true,false,
                &NSString::from_str("NSDeviceRGBColorSpace"),0,0)
        }.unwrap();
        let row = bitmap.bytesPerRow() as usize;
        let pixels = unsafe { std::slice::from_raw_parts_mut(bitmap.bitmapData(), row * 40) };
        for y in 0..40 {
            for x in 0..64 {
                let rgba = if y < 20 {
                    [220, 10, 20, 255]
                } else {
                    [10, 200, 30, 255]
                };
                pixels[y * row + x * 4..y * row + x * 4 + 4].copy_from_slice(&rgba);
            }
        }
        for phone in [false, true] {
            let (png, rect) = frame(&encode(&bitmap).unwrap(), 64, 40, phone).unwrap();
            let output = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png)).unwrap();
            assert_eq!(output.pixelsWide(), rect.image_width as isize);
            assert_eq!(output.pixelsHigh(), rect.image_height as isize);
            let stride = output.bytesPerRow() as usize;
            let bytes = unsafe {
                std::slice::from_raw_parts(output.bitmapData(), stride * rect.image_height as usize)
            };
            let top = (rect.y as usize + 2) * stride + (rect.x as usize + 2) * 4;
            let bottom = (rect.y as usize + 30) * stride + (rect.x as usize + 2) * 4;
            assert_eq!(&bytes[top..top + 3], &[220, 10, 20]);
            assert_eq!(&bytes[bottom..bottom + 3], &[10, 200, 30]);
        }
    }
    #[test]
    #[ignore = "requires the explicit native acceptance window and macOS permissions"]
    fn native_window_acceptance() {
        let dir = std::path::PathBuf::from(
            std::env::var("GYRO_PREVIEW_NATIVE_DIR").expect("acceptance output directory"),
        );
        let target = windows()
            .expect("Screen Recording prerequisite")
            .into_iter()
            .find(|w| w.title.ends_with("Gyro Preview Acceptance"))
            .expect("native fixture window");
        let (png, w, h) = capture(&target).expect("capture real window");
        let (framed, rect) = frame(&png, w, h, false).expect("frame real window");
        std::fs::write(dir.join("macos-before.png"), framed).unwrap();
        println!(
            "Native window: {} · image {}x{} · content origin {},{}",
            target.id, rect.image_width, rect.image_height, rect.x, rect.y
        );
        let clicked = click(&target, 180., target.height - 182.);
        if let Err(error) = clicked {
            std::fs::write(
                dir.join("native-result.txt"),
                format!("Native capture passed; native input blocked: {error}"),
            )
            .unwrap();
            panic!("{error}");
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < until {
            if std::fs::read_to_string(dir.join("count.txt"))
                .ok()
                .as_deref()
                == Some("1")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(
            std::fs::read_to_string(dir.join("count.txt")).unwrap(),
            "1",
            "native button must change real state"
        );
        let (png, w, h) = capture(&target).unwrap();
        std::fs::write(
            dir.join("macos-after.png"),
            frame(&png, w, h, false).unwrap().0,
        )
        .unwrap();
        std::fs::write(dir.join("native-result.txt"),"Native capture, mapped click, and observed state change passed. Module harness; not installed-app IPC acceptance.").unwrap();
    }
}
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSGraphicsContext,
    NSImage,
};
use objc2_core_graphics::{
    CGEvent, CGEventType, CGMouseButton, CGPreflightScreenCaptureAccess, CGWindowImageOption,
    CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGWindowListOption,
};
use objc2_foundation::{
    NSArray, NSData, NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString,
};
use std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> *const c_void;
    fn AXUIElementCopyElementAtPosition(
        element: *const c_void,
        x: f32,
        y: f32,
        result: *mut *const c_void,
    ) -> i32;
    fn AXUIElementCopyAttributeValue(
        element: *const c_void,
        name: *const c_void,
        result: *mut *const c_void,
    ) -> i32;
    fn AXUIElementGetPid(element: *const c_void, pid: *mut i32) -> i32;
    fn CFRelease(value: *const c_void);
}
pub fn windows() -> Result<Vec<Target>, String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err("macOS windows require Screen Recording permission for Gyro. Grant it in System Settings, then refresh.".into());
    }
    let list = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    )
    .ok_or("Window enumeration unavailable")?;
    // CFArray and CFDictionary returned by CoreGraphics are toll-free bridged.
    let array: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(std::ptr::from_ref(&*list).cast()) };
    let mut result = Vec::new();
    for row in array {
        let number = |key: &str| -> f64 {
            row.objectForKey(&NSString::from_str(key))
                .map(|v| unsafe {
                    let n: &NSNumber = &*(&*v as *const AnyObject).cast();
                    n.doubleValue()
                })
                .unwrap_or(0.)
        };
        let string = |key: &str| -> String {
            row.objectForKey(&NSString::from_str(key))
                .map(|v| unsafe {
                    let s: &NSString = &*(&*v as *const AnyObject).cast();
                    s.to_string()
                })
                .unwrap_or_default()
        };
        if number("kCGWindowLayer") != 0. || number("kCGWindowAlpha") == 0. {
            continue;
        }
        let pid = number("kCGWindowOwnerPID") as i32;
        // Never capture Gyro itself recursively or list unnamed/background surfaces.
        if pid == std::process::id() as i32 {
            continue;
        }
        let title = string("kCGWindowName");
        let owner = string("kCGWindowOwnerName");
        if title.is_empty() {
            continue;
        }
        let Some(bounds) = row.objectForKey(&NSString::from_str("kCGWindowBounds")) else {
            continue;
        };
        let bounds: &NSDictionary<NSString, NSNumber> =
            unsafe { &*(&*bounds as *const AnyObject).cast() };
        let dim = |k: &str| {
            bounds
                .objectForKey(&NSString::from_str(k))
                .map(|n| n.doubleValue())
                .unwrap_or(0.)
        };
        let b = [dim("X"), dim("Y"), dim("Width"), dim("Height")];
        if b[2] < 40. || b[3] < 40. || !b.iter().all(|n| n.is_finite()) {
            continue;
        }
        let id = number("kCGWindowNumber") as u32;
        result.push(Target {
            id: format!("macos:{pid}:{id}"),
            kind: "macos".into(),
            title: format!("{owner} — {title}"),
            width: b[2],
            height: b[3],
            window_id: Some(id),
            pid: Some(pid),
            bounds: Some(b),
        });
    }
    Ok(result)
}
fn encode(bitmap: &NSBitmapImageRep) -> Result<Vec<u8>, String> {
    let props = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
        .map(|v| v.to_vec())
        .ok_or("Could not encode preview PNG".into())
}
pub fn png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    let data = NSData::with_bytes(png);
    let bitmap = NSBitmapImageRep::imageRepWithData(&data).ok_or("Invalid runtime PNG")?;
    let (w, h) = (bitmap.pixelsWide(), bitmap.pixelsHigh());
    if w <= 0 || h <= 0 || w > 10000 || h > 10000 {
        return Err("Invalid runtime image dimensions".into());
    }
    Ok((w as u32, h as u32))
}
#[allow(deprecated)]
pub fn capture(target: &Target) -> Result<(Vec<u8>, u32, u32), String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err("Screen Recording permission is unavailable".into());
    }
    let image = CGWindowListCreateImage(
        unsafe { objc2_core_graphics::CGRectNull },
        CGWindowListOption::OptionIncludingWindow,
        target.window_id.ok_or("Window ID missing")?,
        CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution,
    )
    .ok_or("Window capture failed; check Screen Recording permission and keep the window open")?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    let (w, h) = (bitmap.pixelsWide() as u32, bitmap.pixelsHigh() as u32);
    Ok((encode(&bitmap)?, w, h))
}
pub fn frame(png: &[u8], width: u32, height: u32, phone: bool) -> Result<(Vec<u8>, Frame), String> {
    if width == 0 || height == 0 || width > 10000 || height > 10000 {
        return Err("Capture dimensions out of range".into());
    }
    let bezel = if phone { 18u32 } else { 2 };
    let chrome = if phone { 30u32 } else { 32 };
    let outer_w = width + 2 * bezel;
    let outer_h = height + 2 * bezel + chrome;
    let bitmap=unsafe{
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),std::ptr::null_mut(),outer_w as isize,outer_h as isize,8,4,true,false,
            &NSString::from_str("NSDeviceRGBColorSpace"),0,0)
    }.ok_or("Could not allocate frame bitmap")?;
    let row = bitmap.bytesPerRow() as usize;
    let pixels =
        unsafe { std::slice::from_raw_parts_mut(bitmap.bitmapData(), row * outer_h as usize) };
    for y in 0..outer_h as usize {
        for x in 0..outer_w as usize {
            let p = y * row + x * 4;
            pixels[p..p + 4].copy_from_slice(if phone {
                &[35, 35, 38, 255]
            } else {
                &[232, 232, 234, 255]
            });
        }
    }
    // Speaker / window controls are decoration, excluded by contentRect.
    for y in 10..18usize.min(outer_h as usize) {
        for x in if phone {
            (outer_w as usize / 2).saturating_sub(24)
                ..(outer_w as usize / 2 + 24).min(outer_w as usize)
        } else {
            12..52usize.min(outer_w as usize)
        } {
            let p = y * row + x * 4;
            pixels[p..p + 4].copy_from_slice(&[130, 130, 134, 255]);
        }
    }
    let data = NSData::with_bytes(png);
    let source =
        NSImage::initWithData(NSImage::alloc(), &data).ok_or("Could not decode runtime capture")?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
        .ok_or("Could not compose frame")?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    source.drawInRect(NSRect::new(
        NSPoint::new(bezel as f64, bezel as f64),
        NSSize::new(width as f64, height as f64),
    ));
    NSGraphicsContext::restoreGraphicsState_class();
    Ok((
        encode(&bitmap)?,
        Frame {
            x: bezel as f64,
            y: (bezel + chrome) as f64,
            width: width as f64,
            height: height as f64,
            image_width: outer_w,
            image_height: outer_h,
        },
    ))
}
/// Check the actual AX hit target before posting. Never guess at obscured windows,
/// protected controls, or processes which do not expose an accessibility tree.
pub fn click(target: &Target, x: f64, y: f64) -> Result<(), String> {
    let bounds = target.bounds.ok_or("Window bounds missing")?;
    let pid = target.pid.ok_or("Window process missing")?;
    let (gx, gy) = (bounds[0] + x, bounds[1] + y);
    // Enumeration is front-to-back. Do not send to a different window of the
    // same process just because AX reports the same PID.
    let front = windows()?.into_iter().find(|w| {
        w.bounds
            .is_some_and(|b| gx >= b[0] && gy >= b[1] && gx < b[0] + b[2] && gy < b[1] + b[3])
    });
    if front.as_ref().map(|w| w.id.as_str()) != Some(target.id.as_str()) {
        return Err("Selected window is obscured; bring it forward and capture again".into());
    }
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("Native input requires Accessibility permission for Gyro".into());
        }
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return Err("Accessibility unavailable".into());
        }
        let mut element = std::ptr::null();
        let code = AXUIElementCopyElementAtPosition(system, gx as f32, gy as f32, &mut element);
        CFRelease(system);
        if code != 0 || element.is_null() {
            return Err("Cannot verify native input target; interact in the app".into());
        }
        let mut actual_pid = 0;
        let ok = AXUIElementGetPid(element, &mut actual_pid) == 0 && actual_pid == pid;
        let mut protected = false;
        for key in ["AXRole", "AXSubrole"] {
            let name = NSString::from_str(key);
            let mut value = std::ptr::null();
            if AXUIElementCopyAttributeValue(
                element,
                (&*name as *const NSString).cast(),
                &mut value,
            ) == 0
                && !value.is_null()
            {
                let value_string: &NSString = &*value.cast();
                let role = value_string.to_string().to_lowercase();
                protected |= role.contains("secure")
                    || role.contains("textfield")
                    || role.contains("textarea");
                CFRelease(value);
            } else if key == "AXRole" {
                protected = true;
            }
        }
        CFRelease(element);
        if !ok {
            return Err("Selected window is obscured or not the input target; bring it forward and capture again".into());
        }
        if protected {
            return Err("Native text or protected controls require user interaction".into());
        }
    }
    let point = NSPoint::new(gx, gy);
    for event_type in [CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
        let event = CGEvent::new_mouse_event(None, event_type, point, CGMouseButton::Left)
            .ok_or("Could not create native input")?;
        CGEvent::set_integer_value_field(
            Some(&event),
            objc2_core_graphics::CGEventField::MouseEventClickState,
            1,
        );
        for field in [objc2_core_graphics::CGEventField::MouseEventWindowUnderMousePointer,
            objc2_core_graphics::CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent] {
            CGEvent::set_integer_value_field(Some(&event),field,i64::from(target.window_id.ok_or("Window ID missing")?));
        }
        CGEvent::post_to_pid(pid, Some(&event));
    }
    Ok(())
}
