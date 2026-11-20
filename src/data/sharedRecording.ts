import type { SixAxisDataset } from '../types/sixAxis';
import type { HostCommandTrajectory } from './commandMotionParser';
import { injectSoftwarePulse, type SoftwareInterference } from './softwareInterference';
export interface SharedRecording {
  dataset: SixAxisDataset;
  text?: string;
  origin: string;
  baseline?: SixAxisDataset;
  interference?: SoftwareInterference;
  commandTrajectory?: HostCommandTrajectory | null;
  commandTimeOffsetSec?: number;
  commandAlignOrigin?: boolean;
}
let current: SharedRecording | null = null;
let original: SharedRecording | null = null;
const listeners = new Set<(record: SharedRecording) => void>();
export function shareRecording(record: SharedRecording): void {
  const normalized: SharedRecording = {
    ...record,
    commandTrajectory: record.commandTrajectory ?? null,
    commandTimeOffsetSec: record.commandTimeOffsetSec ?? 0,
    commandAlignOrigin: record.commandAlignOrigin ?? true,
  };
  if (normalized.origin !== 'software-interference' && normalized.origin !== 'command-overlay') {
    original = normalized;
  } else if (original) {
    original = {
      ...original,
      commandTrajectory: normalized.commandTrajectory,
      commandTimeOffsetSec: normalized.commandTimeOffsetSec,
      commandAlignOrigin: normalized.commandAlignOrigin,
    };
  }
  current = normalized;
  for (const listener of listeners) listener(normalized);
}
export function setHostCommandOverlay(
  commandTrajectory: HostCommandTrajectory | null,
  commandTimeOffsetSec?: number,
  commandAlignOrigin?: boolean
): void {
  if (!current) return;
  shareRecording({
    ...current,
    origin: 'command-overlay',
    commandTrajectory,
    commandTimeOffsetSec: commandTimeOffsetSec ?? current.commandTimeOffsetSec ?? 0,
    commandAlignOrigin: commandAlignOrigin ?? current.commandAlignOrigin ?? true,
  });
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
