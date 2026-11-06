import ts from "typescript";
const cache = new Map();
function normalize(source) {
  const tree = ts.createSourceFile(
    "guard-source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const literals = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
      literals.push([node.getStart(tree), node.end]);
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  let cursor = 0,
    result = "";
  const code = (value) => value.replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");
  for (const [start, end] of literals.sort((a, b) => a[0] - b[0])) {
    result += code(source.slice(cursor, start)) + source.slice(start, end);
    cursor = end;
  }
  return result + code(source.slice(cursor));
}
// Structural assertions tolerate wrapping/trailing commas while preserving
// literal text, including spaces in rendered copy. They do not bless behavior.
export function sourceIncludes(source, fragment) {
  if (source.includes(fragment)) return true;
  if (!cache.has(source)) cache.set(source, normalize(source));
  return cache.get(source).includes(normalize(fragment));
}
