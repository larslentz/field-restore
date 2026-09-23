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

export function anchoredTimeViewStart(
  grabbedTime: number,
  pointerX: number,
  plotWidth: number,
  viewDuration: number,
  totalDuration: number,
) {
  const boundedDuration = Math.max(0, Math.min(totalDuration, viewDuration));
  const pointerRatio = Math.max(0, Math.min(1, pointerX / Math.max(1, plotWidth)));
  const unclamped = grabbedTime - pointerRatio * boundedDuration;
  return Math.max(0, Math.min(totalDuration - boundedDuration, unclamped));
}