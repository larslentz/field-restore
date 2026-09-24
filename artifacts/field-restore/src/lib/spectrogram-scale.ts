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

export function anchoredFrequencyViewMin(
  grabbedFrequency: number,
  pointerY: number,
  paneHeight: number,
  span: number,
  nyquist: number,
) {
  const boundedSpan = Math.min(span, nyquist);
  const unclamped = grabbedFrequency - (1 - pointerY / Math.max(1, paneHeight)) * boundedSpan;
  return Math.max(0, Math.min(nyquist - boundedSpan, unclamped));
}

export function frequencyScaleTicks(minimum: number, maximum: number, height: number) {
  const span = maximum - minimum;
  const targetStep = span / Math.max(1, height / 38);
  const step = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find((candidate) => candidate >= targetStep) ?? 20000;
  const ticks: { frequency: number; y: number }[] = [];
  for (let frequency = Math.ceil(minimum / step) * step; frequency <= maximum; frequency += step) {
    ticks.push({ frequency, y: ((maximum - frequency) / span) * height });
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