# Gyro Code Mode helper notices

The standalone helper contains @opencode/codemode 2.0.27, Effect 4.0.1, and Acorn 8.15.0.
The worker is compiled using Bun 1.4.3. Gyro's desktop process communicates with it through IPC.

## MIT-licensed JavaScript dependencies

- @opencode/codemode: Copyright (c) 2025 opencode. Source: https://github.com/anomalyco/opencode/tree/dev/packages/codemode
- Effect: Copyright (c) 2023 Effectful Technologies Inc. Source: https://github.com/Effect-TS/effect
- Acorn: Copyright (C) 2012-2022 by various contributors (see https://github.com/acornjs/acorn/blob/master/acorn/AUTHORS). Source: https://github.com/acornjs/acorn

The following MIT License applies separately to each of these dependencies:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Bun runtime and linked libraries

Bun itself is MIT-licensed. Its standalone executable also links libraries with other licenses, including JavaScriptCore/WebKit under LGPL-2 and TinyCC under LGPL-2.1. The pinned runtime's license overview and linked-library source/license references are available at:
https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md

Runtime source for the version used by this helper:
https://github.com/oven-sh/bun/tree/bun-v1.4.3

Modified WebKit/JavaScriptCore source:
https://github.com/oven-sh/WebKit

## Rebuilding with a modified runtime

Gyro's helper source is packages/codemode/worker.mjs, with a pinned dependency graph in pnpm-lock.yaml. It can be rebuilt independently of the desktop application.

To modify the linked JavaScriptCore runtime, follow Bun's pinned source instructions: clone its WebKit fork into vendor/WebKit, run bun sync-webkit-source to select the revision pinned by scripts/build/deps/webkit.ts, then bun run build:local. Run that modified Bun binary against worker.mjs using the compile options in packages/codemode/build.mjs. Replace the helper in the local application bundle with the resulting executable and re-sign the modified local bundle as needed.

This notice accompanies the helper in Gyro's application resources.
