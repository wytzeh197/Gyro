import { normalizeTokenRole, tokenRoles } from "@gyro-dev/ui";

export const semanticLegend = {
  tokenTypes: [...tokenRoles],
  tokenModifiers: [
    "declaration",
    "definition",
    "readonly",
    "static",
    "deprecated",
    "abstract",
    "async",
    "modification",
    "documentation",
    "defaultLibrary",
  ],
};

// Validate the complete payload before applying any coloring. Positions are UTF-16.
export function decodeSemanticTokens(
  payload: unknown,
  legend: unknown,
  lineLengths: readonly number[],
): Uint32Array | undefined {
  if (
    !payload ||
    typeof payload !== "object" ||
    !legend ||
    typeof legend !== "object"
  )
    return;
  const data = (payload as { data?: unknown }).data;
  const types = (legend as { tokenTypes?: unknown }).tokenTypes;
  const modifiers = (legend as { tokenModifiers?: unknown }).tokenModifiers;
  if (
    !Array.isArray(data) ||
    data.length > 500000 ||
    data.length % 5 ||
    !Array.isArray(types) ||
    !types.every((type) => typeof type === "string") ||
    !Array.isArray(modifiers) ||
    !modifiers.every((modifier) => typeof modifier === "string") ||
    modifiers.length > 31
  )
    return;
  const output: number[] = [];
  let line = 0,
    column = 0,
    previousEnd = 0;
  for (let offset = 0; offset < data.length; offset += 5) {
    const values = data.slice(offset, offset + 5);
    if (
      !values.every(
        (value) =>
          Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff,
      )
    )
      return;
    const [deltaLine, deltaColumn, length, type, mask] = values as [
      number,
      number,
      number,
      number,
      number,
    ];
    line += deltaLine;
    column = deltaLine ? deltaColumn : column + deltaColumn;
    if (
      line >= lineLengths.length ||
      !length ||
      column + length > lineLengths[line]! ||
      type >= types.length ||
      mask >= 2 ** modifiers.length ||
      (!deltaLine && offset && column < previousEnd)
    )
      return;
    previousEnd = column + length;
    let role = normalizeTokenRole(types[type]!);
    let normalizedMask = 0;
    modifiers.forEach((modifier, index) => {
      if (!(mask & (2 ** index))) return;
      const target = semanticLegend.tokenModifiers.indexOf(modifier);
      if (target >= 0) normalizedMask |= 2 ** target;
      if (modifier === "readonly" && role === "variable") role = "constant";
      if (modifier === "documentation" && role === "comment")
        role = "docComment";
      if (modifier === "deprecated") role = "deprecated";
    });
    output.push(
      deltaLine,
      deltaColumn,
      length,
      tokenRoles.indexOf(role),
      normalizedMask,
    );
  }
  return new Uint32Array(output);
}
