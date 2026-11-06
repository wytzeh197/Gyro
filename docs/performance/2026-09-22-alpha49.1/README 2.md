# Alpha 49.1 local preflight

Measured on 2026-09-22 against the Alpha 49.1 candidate based on 58bfa39,
with version metadata and rustfmt-only stabilization changes.

Automated checks passed: frozen dependency install, development environment
check, release configuration, TypeScript, JavaScript reliability suite,
workbench smoke, download-site checks, production frontend build, Rust format,
803 Rust tests (4 ignored), CLI build, reproducible CLI packaging and corrupt
archive rejection, and isolated CLI doctor (`gyro.cli.v1`).

## Local performance smoke

The production Vite configuration compiled the capture and chat layout fixtures
into a separate ignored output directory. A build-only transform enabled the
chat fixture's development entry guard; shipped sources and the desktop bundle
were unchanged. A fresh headless Brave profile loaded local static assets at
1440 × 900. Five new pages loaded the active-chat capture scene, then exercised
Split right, Split down, Long transcript, Completed answer, Close focused and
Reset. Timing runs completed without JavaScript runtime exceptions.

| Measurement | Samples | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Navigation to app shell ready | 5 | 92 ms | 140 ms | 140 ms |
| Control click to second animation frame | 30 | 32 ms | 33 ms | 34 ms |
| Debug CLI `--version` process | 20 | 4 ms | 26 ms | 26 ms |

[Raw samples](results.json) include the first cold process/page. Shell readiness
was sampled every 25 ms, so startup includes polling overhead. Two animation
frames are an approximation of paint opportunity, not an instrumented screen
presentation timestamp. The native bridge is synthetic and the browser is
Chromium, not the macOS WebKit runtime. These are local smoke measurements, not
a before/after speedup claim or a live-provider latency benchmark.

The actual production frontend build passed in 22 seconds. Vite reports large
chunks: Monaco editor 3.33 MB raw / 857 KB gzip and shared UI surfaces 729 KB raw /
205 KB gzip. The local measurements did not show a responsiveness failure, but
these sizes remain a future optimization opportunity.

Native Gatekeeper, signed updater, both architecture artifacts, and generated
Homebrew Formula acceptance must use the actual release workflow outputs.
This report does not substitute for that acceptance.
