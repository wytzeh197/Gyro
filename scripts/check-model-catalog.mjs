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
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
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

// The picker and the runner must accept and reject the same documents, or
// the runner can hold a catalog the picker refused. model_catalog.rs runs the
// same fixture.
const parity = JSON.parse(
  readFileSync(
    new URL("./fixtures/model-catalog-parity.json", import.meta.url),
    "utf8",
  ),
);
for (const { name, valid, raw } of parity.cases) {
  if (valid) assert.doesNotThrow(() => parseModelCatalog(raw), name);
  else assert.throws(() => parseModelCatalog(raw), undefined, name);
}
assert.throws(() =>
  parseModelCatalog(
    document(
      Array.from({ length: 501 }, (_, i) => ({ ...entry, id: "m" + i })),
    ),
  ),
);

// The runner receives exactly the documents the picker puts into effect, with
// the picker's bucket, and nothing the picker refused.
{
  const handed = [];
  const store = memory();
  store.setItem(MODEL_CATALOG_CACHE_KEY + ".bucket", "42");
  store.setItem(MODEL_CATALOG_CACHE_KEY, document([]));
  let served = document([]);
  const handoff = createModelCatalogClient(
    store,
    async () => served,
    Math.random,
    (raw, bucket) => handed.push([raw, bucket]),
  );
  handoff.restore();
  assert.deepEqual(handed, [[document([]), 42]]);
  await handoff.refresh(); // unchanged
  served = "broken";
  await handoff.refresh(); // refused
  assert.equal(handed.length, 1);
  served = document([entry]);
  assert.equal((await handoff.refresh()).applied, true);
  assert.deepEqual(handed.at(-1), [document([entry]), 42]);
  reset();

  // A runner that cannot take the document leaves the picker's copy in effect.
  const failing = createModelCatalogClient(
    memory(),
    async () => document([entry]),
    () => 0,
    () => {
      throw new Error("runner unavailable");
    },
  );
  assert.equal((await failing.refresh()).applied, true);
  assert.ok(hasModel());
  reset();
}

