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

export function levelScaleTicks(ceiling: number, span: number, height: number) {
  const targetStep = span / Math.max(1, height / 26);
  const step = [1, 2, 5, 10, 20, 50, 100].find((candidate) => candidate >= targetStep) ?? 100;
  const ticks: { level: number; y: number }[] = [];
  for (let level = Math.ceil((ceiling - span) / step) * step; level <= ceiling; level += step) {
    ticks.push({ level, y: ((ceiling - level) / span) * height });
  }
  return ticks;
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