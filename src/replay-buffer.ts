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
  /** Optional cache for immutable input events. Newly folded checkpoints are measured fresh. */
  eventBytes?: (event: TaroReplayEvent) => number;
}
function eventBytes(event: TaroReplayEvent): number {
  return utf8ByteLength(JSON.stringify(event));
}

/** Retain recent checkpoints and fold only evicted increments into the playable baseline. */
export function boundReplayEvents(
  events: TaroReplayEvent[],
  bounds: ReplayBufferBounds,
): TaroReplayEvent[] {
  if (bounds.maxEvents < 2) return [];
  const cutoff = bounds.now - Math.max(0, bounds.windowMs);
  let fullSnapshotIndex = -1;
  for (let index = 0; index < events.length; index++)
    if (events[index]?.type === 2) {
      fullSnapshotIndex = index;
      break;
    }
  if (fullSnapshotIndex < 0) return [];
  let metaIndex = fullSnapshotIndex - 1;
  while (metaIndex >= 0 && events[metaIndex]?.type !== 4) metaIndex--;
  let meta = metaIndex >= 0 ? events[metaIndex] : undefined;
  let initial = events[fullSnapshotIndex]!;
  let rebaser = createCheckpointRebaser(initial);
  const tail = events.slice(fullSnapshotIndex + 1);
  const measure = bounds.eventBytes ?? eventBytes;
  let tailBytes = tail.reduce((sum, event) => sum + measure(event), 0);
  let offset = 0;
  const evict = (): void => {
    const event = tail[offset++]!;
    tailBytes -= measure(event);
    if (event.type === 4) meta = event;
    else if (event.type === 2) {
      initial = event;
      rebaser = createCheckpointRebaser(initial);
    } else if (event.type === 3 && event.data['source'] === 4 && meta) {
      meta = {
        ...meta,
        data: { ...meta.data, width: event.data['width'], height: event.data['height'] },
      };
    } else rebaser.apply(event);
  };
  while (offset < tail.length && tail[offset]!.timestamp < cutoff) {
    evict();
    if (tail[offset - 1]?.type === 4 && tail[offset]?.type === 2) evict();
  }
  const checkpoint = (): TaroReplayEvent[] => {
    const snapshot = rebaser.getSnapshot();
    const alignedMeta =
      meta && meta.timestamp !== snapshot.timestamp - 1
        ? { ...meta, timestamp: snapshot.timestamp - 1 }
        : meta;
    return [...(alignedMeta ? [alignedMeta] : []), snapshot];
  };
  let baseline = checkpoint();
  const baselineBytes = (): number =>
    baseline.reduce(
      (sum, event) =>
        sum +
        (event === rebaser.getSnapshot() && event !== initial ? eventBytes(event) : measure(event)),
      0,
    );
  let bytes = baselineBytes() + tailBytes;
  while (
    offset < tail.length &&
    (baseline.length + tail.length - offset > bounds.maxEvents || bytes > bounds.maxBytes)
  ) {
    evict();
    // A navigation Meta must stay with its following snapshot, never with the old DOM.
    if (tail[offset - 1]?.type === 4 && tail[offset]?.type === 2) evict();
    baseline = checkpoint();
    bytes = baselineBytes() + tailBytes;
  }
  return bytes > bounds.maxBytes || baseline.length > bounds.maxEvents
    ? []
    : [...baseline, ...tail.slice(offset)];
}
