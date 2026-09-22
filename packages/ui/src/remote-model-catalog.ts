import { providerCatalog } from "./provider-catalog.ts";
import type { ProviderModel, ReasoningEffort } from "./types";

// Increment when this client gains a new catalog-described model capability.
export const MODEL_CATALOG_CLIENT_REVISION = 1;
export const MODEL_CATALOG_CACHE_KEY = "gyro.model-catalog.v1";
/**
 * How long a focused, visible Gyro waits between catalog checks. This is the
 * latency that makes a published addition reach a watching picker "in minutes":
 * one interval, plus the edge cache lifetime of `/model-catalog.json`.
 */
export const MODEL_CATALOG_POLL_MS = 60 * 1000;
/**
 * The background cadence for an app nobody is watching, so idle installs cost
 * almost no requests. Regaining focus or coming back online checks at once, so
 * this interval is never the delay a person actually waits.
 */
export const MODEL_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const efforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const bundled = new Map(
  providerCatalog.map((p) => [p.id, structuredClone(p.models)]),
);

type CatalogModel = ProviderModel & {
  providerId: string;
  minClientRevision: number;
};
export type ModelCatalog = {
  schema: "gyro.model-catalog.v1";
  revision: string;
  enabled: boolean;
  rolloutPercentage: number;
  models: CatalogModel[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a catalog object");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Invalid catalog text");
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error("Invalid catalog number");
  }
  return value;
}

/** Reconstruct only data fields; never accept endpoints, credentials, or execution settings. */
export function parseModelCatalog(raw: string): ModelCatalog {
  if (new TextEncoder().encode(raw).length > MAX_BYTES)
    throw new Error("Catalog too large");
  const data = record(JSON.parse(raw));
  if (
    data.schema !== "gyro.model-catalog.v1" ||
    typeof data.enabled !== "boolean"
  ) {
    throw new Error("Unsupported model catalog");
  }
  if (!Array.isArray(data.models) || data.models.length > 500)
    throw new Error("Invalid models");
  const seen = new Set<string>();
  const models = data.models.map((item): CatalogModel => {
    const model = record(item);
    const providerId = text(model.providerId, 64);
    const id = text(model.id, 200);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(id))
      throw new Error("Invalid model id");
    const key = providerId + "/" + id;
    if (seen.has(key)) throw new Error("Duplicate model");
    seen.add(key);
    const result: CatalogModel = {
      providerId,
      id,
      displayName: text(model.displayName, 120),
      minClientRevision: integer(model.minClientRevision, 1, 1_000_000),
    };
    if (model.description !== undefined)
      result.description = text(model.description, 600);
    if (model.contextWindowTokens !== undefined) {
      result.contextWindowTokens = integer(
        model.contextWindowTokens,
        1,
        100_000_000,
      );
    }
    if (model.supportedReasoningEfforts !== undefined) {
      if (
        !Array.isArray(model.supportedReasoningEfforts) ||
        model.supportedReasoningEfforts.length > efforts.size ||
        model.supportedReasoningEfforts.some(
          (e) => typeof e !== "string" || !efforts.has(e),
        ) ||
        new Set(model.supportedReasoningEfforts).size !==
          model.supportedReasoningEfforts.length
      ) {
        throw new Error("Invalid reasoning efforts");
      }
      result.supportedReasoningEfforts =
        model.supportedReasoningEfforts as ReasoningEffort[];
    }
    if (model.defaultReasoningEffort !== undefined) {
      if (
        !result.supportedReasoningEfforts?.includes(
          model.defaultReasoningEffort as ReasoningEffort,
        )
      ) {
        throw new Error("Default effort must be supported");
      }
      result.defaultReasoningEffort =
        model.defaultReasoningEffort as ReasoningEffort;
    }
    return result;
  });
  return {
    schema: "gyro.model-catalog.v1",
    revision: text(data.revision, 120),
    enabled: data.enabled,
    rolloutPercentage: integer(data.rolloutPercentage, 0, 100),
    models,
  };
}

/** Each document replaces the previous overlay, so removal and rollback are immediate. */
export function applyModelCatalog(catalog: ModelCatalog, bucket: number): void {
  for (const provider of providerCatalog) {
    const defaults = bundled.get(provider.id);
    if (!defaults || provider.id === "ollama") continue;
    provider.models = structuredClone(defaults);
    if (!catalog.enabled || bucket >= catalog.rolloutPercentage) continue;
    for (const entry of catalog.models) {
      if (
        entry.providerId !== provider.id ||
        entry.minClientRevision > MODEL_CATALOG_CLIENT_REVISION
      )
        continue;
      const {
        providerId: _provider,
        minClientRevision: _minimum,
        ...model
      } = entry;
      const managed = { ...model, catalogManaged: true };
      const index = provider.models.findIndex((item) => item.id === model.id);
      if (index < 0) provider.models.push(managed);
      else provider.models[index] = managed;
    }
  }
}

