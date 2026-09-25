export type RepairMark = { moduleId: string; frame: number };

export const MAX_REPAIR_MARKS = 1024;

/** Keep one onset per 50 ms per module; bound retained history independently of recording length. */
export function addRepairMark(marks: RepairMark[], mark: RepairMark, sampleRate: number): RepairMark[] {
  if (!Number.isSafeInteger(mark.frame) || mark.frame < 0 || sampleRate <= 0) return marks;
  const bucketFrames = Math.max(1, Math.floor(sampleRate * .05));
  const bucket = Math.floor(mark.frame / bucketFrames);
  const last = marks[marks.length - 1];
  if (last?.moduleId === mark.moduleId && Math.floor(last.frame / bucketFrames) === bucket) return marks;
  if (marks.some((entry) => entry.moduleId === mark.moduleId &&
    Math.floor(entry.frame / bucketFrames) === bucket)) return marks;
  const next = last && mark.frame >= last.frame ? [...marks, mark] :
    [...marks, mark].sort((a, b) => a.frame - b.frame);
  return next.length > MAX_REPAIR_MARKS ? next.slice(-MAX_REPAIR_MARKS) : next;
}