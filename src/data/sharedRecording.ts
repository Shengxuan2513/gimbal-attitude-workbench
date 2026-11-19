import type { SixAxisDataset } from '../types/sixAxis';
export interface SharedRecording { dataset: SixAxisDataset; text?: string; origin: string }
let current: SharedRecording | null = null;
const listeners = new Set<(record: SharedRecording) => void>();
export function shareRecording(record: SharedRecording): void {
  current = record;
  for (const listener of listeners) listener(record);
}
export function observeRecording(listener: (record: SharedRecording) => void): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => listeners.delete(listener);
}
