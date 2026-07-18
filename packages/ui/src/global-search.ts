export function normalizedGlobalSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function globalSearchMatchScore(
  query: string,
  label: string,
  searchText: string,
) {
  const normalizedQuery = normalizedGlobalSearchText(query);
  if (!normalizedQuery) return 0;
  const normalizedLabel = normalizedGlobalSearchText(label);
  const normalizedSearchText = normalizedGlobalSearchText(searchText);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => normalizedSearchText.includes(term))) {
    return Number.POSITIVE_INFINITY;
  }
  if (normalizedLabel === normalizedQuery) return 0;
  if (normalizedLabel.startsWith(normalizedQuery)) return 10;
  if (
    normalizedLabel
      .split(/[^a-z0-9]+/)
      .some((word) => word.startsWith(normalizedQuery))
  ) {
    return 20;
  }
  const labelOffset = normalizedLabel.indexOf(normalizedQuery);
  return labelOffset >= 0 ? 30 + labelOffset : 100;
}