// Every published entry must reach a picker. A typo in a provider or an
// anchor is otherwise silent: the document is valid and the model never shows.
{
  const published = parseModelCatalog(
    readFileSync(
      new URL("../site/model-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const bundledIds = new Map(
    providerCatalog.map((p) => [p.id, p.models.map((m) => m.id)]),
  );
  for (const model of published.models) {
    const label = `${model.providerId}/${model.id}`;
    const known = bundledIds.get(model.providerId);
    assert.ok(
      known && model.providerId !== "ollama",
      `${label}: providerId is not a catalog provider, so no picker shows it`,
    );
    assert.ok(
      model.minClientRevision <= MODEL_CATALOG_CLIENT_REVISION,
      `${label}: needs client revision ${model.minClientRevision}, which no release supports yet`,
    );
    const siblings = new Set([
      ...known,
      ...published.models
        .filter((other) => other.providerId === model.providerId)
        .map((other) => other.id),
    ]);
    assert.ok(
      !model.insertBefore || siblings.has(model.insertBefore),
      `${label}: insertBefore "${model.insertBefore}" names no model`,
    );
    // An entry replaces bundled metadata whole, so these are never optional.
    for (const field of ["contextWindowTokens", "supportedReasoningEfforts"]) {
      assert.ok(model[field] !== undefined, `${label}: ${field} is missing`);
    }
    assert.equal(
      model.defaultReasoningEffort !== undefined,
      model.supportedReasoningEfforts.length > 0,
      `${label}: a default effort must exist exactly when the model offers effort`,
    );
  }
  // New builds bundle Sol; existing revision-2 installs receive the same
  // runtime facts from the overlay, without a duplicate picker entry.
  applyModelCatalog(published, 0);
  const sol = provider.models.filter((model) => model.id === "gpt-6.1-sol");
  assert.equal(sol.length, 1);
  assert.equal(sol[0].contextWindowTokens, 500_000);
  assert.deepEqual(sol[0].supportedReasoningEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(provider.models[0].id, "gpt-6.1-sol");
  const solEntry = published.models.find((model) => model.id === "gpt-6.1-sol");
  assert.equal(solEntry?.minClientRevision, 2);
  assert.equal(solEntry?.insertBefore, "gpt-6-astra");
  assert.equal(sol[0].defaultReasoningEffort, "low");
  reset();
}

// Retirement is scoped to the integration, not just a model-name prefix.
{
  const facts = JSON.parse(
    readFileSync(
      new URL("../packages/ui/src/model-retirements.json", import.meta.url),
      "utf8",
    ),
  );
  for (const retirement of facts.retirements) {
    const source = providerCatalog.find((p) => p.id === retirement.providerId);
    if (!source) {
      assert.equal(retirement.providerId, "gemini", "Only a retired provider can lack a catalog entry");
      assert.ok(!providersForConfig({modelProviders: [{id: "gemini", enabled: true}]}).some(p => p.id === "gemini"));
      continue;
    }
    for (const id of retirement.modelIds) {
      const oldModel = { id, displayName: id };
      const normalized = providersForConfig({
        modelProviders: [
          {
            ...source,
            models: [oldModel],
            defaultModelId: id,
            selectedModelId: id,
          },
        ],
      }).find((p) => p.id === retirement.providerId);
      assert.ok(!normalized.models.some((m) => m.id === id), id);
      assert.notEqual(normalized.defaultModelId, id, id);
      assert.notEqual(normalized.selectedModelId, id, id);
      applyModelCatalog(
        parseModelCatalog(
          document([{ ...entry, providerId: retirement.providerId, id }]),
        ),
        0,
      );
      assert.ok(
        !source.models.some((m) => m.id === id),
        "A stale remote catalog must not resurrect " + id,
      );
      reset();
      if (retirement.scope === "codex-chatgpt") {
        const api = providersForConfig({
          modelProviders: [
            {
              ...source,
              authMode: "env",
              models: [oldModel],
              defaultModelId: id,
              selectedModelId: id,
            },
          ],
        }).find((p) => p.id === retirement.providerId);
        assert.equal(api.selectedModelId, id, "API access is not retired");
      }
    }
  }
  const router = providerCatalog.find((p) => p.id === "openrouter");
  assert.equal(
    providersForConfig({
      modelProviders: [
        {
          ...router,
          models: [{ id: "deepseek/deepseek-chat", displayName: "Hosted V3" }],
          selectedModelId: "deepseek/deepseek-chat",
        },
      ],
    }).find((p) => p.id === "openrouter").selectedModelId,
    "deepseek/deepseek-chat",
  );
  assert.ok(
    provider.models.some((m) => m.id === "gpt-5.5"),
    "October 14 retirement must not remove October 13 access",
  );
  const native = readFileSync(
    new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  assert.match(
    native,
    /fn run_provider_chat_once[\s\S]*?validate_provider_model/,
  );
}

// Pin the sourced integration metadata for every picker model, including the
// remote additions. Also prove saved configurations cannot restore stale values.
{
  const facts = JSON.parse(
    readFileSync(
      new URL("./fixtures/model-metadata.json", import.meta.url),
      "utf8",
    ),
  );
  const published = parseModelCatalog(
    readFileSync(
      new URL("../site/model-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const checkMetadata = (providers, expected, label) => {
    const actual = providers.flatMap((p) =>
      p.models.map((m) => [
        p.id,
        m.id,
        m.contextWindowTokens ?? null,
        m.supportedReasoningEfforts ?? [],
        m.defaultReasoningEffort ?? null,
      ]),
    );
    const byIdentity = (a, b) =>
      (a[0] + "/" + a[1]).localeCompare(b[0] + "/" + b[1]);
    assert.deepEqual(
      actual.sort(byIdentity),
      structuredClone(expected).sort(byIdentity),
      label,
    );
  };
  const bundledIds = new Set(
    providerCatalog.flatMap((p) => p.models.map((m) => p.id + "/" + m.id)),
  );
  const bundled = facts.models.filter(([p, id]) =>
    bundledIds.has(p + "/" + id),
  );
  checkMetadata(providerCatalog, bundled, "Bundled model metadata");
  applyModelCatalog(published, 0);
  checkMetadata(
    providerCatalog,
    facts.models,
    "Effective picker model metadata",
  );
  const saved = {
    modelProviders: providerCatalog.map((p) => ({
      ...p,
      models: p.models.map((m) => ({
        ...m,
        contextWindowTokens: 1,
        supportedReasoningEfforts: ["ultra"],
        defaultReasoningEffort: "ultra",
      })),
    })),
  };
  checkMetadata(
    providersForConfig(saved),
    facts.models,
    "Saved model metadata is refreshed",
  );
  reset();
}

for (const provider of providersForConfig({
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
})) {
  assert.ok(
    !provider.models.some((model) => model.id === "grok-4.7-build-fast"),
    `${provider.id} still lists Grok 4.7 Fast as a picker model`,
  );
}
const withoutDeepseek = providersForConfig({
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
  removedProviderIds: ["deepseek"],
});
assert.equal(
  withoutDeepseek.some((provider) => provider.id === "deepseek"),
  false,
  "A removed provider must stay out of the picker",
);

// Every picker model belongs to one connection. A product listed on two
// connections is two rows, and each row keeps the window that connection
// serves. Equal numbers stay when both sources agree (Claude Code and
// OpenRouter both serve 1M). A model with no twin stays on its one connection.
{
  const connection = {
    openai: "cli",
    anthropic: "cli",
    kimi: "cli",
    xai: "cli",
    antigravity: "cli",
    cursor: "cli",
    opencode: "cli",
    deepseek: "api",
    mistral: "api",
    openrouter: "api",
    ollama: "local",
  };
  const connectionLabel = {
    openai: "Codex CLI",
    anthropic: "Claude Code",
    kimi: "Kimi Code",
    xai: "Grok Build",
    antigravity: "Antigravity",
    cursor: "Cursor CLI",
    opencode: "OpenCode CLI",
    deepseek: "DeepSeek API",
    mistral: "Mistral API",
    openrouter: "OpenRouter API",
  };
  for (const provider of providerCatalog) {
    const kind = connection[provider.id];
    assert.ok(kind, `${provider.id} has no catalog connection`);
    if (kind === "api") {
      assert.equal(provider.capabilities.executionKind, "openai-compatible-api");
      assert.equal(provider.authMode, "env");
    } else if (kind === "local") {
      assert.equal(provider.capabilities.executionKind, "ollama-api");
    } else {
      assert.notEqual(
        provider.capabilities.executionKind,
        "openai-compatible-api",
        `${provider.id} is a CLI connection`,
      );
    }
  }
  const published = parseModelCatalog(
    readFileSync(
      new URL("../site/model-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  applyModelCatalog(published, 0);
  const rows = providerCatalog.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      id: model.id,
      name: model.displayName,
      kind: connection[provider.id],
      window: model.contextWindowTokens ?? null,
      description: model.description ?? "",
    })),
  );
  reset();
  const facts = JSON.parse(
    readFileSync(
      new URL("./fixtures/model-metadata.json", import.meta.url),
      "utf8",
    ),
  );
  const identity = (providerId, id) => providerId + "/" + id;
  assert.deepEqual(
    rows.map((row) => identity(row.providerId, row.id)).sort(),
    facts.models.map(([providerId, id]) => identity(providerId, id)).sort(),
    "Every picker model is checked on its own connection",
  );
  for (const row of rows) {
    const label = connectionLabel[row.providerId];
    assert.ok(label, `${row.providerId}/${row.id} has no connection label`);
    assert.ok(
      row.description.includes(label),
      `${row.providerId}/${row.id} must name its ${row.kind} connection`,
    );
  }
  // Each product's rows are pinned independently. The numbers are the
  // window that connection serves, not a copy of the other row.
  const shared = [
    {
      name: "Grok 4.7",
      rows: [
        ["xai", "grok-4.7", "cli", 256_000],
        ["openrouter", "x-ai/grok-4.7", "api", 500_000],
      ],
    },
    {
      name: "Grok 4.6",
      rows: [
        ["xai", "grok-4.6", "cli", 256_000],
        ["openrouter", "x-ai/grok-4.6", "api", 500_000],
      ],
    },
    {
      name: "GPT-6 Astra",
      rows: [
        ["openai", "gpt-6-astra", "cli", 272_000],
        ["openrouter", "openai/gpt-6-astra", "api", 1_050_000],
      ],
    },
    {
      name: "Kimi K3.1 Pro",
      rows: [
        ["kimi", "k3.1-pro", "cli", 262_144],
        ["openrouter", "moonshotai/kimi-k3.1-pro", "api", 1_048_576],
      ],
    },
    {
      name: "Kimi K3",
      rows: [
        ["kimi", "k3", "cli", 262_144],
        ["openrouter", "moonshotai/kimi-k3", "api", 1_048_576],
      ],
    },
    {
      name: "Claude Sonnet 5",
      rows: [
        ["anthropic", "claude-sonnet-5", "cli", 1_000_000],
        ["openrouter", "anthropic/claude-sonnet-5", "api", 1_000_000],
      ],
    },
    {
      name: "Claude Opus 5",
      rows: [
        ["anthropic", "claude-opus-5", "cli", 1_000_000],
        ["openrouter", "anthropic/claude-opus-5", "api", 1_000_000],
      ],
    },
    {
      name: "DeepSeek V4.1 Flash",
      rows: [
        ["deepseek", "deepseek-flash", "api", 1_000_000],
        ["openrouter", "deepseek/deepseek-v4.1-flash", "api", 1_048_576],
      ],
    },
  ];
  const byName = new Map();
  for (const row of rows) {
    const group = byName.get(row.name) ?? [];
    group.push(row);
    byName.set(row.name, group);
  }
  const pinnedNames = new Set();
  for (const product of shared) {
    pinnedNames.add(product.name);
    const matched = product.rows.map(([providerId, id, kind, window]) => {
      const row = rows.find(
        (item) => item.providerId === providerId && item.id === id,
      );
      assert.ok(row, `${providerId}/${id} is missing`);
      assert.equal(row.name, product.name, `${providerId}/${id}`);
      assert.equal(row.kind, kind, `${providerId}/${id}`);
      assert.equal(
        row.window,
        window,
        `${providerId}/${id} keeps the window its own connection serves`,
      );
      return row;
    });
    assert.equal(
      new Set(matched.map((row) => row.providerId)).size,
      matched.length,
      `${product.name} must be a separate row on each connection`,
    );
    assert.deepEqual(
      byName
        .get(product.name)
        .map((row) => identity(row.providerId, row.id))
        .sort(),
      matched.map((row) => identity(row.providerId, row.id)).sort(),
      `${product.name} has an unexpected extra connection`,
    );
  }
  for (const [name, group] of byName) {
    if (pinnedNames.has(name)) continue;
    assert.equal(
      new Set(group.map((row) => row.providerId)).size,
      1,
      `${name} is on more than one connection and needs its own window pin`,
    );
  }
  assert.equal(
    rows.some((row) => row.providerId === "xai" && row.id === "grok-4.3"),
    false,
    "Grok 4.3 is not a Grok Build CLI model",
  );
}

console.log(
  "Model catalog parsing, picker merge/order, rollback, rollout, offline, announcements, and model metadata checks passed.",
);
