#!/usr/bin/env swift

// Renders apps/desktop/src-tauri/dmg/background.png: the white install-window
// poster behind the two Finder icons.
//
//   swift scripts/render-dmg-background.swift
//
// The PNG is committed rather than built: the artwork is a fixed asset, and the
// release job should not need a renderer to ship a DMG. This script exists so
// that asset is reproducible instead of a mystery binary.
//
// Geometry mirrors bundle.macOS.dmg in apps/desktop/src-tauri/tauri.conf.json:
// a 660 x 400 pt window, rendered at 2x (1320 x 800 px). Finder draws the two
// icon names itself in the band y 256-292, so nothing lives there. There is no
// version string either — a static PNG would go stale in a week; the minimum
// macOS version will not.

import AppKit
import Foundation

let windowSize = CGSize(width: 660, height: 400)
let scale: CGFloat = 2

let root = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
let outputURL = root.appendingPathComponent("apps/desktop/src-tauri/dmg/background.png")

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("render-dmg-background: \(message)\n".utf8))
  exit(1)
}

func ink(_ white: CGFloat, _ alpha: CGFloat) -> NSColor {
  NSColor(srgbRed: white, green: white, blue: white, alpha: alpha)
}

let paper = NSColor(srgbRed: 247 / 255, green: 247 / 255, blue: 245 / 255, alpha: 1)
let arrowInk = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.26)
let hairInk = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.15)
let microInk = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.55)
let captionInk = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.45)

let pixelWidth = Int(windowSize.width * scale)
let pixelHeight = Int(windowSize.height * scale)

guard
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixelWidth,
    pixelsHigh: pixelHeight,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )
else { fail("could not allocate a \(pixelWidth)x\(pixelHeight) bitmap") }

// Points in, pixels out: every coordinate below is written in the same numbers
// a designer would type into a 660 x 400 artboard.
bitmap.size = windowSize

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fail("could not open a drawing context")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
context.shouldAntialias = true

/// AppKit draws from the bottom left; the artwork is easier to reason about
/// from the top left, so every y is folded through here exactly once.
func flip(_ top: CGFloat) -> CGFloat { windowSize.height - top }

paper.setFill()
NSRect(origin: .zero, size: windowSize).fill()

// The only mark between the two icons: drag Gyro onto Applications. Sits on the
// icon midline (y 190) and stops short of both labels' columns.
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 288, y: flip(190)))
arrow.line(to: NSPoint(x: 363, y: flip(190)))
arrow.move(to: NSPoint(x: 355.5, y: flip(183.5)))
arrow.line(to: NSPoint(x: 363, y: flip(190)))
arrow.line(to: NSPoint(x: 355.5, y: flip(196.5)))
arrow.lineWidth = 1.25
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrowInk.setStroke()
arrow.stroke()

// The one hairline: the whole poster above it, two captions below it.
hairInk.setFill()
NSRect(x: 40, y: flip(329), width: windowSize.width - 80, height: 1).fill()

func draw(
  _ text: String,
  font: NSFont,
  kern: CGFloat,
  color: NSColor,
  baselineFromTop: CGFloat,
  left: CGFloat? = nil,
  right: CGFloat? = nil
) {
  let attributed = NSAttributedString(
    string: text,
    attributes: [.font: font, .foregroundColor: color, .kern: kern]
  )
  let width = attributed.size().width
  let x = right.map { $0 - width } ?? (left ?? 0)
  // draw(at:) positions the box, not the baseline; descender is negative.
  attributed.draw(at: NSPoint(x: x, y: flip(baselineFromTop) + font.descender))
}

draw(
  "GYRO",
  font: NSFont.systemFont(ofSize: 10, weight: .semibold),
  kern: 3.4,
  color: microInk,
  baselineFromTop: 347,
  left: 40
)
draw(
  "macOS 14+",
  font: NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular),
  kern: 0.95,
  color: captionInk,
  baselineFromTop: 347,
  right: windowSize.width - 40
)

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fail("could not encode PNG")
}
try png.write(to: outputURL, options: .atomic)

let width = bitmap.pixelsWide
let height = bitmap.pixelsHigh
guard width == 1320, height == 800 else {
  fail("rendered \(width)x\(height); the DMG window is 660x400 pt, so this must be 1320x800")
}

print("Rendered \(outputURL.path)")
print("\(width)x\(height) png · \(png.count) bytes")
