# Gyro launch film — Work section redesign (handoff plan)

## Where things are
- **Project:** `/Users/wytze/Gyro/docs/media/launch/film` (Remotion; composition id `Film`, 1920×1080 @ 30fps)
- **Current render:** `/Users/wytze/Gyro/docs/media/launch/film/out/gyro-launch-v3.mp4` (82.5s)
- **Film order** (`src/Film.tsx`): Open → Meet → Apps → Ship → **Work** → Night. Work's duration is `round(WORK * SLOW)` (SLOW = 1.3), so Work's own frames play 1.3× slower than they're written.
- **File to rewrite:** `src/take/Work.tsx`. It currently holds the fast-cut montage: "Chat." / "Terminals." / "Code." cards with 12 shots. Keep its panels (`ChatPanel`, `CliPanel`/`TermPane`, `IdePanel`, `TestRoll`, `SideChat`) for reuse; replace `SHOTS` and the `Work` component.
- **Helpers** (`src/take/kit.tsx`): `TakeCam`, `camAt(keys, s)`, `TypeCard`, `Stripes`, `p01`, `Key`. Inside acts, `useFrame()` from `../pace` gives act-local frames.
- **Logos:** `ProviderLogo` from `@gyro-ui/workspace-sidebar.tsx` (aliased to `/Users/wytze/Gyro/packages/ui/src`). Supported ids: `anthropic`, `openai`, `xai`, `deepseek`, `kimi`, `gemini`, `ollama`. See `src/take/Apps.tsx` for usage: `<ProviderLogo providerId={id as never} label={id}/>`.
- **Model names:** use only names from `/Users/wytze/Gyro/catalog/model-catalog.json` ("Claude Opus 5.5" exists).
- **App window placement** in Work: AX=320, AY=140, AW=1280, AH=800.

## Hard rules
- Keep the opening and the Night ending unchanged. Never touch `src/scenes/AppTest.tsx`.
- Use the real logo, `staticFile("gyro-app-icon.png")`. The UI must match the real Gyro app (light theme, current composer).
- No licensed music, no voiceover, no invented product claims. No orbit rings. Keep the blinking block cursor.
- The tone is "Stop using so many apps", not "stop using Claude".
- Symlink node_modules, never copy. Never `rm` a path held in a shell variable.
- Preserve any user edits you find.

## New Work structure (minimal: one line + one action per surface, ~6s each, ~18–20s total)
Write in Work-local frames. Remember ×1.3 on playback; ~140 local frames ≈ 6s.

### 1. Chat (~0–150)
- Typography on a clean background: a fixed "Use" plus a rolling slot holding **[logo] Name**, which rolls downward.
  - Order: Claude (anthropic) → ChatGPT (openai) → Grok (xai) → DeepSeek (deepseek) → Kimi (kimi) → Gemini (gemini) → Ollama (ollama).
  - Easing: the first two hold ~25 frames each, then the holds shrink (e.g. 14, 10, 7, 5, 5). Use spring/eased translateY with a slight blur on fast rolls.
  - Optional payoff: after Ollama, all 7 logos snap into one row for ~12 frames.
- Cut or morph to the **current Gyro composer**. Reuse `ChatPanel`'s composer and check it against `packages/ui/src` for the latest look.
- The cursor (`Key`/pointer from kit) clicks the model pill, the picker opens, it selects **Claude Opus 5.5**, and the effort shows **High**.
- A short prompt types in (e.g. "Fix the checkout bug and open a PR."), the cursor clicks send, and the arrow pulses. **Cut on send.** No steps, approval or reply.

### 2. CLI (~150–300)
- Line: **"Your CLI. Your terminal. Inside Gyro."** Fallback: "Bring your own CLI. Or just use the terminal."
- Visual: the Terminal grid (`CliPanel`/`TermPane`) grows pane by pane:
  1. pane 1 types `claude` with the blinking block cursor;
  2. pane 2 slides in typing `codex`;
  3. pane 3 slides in with a plain `git status` (the "use it how you normally would" beat).
- Three panes max, a slow gentle push-in, and no 4-pane pull-back.

### 3. Code (~300–450)
- Line: **"Check all the code AI is shipping… in-house."** Alternative: "…without leaving Gyro."
- Effect on "in-house": an accent-colour underline draws under it, then extends and becomes the edge of the **Workspace sidebar** sliding in.
- Window: the cursor clicks Open folder, the `aurora` tree expands (src → cart), it clicks `total.ts`, and the code shows for ~1s (`IdePanel` editor view).
- The window moves/scales out, then the existing `<Stripes>` wipe runs over the last ~30 frames into Night.

### Transitions
- Use soft eased transitions between the three beats, not hard cuts. Hold each line ~0.7s after it lands before the UI arrives.
- Remove the old "Chat."/"Terminals."/"Code." TypeCards and the 12-shot `SHOTS` array.

## Verify and render (run from the film dir)
- Type check: `npx tsc --noEmit`. Only the pre-existing `@gyro-ui` alias errors are expected.
- Stills: Work starts at **film frame 982**. Film frame = 982 + round(local × 1.3).
  `npx remotion still Film out.png --frame=N --scale=0.5 --bundle-cache=false --log=error`
  (zsh: loop over literal lists, not a space-separated string variable.)
- Render: `npx remotion render Film out/gyro-launch-v4.mp4`. Run it in the background; it takes a few minutes.
- Night's start shifts automatically, but check that Night's first frames and the wipe line up.
