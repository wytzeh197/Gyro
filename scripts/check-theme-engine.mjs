import assert from "node:assert/strict";
import { colorContrast } from "../packages/ui/src/appearance.ts";
import { fontFamilies } from "../packages/ui/src/theme/font-family.ts";
import { highlightCode } from "../packages/ui/src/theme/highlight-code.ts";
import { themePresetIds } from "../packages/ui/src/theme/presets.ts";
import {
  deriveThemeTokens,
  exportTheme,
  importTheme,
  themeSeed,
} from "../packages/ui/src/theme/theme-engine.ts";
import { parseSettingsTransfer } from "../packages/ui/src/settings-transfer.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

assert.equal(themePresetIds.length, 12);
for (const variant of ["light", "dark"]) {
  for (const themePreset of themePresetIds) {
    const seed = themeSeed(variant, { themePreset });
    const tokens = deriveThemeTokens(seed, variant);
    for (const foreground of ["--gyro-text", "--gyro-muted"]) {
      for (const background of ["--gyro-app", "--gyro-surface-raised"]) {
        assert.ok(
          colorContrast(tokens[foreground], tokens[background]) >= 4.5,
          `${themePreset} ${variant} ${foreground} against ${background}`,
        );
      }
    }
    assert.equal(tokens["--gyro-app"], seed.surface);
    assert.ok(
      colorContrast(tokens["--gyro-diff-added"], tokens["--gyro-surface"]) >=
        4.5,
    );
    const roundTrip = importTheme(exportTheme(variant, seed));
    assert.equal(roundTrip.variant, variant);
    assert.deepEqual(themeSeed(variant, roundTrip.preferences), seed);
  }
}
assert.equal(importTheme("gyro-theme-v1:{}"), undefined);
const invalidSeed = { ...themeSeed("dark", {}), contrast: 60.5 };
assert.equal(
  importTheme(
    "gyro-theme-v1:" + JSON.stringify({ variant: "dark", seed: invalidSeed }),
  ),
  undefined,
);
assert.throws(() => exportTheme("dark", invalidSeed));
assert.deepEqual(fontFamilies('Inter, "A, B", ui-monospace'), [
  '"Inter"',
  '"A, B"',
  "ui-monospace",
]);
assert.equal(fontFamilies("Geist,,,Monaco"), undefined);
assert.equal(fontFamilies("Geist; color:red"), undefined);

const state = createInitialWorkbenchState();
const changed = workbenchReducer(state, {
  type: "set-settings-preferences",
  patch: {
    themePreset: "nord",
    codeFont: "Monaco",
    themeOverrides: { contrast: 70 },
  },
});
const spaced = workbenchReducer(changed, {
  type: "set-density",
  density: "spacious",
});
assert.equal(spaced.preferences.themeOverrides.contrast, 70);
assert.equal(
  createInitialWorkbenchState({ preferences: spaced.preferences }).preferences
    .density,
  "spacious",
);
const reset = workbenchReducer(spaced, {
  type: "reset-ui-preferences",
}).preferences;
assert.equal(reset.themePreset, "gyro");
assert.equal(reset.themeOverrides, undefined);
assert.equal(reset.codeFont, undefined);
assert.equal(reset.density, "comfortable");

const portable = (settings) =>
  JSON.stringify({ format: "gyro-settings", version: 1, settings });
assert.deepEqual(
  parseSettingsTransfer(portable({ density: "spacious", themePreset: "one" })),
  {
    density: "spacious",
    themePreset: "one",
  },
);
assert.throws(() =>
  parseSettingsTransfer(portable({ themeOverrides: { contrast: 120 } })),
);
assert.throws(() =>
  parseSettingsTransfer(
    portable({ themeOverrides: { accent: "#445588", extra: "unsafe" } }),
  ),
);

const code =
  'const msg = "<script>text</script>";\n// keep the original line breaks';
const tokenLines = await highlightCode(code, "js");
assert.ok(tokenLines[0].some((token) => token.role === "keyword"));
assert.ok(tokenLines[1].some((token) => token.role === "comment"));
assert.equal(
  tokenLines
    .map((line) => line.map(({ content }) => content).join(""))
    .join("\n"),
  code,
);
assert.equal(await highlightCode("plain", "constructor"), undefined);
console.log(
  "Theme presets, contrast, sharing, preferences, and lazy code highlighting passed.",
);
