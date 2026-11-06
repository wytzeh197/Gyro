/** Keep a disclosure's actions inside its visible scroll area. */
export function providerDetailsPosition({
  anchorTop,
  anchorBottom,
  boundsTop,
  boundsBottom,
  menuHeight,
  prefersUp,
  gap,
}: {
  anchorTop: number;
  anchorBottom: number;
  boundsTop: number;
  boundsBottom: number;
  menuHeight: number;
  prefersUp: boolean;
  gap: number;
}) {
  const margin = 8;
  const above = Math.max(0, anchorTop - gap - boundsTop - margin);
  const below = Math.max(0, boundsBottom - margin - anchorBottom - gap);
  const preferredSpace = prefersUp ? above : below;
  const otherSpace = prefersUp ? below : above;
  const opensUp =
    preferredSpace >= menuHeight || preferredSpace >= otherSpace
      ? prefersUp
      : !prefersUp;
  const maxHeight = opensUp ? above : below;
  const height = Math.min(menuHeight, maxHeight);
  return {
    top: opensUp ? anchorTop - gap - height : anchorBottom + gap,
    maxHeight,
  };
}
