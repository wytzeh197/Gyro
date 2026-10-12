/** Present capacity left without changing provider spend or safety thresholds. */
export function remainingUsage(usedPercent?: number, exhausted = false) {
  if (exhausted) return { percent: 0, percentLabel: "0%" };
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent))
    return { percent: undefined, percentLabel: "—" };
  const percent = Math.max(0, Math.min(100, 100 - usedPercent));
  const percentLabel =
    percent > 0 && percent < 1
      ? "<1%"
      : percent > 99 && percent < 100
        ? ">99%"
        : `${Math.round(percent)}%`;
  return { percent, percentLabel };
}
