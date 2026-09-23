import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyModelCatalog,
  createModelCatalogClient,
  parseModelCatalog,
  MODEL_CATALOG_CACHE_KEY,
  MODEL_CATALOG_POLL_MS,
  MODEL_CATALOG_REFRESH_MS,
  MODEL_CATALOG_CLIENT_REVISION,
} from "../packages/ui/src/remote-model-catalog.ts";
import {
  providerCatalog,
  providersForConfig,
} from "../packages/ui/src/provider-catalog.ts";

const provider = providerCatalog.find((p) => p.id === "openai");
const original = structuredClone(provider);
const entry = {
  providerId: "openai",
  id: "catalog-test-model",
  displayName: "Catalog test",
  minClientRevision: 1,
  contextWindowTokens: 123456,
  supportedReasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "high",
};
const document = (models = [entry], extra = {}) =>
  JSON.stringify({
    schema: "gyro.model-catalog.v1",
    revision: "test.1",
    enabled: true,
    rolloutPercentage: 100,
    models,
    ...extra,
  });
const reset = () => applyModelCatalog(parseModelCatalog(document([])), 0);
const hasModel = () => provider.models.some((m) => m.id === entry.id);
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

// An announcement is only trustworthy while a focused picker polls inside a
// minute, and the background cadence must never outrun the focused one.
assert.ok(
  MODEL_CATALOG_POLL_MS <= 60_000,
  "A focused picker must check for new models at least once a minute",
);
assert.ok(
  MODEL_CATALOG_REFRESH_MS >= MODEL_CATALOG_POLL_MS,
  "The background cadence must not be faster than the focused one",
);

parseModelCatalog(
  readFileSync(new URL("../site/model-catalog.json", import.meta.url), "utf8"),
);
for (const raw of [
  "broken",
  document([entry, entry]),
  document([{ ...entry, contextWindowTokens: -1 }]),
  document([{ ...entry, defaultReasoningEffort: "medium" }]),
  document([{ ...entry, supportedReasoningEfforts: ["invented"] }]),
  document([{ ...entry, id: "--unsafe-flag" }]),
  document([{ ...entry, displayName: "bad\nname" }]),
  document([], { schema: "future" }),
  document([], { rolloutPercentage: 101 }),
  " ".repeat(256 * 1024 + 1),
])
  assert.throws(() => parseModelCatalog(raw));
const sanitized = parseModelCatalog(
  document([{ ...entry, baseUrl: "https://bad.invalid", supportsTools: true }]),
);
assert.equal(sanitized.models[0].baseUrl, undefined);
assert.equal(sanitized.models[0].supportsTools, undefined);

applyModelCatalog(sanitized, 0);
assert.ok(hasModel());
assert.deepEqual(provider.capabilities, original.capabilities);
assert.equal(provider.apiKeyRef, original.apiKeyRef);
assert.equal(provider.baseUrl, original.baseUrl);
let config = {
  modelProviders: [
    {
      ...provider,
      enabled: true,
      authStatus: "connected",
      selectedModelId: entry.id,
      defaultModelId: entry.id,
    },
  ],
};
let merged = providersForConfig(config).find((p) => p.id === "openai");
assert.equal(merged.selectedModelId, entry.id);
assert.equal(
  merged.models.find((m) => m.id === entry.id).contextWindowTokens,
  123456,
);
config.modelProviders = [merged];
reset();
merged = providersForConfig(config).find((p) => p.id === "openai");
assert.ok(!merged.models.some((m) => m.id === entry.id));
assert.equal(merged.selectedModelId, original.defaultModelId);

applyModelCatalog(
  parseModelCatalog(
    document([
      { ...entry, id: original.models[0].id, displayName: "Revised name" },
    ]),
  ),
  0,
);
merged = providersForConfig({ modelProviders: [original] }).find(
  (p) => p.id === "openai",
);
assert.equal(merged.models[0].displayName, "Revised name");
reset();
assert.equal(
  providersForConfig({ modelProviders: [merged] })[0].models[0].displayName,
  original.models[0].displayName,
);

applyModelCatalog(
  parseModelCatalog(
    document([
      { ...entry, minClientRevision: MODEL_CATALOG_CLIENT_REVISION + 1 },
    ]),
  ),
  0,
);
assert.ok(!hasModel());
applyModelCatalog(
  parseModelCatalog(document([entry], { rolloutPercentage: 25 })),
  25,
);
assert.ok(!hasModel());
applyModelCatalog(
  parseModelCatalog(document([entry], { rolloutPercentage: 25 })),
  24,
);
assert.ok(hasModel());
applyModelCatalog(parseModelCatalog(document([entry], { enabled: false })), 0);
assert.ok(!hasModel());
applyModelCatalog(
  parseModelCatalog(
    document([
      { ...entry, providerId: "ollama" },
      { ...entry, providerId: "unknown" },
    ]),
  ),
  0,
);
assert.ok(
  !providerCatalog
    .find((p) => p.id === "ollama")
    .models.some((m) => m.id === entry.id),
);