/** A newly selectable catalog entry, framed for the message that announces it. */
export type ModelCatalogAddition = {
  providerId: string;
  providerLabel: string;
  id: string;
  displayName: string;
};

/** The provider an overlay entry can actually reach, or nothing when it cannot. */
function overlaidProvider(providerId: string) {
  const provider = providerCatalog.find((item) => item.id === providerId);
  if (!provider || provider.id === "ollama" || !bundled.has(provider.id)) {
    return undefined;
  }
  return provider;
}

/** Every entry a document makes selectable for this installation's bucket. */
function selectableKeys(catalog: ModelCatalog, bucket: number) {
  const keys = new Set<string>();
  if (!catalog.enabled || bucket >= catalog.rolloutPercentage) return keys;
  for (const entry of catalog.models) {
    if (
      overlaidProvider(entry.providerId) &&
      entry.minClientRevision <= MODEL_CATALOG_CLIENT_REVISION
    ) {
      keys.add(entry.providerId + "/" + entry.id);
    }
  }
  return keys;
}

/**
 * The entries a refresh makes newly selectable for this installation.
 *
 * The comparison is remote document against remote document, because comparing
 * against the bundled catalog would report every bundled model as new. Only
 * additions are returned: a withdrawal is a picker change, not news. Nothing is
 * returned for the first application of a document, or for a document that
 * follows a withdrawn one, so a fresh install never announces the models it
 * already had and a rollback never announces its own reversal.
 */
export function selectableAdditions(
  previous: ModelCatalog | undefined,
  next: ModelCatalog,
  bucket: number,
): ModelCatalogAddition[] {
  if (!previous?.enabled || !next.enabled || bucket >= next.rolloutPercentage) {
    return [];
  }
  const before = selectableKeys(previous, bucket);
  const after = selectableKeys(next, bucket);
  return next.models
    .filter(
      (entry) =>
        after.has(entry.providerId + "/" + entry.id) &&
        !before.has(entry.providerId + "/" + entry.id),
    )
    .map((entry) => ({
      providerId: entry.providerId,
      providerLabel:
        overlaidProvider(entry.providerId)?.displayName ?? entry.providerId,
      id: entry.id,
      displayName: entry.displayName,
    }));
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** What one refresh did, so the caller can decide whether to announce it. */
export type ModelCatalogRefresh = {
  /** The document differed from the one in effect and has been applied. */
  applied: boolean;
  /** Entries this refresh made newly selectable, ready to announce. */
  additions: ModelCatalogAddition[];
};

/** A refresh that changed nothing, or failed and left the last catalog in place. */
const noChange = (): ModelCatalogRefresh => ({ applied: false, additions: [] });

/** Dependencies are injected so offline startup and failed refreshes can be tested. */
export function createModelCatalogClient(
  storage: Storage,
  fetchCatalog: () => Promise<string>,
  random = Math.random,
) {
  let initialized = false;
  let pending: Promise<ModelCatalogRefresh> | undefined;
  let active = "";
  // The last document in effect this process, so additions compare remote to
  // remote rather than against the bundled catalog.
  let applied: ModelCatalog | undefined;
  let bucket = Math.floor(random() * 100);
  const read = (key: string) => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      storage.setItem(key, value);
    } catch {
      /* Private/full storage: use this session. */
    }
  };
  function restore() {
    if (initialized) return;
    initialized = true;
    const savedBucket = read(MODEL_CATALOG_CACHE_KEY + ".bucket");
    if (savedBucket !== null && /^(\d|[1-9]\d)$/.test(savedBucket))
      bucket = Number(savedBucket);
    else write(MODEL_CATALOG_CACHE_KEY + ".bucket", String(bucket));
    const cached = read(MODEL_CATALOG_CACHE_KEY);
    if (cached) {
      try {
        const catalog = parseModelCatalog(cached);
        applyModelCatalog(catalog, bucket);
        active = cached;
        applied = catalog;
      } catch {
        /* Bundled models remain available if cache is corrupt. */
      }
    }
  }
  function refresh(): Promise<ModelCatalogRefresh> {
    restore();
    if (pending) return pending;
    pending = (async () => {
      try {
        const raw = await fetchCatalog();
        const catalog = parseModelCatalog(raw);
        if (raw === active) return noChange();
        const additions = selectableAdditions(applied, catalog, bucket);
        applyModelCatalog(catalog, bucket);
        active = raw;
        applied = catalog;
        write(MODEL_CATALOG_CACHE_KEY, raw);
        return { applied: true, additions };
      } catch {
        return noChange(); // Preserve the last working catalog on any transport/validation failure.
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  return { restore, refresh };
}
