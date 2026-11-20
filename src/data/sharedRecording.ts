import type { SixAxisDataset } from '../types/sixAxis';
import { injectSoftwarePulse, type SoftwareInterference } from './softwareInterference';
export interface SharedRecording { dataset: SixAxisDataset; text?: string; origin: string; baseline?: SixAxisDataset; interference?: SoftwareInterference }
let current: SharedRecording | null = null;
let original: SharedRecording | null = null;
const listeners = new Set<(record: SharedRecording) => void>();
export function shareRecording(record: SharedRecording): void {
  if (record.origin !== 'software-interference') original = record;
  current = record;
  for (const listener of listeners) listener(record);
}
export function setSoftwareInterference(enabled: boolean): void {
  if (!original) return;
  if (!enabled) { shareRecording({...original, origin:'software-interference'}); return; }
  const branch = injectSoftwarePulse(original.dataset);
  shareRecording({ ...branch, baseline: original.dataset, origin:'software-interference' });
}
export function observeRecording(listener: (record: SharedRecording) => void): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => listeners.delete(listener);
}
