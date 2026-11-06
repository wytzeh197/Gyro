# Gyro launch film — production plan

## Purpose

Create the launch film for Gyro's first frictionless, Developer ID-signed and
notarized public download. This is a design package for production in Astra,
not a claim that launch blockers are already cleared.

**Audience:** Mac developers already switching between AI coding agents,
terminal sessions, files, and diffs.

**Belief to change:** "These tools are separate, and I have to carry the task
context myself" → "Gyro keeps the coding task together, while leaving the work
on my Mac and the decisions in my hands."

**Single promise:** Keep one coding task moving across chat, CLI, and workspace
without losing context or control.

**Primary action:** Download Gyro for macOS at `usegyro.io` and try one real
task. Use this CTA only when the linked download is signed, notarized, and
matches the film. Until then, say "Join the public alpha" only if that is the
actual release path.

**Master hypothesis:** 60–75 seconds, 16:9, sound-on master with a complete
silent-autoplay story; derive 30-second and 15-second cuts plus 9:16/1:1
reframes. Final durations follow an actual timed read and edit, not this
hypothesis.

## Reference films and the quality bar

- [Linear product launch work](https://linear.app/now/press): product motion
  and typography move as one system. Borrow the clarity, tight timing, and
  confidence; do not borrow Linear's dark aesthetic or copy its feature-reel
  rhythm wholesale.
- [Raycast's "It's out" launch-film breakdown](https://impractical.ai/launch-videos/raycast-its-out):
  hard cuts timed to music, close UI framing, and kinetic type make the product
  feel fast. Borrow the principle that motion should express interaction
  speed; avoid making Gyro's dense developer UI unreadable through over-fast
  punches. Let the viewer see each meaningful state change before the next cut.
- [Arc Act II launch announcement](https://www.linkedin.com/posts/the-browser-company_today-we-shared-our-act-ii-for-arc-a-browser-activity-7158920392454098946-5A77):
  a founder-led, opinionated story makes the product's reason to exist clear.
  Borrow the human point of view, not its longer manifesto scale or claims that
  would outgrow Gyro's current alpha.

**Bar to hit:** premium sound and typography; immediate, legible product proof;
one memorable narrative device; no feature pile-up; no generic AI imagery; no
fake UI; every line supported by the current release. Craft should feel
intentional at phone size, and the product should still be understandable
muted.

The comparison is about craft, not budget: tight rhythm and well-framed real UI
are achievable in Astra. For Gyro, clarity wins over Raycast-speed cutting
because the story depends on reading a task, approval, and diff.

## Creative concept: "The task shouldn't split"

Use a single task as the thread. At first, its context is scattered across
separate windows. The windows align into Gyro's unified workspace; the same
task then moves from chat to terminal to review without the viewer having to
re-explain it. The visual transition is not magical automation: show explicit
user actions and real state changes.

**Emotional arc:** friction → recognition → focused control → earned relief.

**Signature moment:** three windows carrying the same task title snap into one
Gyro frame; a real proposed diff appears, waits for approval, then lands. Hold
long enough to read the approval and changed-file state.

**Tone:** direct, calm, assured, technically literate. No breathless futurism,
fake terminal gibberish, boastful "AI does everything," or competitor callout.

## Timed script and storyboard (70-second target)

All interface footage must be recaptured from the exact launch candidate after
the coding-loop checks pass. Any line in brackets is a production note, not
spoken copy. Narration is optional; the on-screen narrative must stand alone.

| Time | Picture / action | On-screen copy | Voiceover / sound |
|---|---|---|---|
| 0:00–0:06 | Black. Three real desktop fragments: chat, terminal, editor. A task prompt appears in one, its context visibly stops at the window edge. | **The work is one task.** | VO: "A coding task doesn't happen in one window." Low room tone; three restrained UI clicks. |
| 0:06–0:13 | User repeats a short context line across the separate windows; cut before fake text becomes readable. The windows drift out of alignment. | **The context keeps getting split.** | VO: "But the context keeps getting split between chat, CLI, files, and diffs." Rhythm starts, sparse and percussive. |
| 0:13–0:20 | Gyro opens. Show actual app launch and real Chat screen. The task title stays fixed as the framing widens. | **Gyro** / **Chat, CLI, and IDE in one place.** | VO: "Gyro brings the coding loop into one local workspace." First clear product reveal; no logo-only preamble. |
| 0:20–0:31 | Real connected provider/session. User starts the task; show honest running state. Transition to the same session in CLI, then Workspace. Keep task title and session evidence visible. | **One session. Move with the work.** | VO: "Start with the agent you already use. Continue from the app or the CLI without starting the story over." UI sounds are part of the beat, not decorative noise. |
| 0:31–0:43 | Agent proposes a small source edit. Open the real diff. Show changed path and exact Ask First approval; user reviews, approves, then show resulting diff/status. | **See the change. Choose what lands.** | VO: "When a change is proposed, review it before it touches your project." Music briefly drops at the approval decision; one clean confirmation tone after. |
| 0:43–0:54 | Show task run state, terminal output, and files/review within the same app context. No invented parallel-agent orchestration. | **Your project stays yours.** / **Local-first. Approval before mutation.** | VO: "Your sessions and projects stay on your Mac. The agent's work stays visible." Confirm each claim against the release and privacy docs. |
| 0:54–1:03 | Pull back to a composed, real desktop: Chat, CLI/workspace context in sequence—not fake simultaneous app states. Gyro mark resolves from actual UI geometry. | **One place to direct the work.** | VO: "One task. One place to keep moving." Music resolves, then leaves room. |
| 1:03–1:10 | End card, Gyro mark, download URL, macOS compatibility and release label. Hold at least 3 seconds. | **Gyro** / **Download for macOS** / `usegyro.io` / **Public Alpha · macOS 14+** | VO: "Download Gyro at usegyro.io." One restrained sonic signature; no extra claims. |

## Capture plan and claim gates

1. Create a clean, non-sensitive demo repository and a repeatable task that
   makes one small, visually legible source change with a deterministic test.
2. Capture the full workflow from a launch-candidate build: app start, provider
   connected, task run, app/CLI continuity if verified, proposed diff,
   approval, resulting file state, and final session state.
3. Capture at native resolution with readable editor scale and neutral desktop
   chrome. Hide personal data, credentials, notifications, and unrelated tabs.
4. Keep a source-of-truth shot manifest: build/version, operating system,
   provider, exact steps, capture time, and which claim each shot supports.
5. Do not composite impossible app states, invent telemetry, imply Gyro hosts
   sessions, imply every provider has approval-safe edits, or imply the
   integrated editor replaces a mature standalone IDE.
6. Recheck download URL, architecture, macOS minimum, and release label on the
   day of export. Remove unsigned-alpha language only after the new release is
   actually published and verified.

## Astra build plan (two working days)

### Day 1 — story and animatic

- Confirm the launch build and the exact flow that can be captured reliably.
- Produce 3–5 reference frames and the real screen capture plates before
  generating supporting visuals. UI must remain real and legible.
- Build the 70-second rough cut with timing, temporary VO, typography,
  placeholder end card, and simple transitions.
- Review hook comprehension at 3 seconds, product reveal by 15 seconds,
  approval proof, no-sound readability, and whether the final action is clear.
  Fix story/pacing now, not after polishing.

### Day 2 — finish and variants

- Replace placeholders with approved captures; refine type, easing, spacing,
  cursor movement, and restrained sound design.
- Record final VO only if the cut needs it; keep it conversational and leave
  deliberate quiet at the approval moment.
- Add burned-in captions to social variants; verify captions against VO.
- Derive 30s and 15s edits with their own story beats; create 9:16 and 1:1
  versions by re-layout, never by blindly cropping desktop footage.
- Export, watch every render full length with sound and muted, inspect mobile
  safe areas, and verify codec, dimensions, frame rate, and final URL.

## Astra shot-generation prompt

> Produce a restrained, premium launch film for Gyro, a local-first macOS
> workspace that brings agent chat, CLI, files, diffs, terminals, approvals,
> and session state together. The one promise is: keep a coding task moving
> across chat, CLI, and workspace without losing context or control. Use the
> supplied real Gyro screen recordings as the only source for product UI. Do
> not generate or redraw interface details, code, metrics, or logos. Build a
> 70-second 16:9 master around this arc: context fragmentation; early Gyro
> reveal; one verified task continuing across surfaces; a real proposed diff
> visibly reviewed and approved; local-first trust; concise download end card.
> Motion should clarify state changes and feel precise, not ornamental. Use
> dark neutral surroundings only if they match the captured app; restrained
> brand accent; clear mobile-legible typography; low-noise percussion and
> intentional silence at approval. Keep a silent-readable on-screen narrative.
> No competitor references, generic AI imagery, invented features, fake
> terminal text, exaggerated capability claims, or unverified download CTA.
> First return a shot-by-shot animatic plan and list any missing real captures;
> do not fabricate those captures.

## Deliverables and acceptance

- 70-second 16:9 master; H.264 MP4, 1920×1080, 30 fps, stereo audio.
- 30-second and 15-second story edits; 9:16 and 1:1 reframed versions.
- Captions (`.srt`) plus burned-in social captions; poster/thumbnail.
- Editable Astra project and a manifest of source footage, music/asset rights,
  version/build, export settings, and checksum.
- Every cut reviewed with sound and muted; all visible UI matches the release;
  CTA and support/install links resolve; no private data appears; captions and
  mobile-safe text are legible.

Keep rendered masters and working media outside ordinary Git unless the
repository's large-media policy is deliberately changed. The existing
[launch-film asset notes](media/launch/README.md) define the repository's
stable current master and media policy.
