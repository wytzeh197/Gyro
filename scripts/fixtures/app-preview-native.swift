// Native acceptance fixture only. Never packaged with Gyro.
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let output = CommandLine.arguments.dropFirst().first
class Counter: NSObject {
    let label = NSTextField(labelWithString: "Count: 0")
    var count = 0
    @objc func increment(_ sender: Any?) {
        count += 1
        label.stringValue = "Count: \(count)"
        if let output = output { try? String(count).write(toFile: output, atomically: true, encoding: .utf8) }
    }
}
let counter = Counter()
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 400),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Gyro Preview Acceptance"
window.isReleasedWhenClosed = false
let title = NSTextField(labelWithString: "Real macOS window")
title.font = .systemFont(ofSize: 25, weight: .semibold)
title.frame = NSRect(x: 60, y: 295, width: 470, height: 40)
window.contentView!.addSubview(title)
let detail = NSTextField(labelWithString: "App Preview native acceptance fixture")
detail.frame = NSRect(x: 60, y: 260, width: 470, height: 25)
window.contentView!.addSubview(detail)
counter.label.font = .monospacedDigitSystemFont(ofSize: 20, weight: .regular)
counter.label.frame = NSRect(x: 60, y: 220, width: 300, height: 30)
window.contentView!.addSubview(counter.label)
let button = NSButton(title: "Increase count", target: counter, action: #selector(Counter.increment(_:)))
button.frame = NSRect(x: 60, y: 160, width: 240, height: 44)
button.bezelStyle = .rounded
window.contentView!.addSubview(button)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
