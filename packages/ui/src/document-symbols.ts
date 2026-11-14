/** 1-based, end-exclusive columns, as Monaco uses them. */
export type DocumentSymbolRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type DocumentSymbol = {
  name: string;
  detail?: string;
  /** LSP SymbolKind (1 = File … 26 = TypeParameter). */
  kind: number;
  range: DocumentSymbolRange;
  selectionRange: DocumentSymbolRange;
  children: DocumentSymbol[];
};

export type FlatDocumentSymbol = DocumentSymbol & {
  depth: number;
  /** Names of the enclosing symbols, outermost first. */
  container: string[];
};

const MAX_SYMBOLS = 5_000;
const MAX_DEPTH = 32;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lspRange(value: unknown): DocumentSymbolRange | undefined {
  const range = record(value);
  const start = record(range?.start);
  const end = record(range?.end);
  const coordinates = [start?.line, start?.character, end?.line, end?.character];
  if (
    !coordinates.every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isSafeInteger(coordinate) &&
        coordinate >= 0,
    )
  )
    return undefined;
  const [startLine, startCharacter, endLine, endCharacter] =
    coordinates as number[];
  if (
    endLine! < startLine! ||
    (endLine === startLine && endCharacter! < startCharacter!)
  )
    return undefined;
  return {
    startLineNumber: startLine! + 1,
    startColumn: startCharacter! + 1,
    endLineNumber: endLine! + 1,
    endColumn: endCharacter! + 1,
  };
}

function symbolKind(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 26
    ? value
    : 13;
}

function rangeContains(outer: DocumentSymbolRange, inner: DocumentSymbolRange) {
  const startsAfter =
    inner.startLineNumber > outer.startLineNumber ||
    (inner.startLineNumber === outer.startLineNumber &&
      inner.startColumn >= outer.startColumn);
  const endsBefore =
    inner.endLineNumber < outer.endLineNumber ||
    (inner.endLineNumber === outer.endLineNumber &&
      inner.endColumn <= outer.endColumn);
  return startsAfter && endsBefore;
}

function compareStart(a: DocumentSymbol, b: DocumentSymbol) {
  return (
    a.range.startLineNumber - b.range.startLineNumber ||
    a.range.startColumn - b.range.startColumn
  );
}

/**
 * Accepts both shapes `textDocument/documentSymbol` may return: the
 * hierarchical `DocumentSymbol[]` and the flat `SymbolInformation[]`. Flat
 * results are nested by range containment so both render as one tree.
 */
export function documentSymbolsFromLsp(value: unknown): DocumentSymbol[] {
  if (!Array.isArray(value)) return [];
  let budget = MAX_SYMBOLS;
  const hierarchical = (items: unknown[], depth: number): DocumentSymbol[] =>
    items.flatMap((item) => {
      if (budget <= 0 || depth > MAX_DEPTH) return [];
      const symbol = record(item);
      const range = lspRange(symbol?.range);
      if (!symbol || typeof symbol.name !== "string" || !range) return [];
      budget -= 1;
      return [
        {
          name: symbol.name,
          detail: typeof symbol.detail === "string" ? symbol.detail : undefined,
          kind: symbolKind(symbol.kind),
          range,
          selectionRange: lspRange(symbol.selectionRange) ?? range,
          children: Array.isArray(symbol.children)
            ? hierarchical(symbol.children, depth + 1).sort(compareStart)
            : [],
        },
      ];
    });
  const isFlat = value.some((item) => record(record(item)?.location));
  if (!isFlat) return hierarchical(value, 0).sort(compareStart);

  const flat = value
    .flatMap((item): DocumentSymbol[] => {
      if (budget <= 0) return [];
      const symbol = record(item);
      const range = lspRange(record(symbol?.location)?.range);
      if (!symbol || typeof symbol.name !== "string" || !range) return [];
      budget -= 1;
      return [
        {
          name: symbol.name,
          detail:
            typeof symbol.containerName === "string"
              ? symbol.containerName
              : undefined,
          kind: symbolKind(symbol.kind),
          range,
          selectionRange: range,
          children: [],
        },
      ];
    })
    .sort(compareStart);
  const roots: DocumentSymbol[] = [];
  const stack: DocumentSymbol[] = [];
  for (const symbol of flat) {
    while (stack.length && !rangeContains(stack.at(-1)!.range, symbol.range))
      stack.pop();
    if (stack.length >= MAX_DEPTH) stack.length = MAX_DEPTH - 1;
    (stack.at(-1)?.children ?? roots).push(symbol);
    stack.push(symbol);
  }
  return roots;
}

export function flattenDocumentSymbols(
  symbols: readonly DocumentSymbol[],
): FlatDocumentSymbol[] {
  const result: FlatDocumentSymbol[] = [];
  const walk = (items: readonly DocumentSymbol[], container: string[]) => {
    for (const symbol of items) {
      result.push({ ...symbol, depth: container.length, container });
      walk(symbol.children, [...container, symbol.name]);
    }
  };
  walk(symbols, []);
  return result;
}

/** Innermost-last chain of symbols whose range holds the position. */
export function documentSymbolPathAt(
  symbols: readonly DocumentSymbol[],
  position: { lineNumber: number; column: number },
): DocumentSymbol[] {
  const point = {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
  const path: DocumentSymbol[] = [];
  let level: readonly DocumentSymbol[] = symbols;
  while (true) {
    const match = level.find((symbol) => rangeContains(symbol.range, point));
    if (!match) return path;
    path.push(match);
    level = match.children;
  }
}

const KIND_LABELS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
] as const;

export function documentSymbolKindLabel(kind: number) {
  return KIND_LABELS[kind - 1] ?? "symbol";
}

/** Short glyph for dense lists; avoids pulling an icon set per kind. */
export function documentSymbolKindGlyph(kind: number) {
  switch (kind) {
    case 5:
    case 23:
      return "C";
    case 6:
    case 9:
    case 12:
      return "ƒ";
    case 7:
    case 8:
    case 20:
      return "▪";
    case 10:
    case 22:
      return "E";
    case 11:
    case 26:
      return "I";
    case 2:
    case 3:
    case 4:
      return "{}";
    case 14:
      return "π";
    default:
      return "◦";
  }
}
