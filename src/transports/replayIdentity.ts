import type { Envelope } from '@sentry/core';

export function replayIdentity(envelope: Envelope): { id: string; segment: number } | undefined {
  for (const [header, payload] of envelope[1]) {
    if (header.type !== 'replay_event' || !payload || typeof payload !== 'object') continue;
    const event = payload as unknown as Record<string, unknown>;
    const id = event['replay_id'];
    const segment = event['segment_id'];
    if (
      typeof id === 'string' &&
      /^[a-f0-9]{32}$/i.test(id) &&
      typeof segment === 'number' &&
      Number.isSafeInteger(segment) &&
      segment >= 0
    )
      return { id, segment };
  }
  return undefined;
}
