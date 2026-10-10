import { createCheckpointRebaser } from './rebase';
import type { TaroReplayPocEvent as TaroReplayEvent } from './replay-poc';

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export interface ReplayBufferBounds {
  now: number;
  windowMs: number;
  maxEvents: number;
  maxBytes: number;
}
function eventBytes(event: TaroReplayEvent): number {
  return utf8ByteLength(JSON.stringify(event));
}

/** Evicted DOM events are folded into a cloned baseline before retaining the playable tail. */
export function boundReplayEvents(
  events: TaroReplayEvent[],
  bounds: ReplayBufferBounds,
): TaroReplayEvent[] {
  if (bounds.maxEvents < 2) return [];
  const cutoff = bounds.now - Math.max(0, bounds.windowMs);
  let fullSnapshotIndex = -1;
  for (let index = events.length - 1; index >= 0; index--)
    if (events[index]?.type === 2) {
      fullSnapshotIndex = index;
      break;
    }
  if (fullSnapshotIndex < 0) return [];
  let metaIndex = fullSnapshotIndex - 1;
  while (metaIndex >= 0 && events[metaIndex]?.type !== 4) metaIndex--;
  const meta = metaIndex >= 0 ? events[metaIndex] : undefined;
  const initial = events[fullSnapshotIndex]!;
  const rebaser = createCheckpointRebaser(initial);
  const tail: TaroReplayEvent[] = [];
  for (const event of events.slice(fullSnapshotIndex + 1)) {
    if (event.type === 4 || event.type === 2) continue;
    if (event.timestamp < cutoff) rebaser.apply(event);
    else tail.push(event);
  }
  const checkpoint = (): TaroReplayEvent[] => {
    const snapshot = rebaser.getSnapshot();
    const alignedMeta =
      meta && snapshot !== initial ? { ...meta, timestamp: snapshot.timestamp - 1 } : meta;
    return [...(alignedMeta ? [alignedMeta] : []), snapshot, ...tail];
  };
  let bounded = checkpoint();
  let bytes = bounded.reduce((sum, event) => sum + eventBytes(event), 0);
  while (tail.length && (bounded.length > bounds.maxEvents || bytes > bounds.maxBytes)) {
    rebaser.apply(tail.shift()!);
    bounded = checkpoint();
    bytes = bounded.reduce((sum, event) => sum + eventBytes(event), 0);
  }
  return bytes > bounds.maxBytes ? [] : bounded;
}