reset();
const storage = memory();
let payload = document();
let calls = 0;
const client = createModelCatalogClient(
  storage,
  async () => {
    calls++;
    return payload;
  },
  () => 0.12,
);
const first = client.refresh();
assert.equal(client.refresh(), first);
assert.deepEqual(await first, { applied: true, additions: [] });
assert.equal(calls, 1);
assert.ok(hasModel());
assert.deepEqual(await client.refresh(), { applied: false, additions: [] });
payload = "invalid";
assert.equal((await client.refresh()).applied, false);
assert.ok(hasModel());
assert.equal(storage.getItem(MODEL_CATALOG_CACHE_KEY), document());
reset();
const offline = createModelCatalogClient(
  storage,
  async () => {
    throw Error("offline");
  },
  () => 0.99,
);
offline.restore();
assert.ok(hasModel());
assert.equal((await offline.refresh()).applied, false);
assert.ok(hasModel());
assert.equal(storage.getItem(MODEL_CATALOG_CACHE_KEY + ".bucket"), "12");
payload = document([], { revision: "rollback" });
assert.equal((await client.refresh()).applied, true);
assert.ok(!hasModel());
reset();
const corrupt = memory();
corrupt.setItem(MODEL_CATALOG_CACHE_KEY, "invalid");
createModelCatalogClient(corrupt, async () => "").restore();
assert.deepEqual(provider.models, original.models);
const blocked = createModelCatalogClient(
  {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("full");
    },
  },
  async () => document(),
);
assert.equal((await blocked.refresh()).applied, true);
assert.ok(hasModel());
reset();

// Additions are reported remote document against remote document, and only
// when the picker really gains something the installation can run.
const secondEntry = {
  ...entry,
  id: "catalog-test-model-two",
  displayName: "Catalog test two",
};
const thirdEntry = {
  ...entry,
  id: "catalog-test-model-three",
  displayName: "Catalog test three",
};
let additionsPayload = document([entry], { revision: "add.1" });
const additionsClient = createModelCatalogClient(
  memory(),
  async () => additionsPayload,
  () => 0.12,
);
assert.deepEqual(await additionsClient.refresh(), {
  applied: true,
  additions: [],
});
additionsPayload = document([entry, secondEntry], { revision: "add.2" });
assert.deepEqual((await additionsClient.refresh()).additions, [
  {
    providerId: "openai",
    providerLabel: "OpenAI",
    id: secondEntry.id,
    displayName: "Catalog test two",
  },
]);
assert.ok(provider.models.some((m) => m.id === secondEntry.id));
// An entry gated on a later client revision is not selectable, so it is not news.
additionsPayload = document(
  [
    entry,
    secondEntry,
    {
      ...thirdEntry,
      minClientRevision: MODEL_CATALOG_CLIENT_REVISION + 1,
    },
  ],
  { revision: "add.3" },
);
assert.deepEqual((await additionsClient.refresh()).additions, []);
assert.ok(!provider.models.some((m) => m.id === thirdEntry.id));
// Withdrawing the document changes the picker without announcing anything.
additionsPayload = document([entry, secondEntry], {
  revision: "add.4",
  enabled: false,
});
assert.deepEqual((await additionsClient.refresh()).additions, []);
assert.ok(!provider.models.some((m) => m.id === secondEntry.id));
// Re-enabling announces nothing: this user already knew about these models.
additionsPayload = document([entry, secondEntry, thirdEntry], {
  revision: "add.5",
});
assert.deepEqual((await additionsClient.refresh()).additions, []);
// A removal is never reported as an addition.
additionsPayload = document([entry], { revision: "add.6" });
assert.deepEqual((await additionsClient.refresh()).additions, []);
// An entry outside this installation's rollout bucket stays invisible and silent.
additionsPayload = document([entry, secondEntry], {
  revision: "add.7",
  rolloutPercentage: 10,
});
assert.deepEqual((await additionsClient.refresh()).additions, []);
assert.ok(!provider.models.some((m) => m.id === secondEntry.id));
reset();

// Added models land where they belong in the picker, not at the bottom.
const anthropic = providerCatalog.find((p) => p.id === "anthropic");
const anthropicIds = () => anthropic.models.map((m) => m.id);
applyModelCatalog(
  parseModelCatalog(
    readFileSync(
      new URL("../site/model-catalog.json", import.meta.url),
      "utf8",
    ),
  ),
  0,
);
assert.deepEqual(anthropicIds(), [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);
const anthropicEntry = (id, extra = {}) => ({
  providerId: "anthropic",
  id,
  displayName: id,
  minClientRevision: 1,
  ...extra,
});
// Without a placement hint, a model goes above its family's older versions…
applyModelCatalog(
  parseModelCatalog(document([anthropicEntry("claude-sonnet-5-2")])),
  0,
);
assert.equal(anthropicIds().indexOf("claude-sonnet-5-2"), 4);
// …below its newer ones…
applyModelCatalog(
  parseModelCatalog(document([anthropicEntry("claude-opus-4-9")])),
  0,
);
assert.deepEqual(anthropicIds().slice(2, 5), [
  "claude-opus-5",
  "claude-opus-4-9",
  "claude-opus-4-8",
]);
// …and a hint naming a model that is not there falls back to the same rule.
applyModelCatalog(
  parseModelCatalog(
    document([anthropicEntry("claude-opus-5-5", { insertBefore: "gone" })]),
  ),
  0,
);
assert.equal(anthropicIds()[2], "claude-opus-5-5");
// A model with no family in the list still goes last.
applyModelCatalog(
  parseModelCatalog(document([anthropicEntry("claude-mythos")])),
  0,
);
assert.equal(anthropicIds().at(-1), "claude-mythos");
reset();

console.log(
  "Model catalog validation, picker merge, picker order, rollback, rollout, cache, offline, and addition-announcement checks passed.",
);
