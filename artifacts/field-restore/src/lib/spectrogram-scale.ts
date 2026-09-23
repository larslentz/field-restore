export function anchoredLevelScaleCeiling(
  grabbedLevel: number,
  pointerY: number,
  paneHeight: number,
  span: number,
  minimumLevel: number,
  maximumLevel: number,
) {
  const unclamped = grabbedLevel + (pointerY / Math.max(1, paneHeight)) * span;
  return Math.max(minimumLevel + span, Math.min(maximumLevel, unclamped));
}