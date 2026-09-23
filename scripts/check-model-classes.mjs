import assert from "node:assert/strict";
import {
  groupModelsByClass,
  modelClassName,
} from "../packages/ui/src/model-classes.ts";
import { providerCatalog } from "../packages/ui/src/provider-catalog.ts";

const classesOf = (names) => {
  const { groups, headed } = groupModelsByClass(names, (name) => name);
  return headed
    ? groups.map((group) => [group.label, group.models])
    : undefined;
};
const orderOf = (names) =>
  groupModelsByClass(names, (name) => name).groups.flatMap(
    (group) => group.models,
  );

// Class names come from the words before the version.
assert.equal(modelClassName("Claude Fable 5.1"), "Claude Fable");
assert.equal(modelClassName("GPT-5.4 mini"), "GPT-5");
assert.equal(modelClassName("GPT-6 Astra"), "GPT-6");
assert.equal(modelClassName("Qwen3.8 Max"), "Qwen3");
assert.equal(modelClassName("llama3.2:latest"), "llama3");
assert.equal(modelClassName("Kimi K3"), "Kimi");
assert.equal(modelClassName("Codestral"), "Codestral");

// Anthropic: every Opus sits by Opus, even one discovered after the catalog,
// and the shared "Claude" brand is dropped from the headings.
assert.deepEqual(
  classesOf([
    "Claude Fable 5.1",
    "Claude Opus 5",
    "Claude Fable 5",
    "Claude Sonnet 5",
    "Claude Opus 5.5",
  ]),
  [
    ["Fable", ["Claude Fable 5.1", "Claude Fable 5"]],
    ["Opus", ["Claude Opus 5", "Claude Opus 5.5"]],
    ["Sonnet", ["Claude Sonnet 5"]],
  ],
);

// OpenAI: GPT-6 and GPT-5 are the classes; runtime GPT-6 models join GPT-6.
assert.deepEqual(
  classesOf(["GPT-6 Astra", "GPT-5.6 Sol", "GPT-5.4 mini", "GPT-6 Luna"]),
  [
    ["GPT-6", ["GPT-6 Astra", "GPT-6 Luna"]],
    ["GPT-5", ["GPT-5.6 Sol", "GPT-5.4 mini"]],
  ],
);

// Headings only when they group something: one class, or all singletons,
// stays a flat list.
assert.equal(classesOf(["Grok 4.7", "Grok 4.6"]), undefined);
assert.equal(
  classesOf(["Mistral Medium 3.5", "Mistral Large 3", "Codestral"]),
  undefined,
);

// A router's mixed list stays flat but still keeps a class together.
const router = [
  "Claude Sonnet 5",
  "Grok 4.7",
  "Claude Opus 5",
  "GPT-6 Astra",
  "Gemini 3.8 Flash",
  "Grok 4.6",
];
assert.equal(classesOf(router), undefined);
assert.deepEqual(orderOf(router), [
  "Claude Sonnet 5",
  "Grok 4.7",
  "Grok 4.6",
  "Claude Opus 5",
  "GPT-6 Astra",
  "Gemini 3.8 Flash",
]);

// Every built-in provider either groups cleanly or stays flat, and grouping
// never drops or duplicates a model.
for (const provider of providerCatalog) {
  const names = provider.models.map((model) => model.displayName);
  const { groups } = groupModelsByClass(names, (name) => name);
  assert.deepEqual(
    groups.flatMap((group) => group.models).sort(),
    [...names].sort(),
    `${provider.id} grouping must keep every model`,
  );
  for (const group of groups) {
    assert.ok(group.label.trim(), `${provider.id} class needs a heading`);
  }
}

console.log("Model class grouping checks passed");
