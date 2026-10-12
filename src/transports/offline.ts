import {
  disabledUntil,
  envelopeItemTypeToDataCategory,
  serializeEnvelope,
  updateRateLimits,
} from '@sentry/core';
import type {
  BaseTransportOptions,
  Envelope,
  Transport,
  TransportMakeRequestResponse,
} from '@sentry/core';
import { createMiniappOfflineStore, type MiniappOfflineStoreOptions } from './offlineStore';
import { replayIdentity } from './replayIdentity';

interface OfflineOptions {
  store: MiniappOfflineStoreOptions;
  shouldSend: () => boolean;
  recordDroppedEvent: BaseTransportOptions['recordDroppedEvent'];
  /** Custom transports retain their own success contract. Native transport requires HTTP ACK. */
  requireHttpStatus: boolean;
}
interface Job {
  envelope: Envelope;
  bytes: number;
  settled?: boolean;
  resolve: (result: TransportMakeRequestResponse) => void;
  reject: (error: unknown) => void;
}
const START_DELAY = 5000;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_REPLAY_CHAINS = 64;

/** One sender and one bounded persistent queue, shared by errors, Replay and consent. */
export function createMiniappOfflineTransport(
  base: Transport,
  options: OfflineOptions,
): Transport & { stop(): void } {
  let closed = false;
  let running: Promise<void> | undefined;
  let wakeAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;
  let retryDelay = START_DELAY;
  let rateLimits: Record<string, number> = {};
  let pendingBytes = 0;
  let active: { envelope: Envelope; job?: Job; stored: boolean } | undefined;
  const jobs: Job[] = [];
  const nextSegments = new Map<string, number>();
  const cutoffs = new Map<string, number>();
  const chains = new Set<string>();
  function reserveChain(id: string): void {
    if (!chains.has(id) && chains.size >= MAX_REPLAY_CHAINS) {
      const oldest = chains.values().next().value!;
      chains.delete(oldest);
      nextSegments.delete(oldest);
      cutoffs.delete(oldest);
    }
    chains.add(id);
  }
  let backlog = true; // Unknown until the first read, including persisted data from a previous run.

  function loss(envelope: Envelope): void {
    const identity = replayIdentity(envelope);
    if (identity) {
      reserveChain(identity.id);
      cutoffs.set(identity.id, Math.min(cutoffs.get(identity.id) ?? Infinity, identity.segment));
    }
    if (!envelope[1].some(([header]) => header.type === 'client_report')) {
      for (const [header] of envelope[1]) {
        try {
          options.recordDroppedEvent('send_error', envelopeItemTypeToDataCategory(header.type));
        } catch {
          /* observational */
        }
      }
    }
  }
  const store = createMiniappOfflineStore({
    ...options.store,
    strictPersistence: true,
    protectReplayOrder: true,
    onDiscardEnvelope: loss,
  });
  function validPrefix(envelope: Envelope): boolean {
    const identity = replayIdentity(envelope);
    if (!identity) return true;
    if (identity.segment >= (cutoffs.get(identity.id) ?? Infinity)) return false;
    // No persisted ACK ledger: on restart, a suffix without a replayable prefix is discarded.
    return identity.segment <= (nextSegments.get(identity.id) ?? 0);
  }
  function acknowledged(envelope: Envelope): void {
    const identity = replayIdentity(envelope);
    if (!identity) return;
    reserveChain(identity.id);
    nextSegments.set(
      identity.id,
      Math.max(nextSegments.get(identity.id) ?? 0, identity.segment + 1),
    );
  }
  function release(job: Job): void {
    pendingBytes -= job.bytes;
  }
  function schedule(delay: number): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        void wake();
      },
      Math.max(1, delay),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  async function persistJob(job: Job, first = false): Promise<void> {
    if (job.settled) return;
    job.settled = true;
    try {
      if (job.envelope[1].some(([header]) => header.type === 'client_report'))
        throw new Error('Client reports are not persisted');
      const identity = replayIdentity(job.envelope);
      if (identity && identity.segment >= (cutoffs.get(identity.id) ?? Infinity))
        throw new Error('Replay prefix was discarded');
      await (first ? store.unshift(job.envelope) : store.push(job.envelope));
      backlog = true;
      job.resolve({});
    } catch (error) {
      loss(job.envelope);
      job.reject(error);
    } finally {
      release(job);
    }
  }
  async function persistPending(force = false): Promise<void> {
    while (jobs.length && !closed && (force || !options.shouldSend() || Date.now() < retryAt)) {
      await persistJob(jobs.shift()!);
    }
  }
  async function run(): Promise<void> {
    while (!closed) {
      if (!options.shouldSend() || Date.now() < retryAt) {
        await persistPending();
        if (options.shouldSend()) schedule(retryAt - Date.now());
        return;
      }
      let envelope: Envelope | undefined;
      try {
        envelope = await store.peek();
      } catch {
        await persistPending(true);
        schedule(START_DELAY);
        return;
      }
      if (closed) return;
      backlog = !!envelope;
      const stored = !!envelope;
      const job = stored ? undefined : jobs.shift();
      envelope ??= job?.envelope;
      if (!envelope) return;
      active = { envelope, stored, ...(job ? { job } : {}) };
      if (!validPrefix(envelope)) {
        loss(envelope);
        if (stored) await store.remove(envelope);
        if (job) {
          release(job);
          job.reject(new Error('Replay prefix is unavailable'));
        }
        active = undefined;
        continue;
      }
      const rateUntil = Math.max(
        0,
        ...envelope[1].map(([header]) =>
          disabledUntil(rateLimits, envelopeItemTypeToDataCategory(header.type)),
        ),
      );
      if (rateUntil > Date.now()) {
        if (job) await persistJob(job);
        active = undefined;
        await persistPending(true);
        schedule(rateUntil - Date.now());
        return;
      }
      if (!options.shouldSend()) {
        if (job) await persistJob(job);
        active = undefined;
        await persistPending();
        return;
      }
      let response: TransportMakeRequestResponse | undefined;
      let failure: unknown;
      try {
        response = await base.send(
          stored
            ? ([{ ...envelope[0], sent_at: new Date().toISOString() }, envelope[1]] as Envelope)
            : envelope,
        );
      } catch (error) {
        failure = error;
      }
      if (closed) return; // stop() already retained any fresh in-flight work; no stale owner writes.
      if (response) rateLimits = updateRateLimits(rateLimits, response);
      const status = response?.statusCode;
      const success =
        !failure &&
        ((status !== undefined && status >= 200 && status < 300) ||
          (!options.requireHttpStatus && status === undefined));
      const retryable = !!failure || status === 429 || (status !== undefined && status >= 500);
      if (success) {
        acknowledged(envelope);
        if (stored) await store.remove(envelope);
        if (job) {
          release(job);
          job.resolve(response!);
        }
        retryDelay = START_DELAY;
      } else if (retryable && !envelope[1].some(([header]) => header.type === 'client_report')) {
        if (job) await persistJob(job);
        retryAt = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 3600000);
        active = undefined;
        await persistPending();
        schedule(retryDelay / 2);
        return;
      } else {
        // A core {} result is a drop (rate-limit/buffer-full), never a native HTTP ACK.
        loss(envelope);
        if (stored) await store.remove(envelope);
        if (job) {
          release(job);
          if (status !== undefined && response) job.resolve(response);
          else job.reject(failure ?? new Error('Envelope not acknowledged (dropped)'));
        }
      }
      active = undefined;
    }
  }
  function wake(): Promise<void> {
    if (running) {
      wakeAgain = true;
      return running;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = run()
      .catch(() => {
        active = undefined;
        if (!closed) {
          retryAt = Date.now() + retryDelay;
          schedule(retryDelay);
          retryDelay = Math.min(retryDelay * 2, 3600000);
        }
      })
      .finally(() => {
        running = undefined;
        const restart = wakeAgain && jobs.length > 0;
        wakeAgain = false;
        if (restart && !closed) void wake();
      });
    return running;
  }
  schedule(START_DELAY);
  return {
    send(envelope) {
      if (closed) return Promise.reject(new Error('Transport is closed'));
      const serialized = serializeEnvelope(envelope);
      const bytes = typeof serialized === 'string' ? utf8Bytes(serialized) : serialized.byteLength;
      if (jobs.length >= 64 || pendingBytes + bytes > MAX_PENDING_BYTES) {
        loss(envelope);
        return Promise.reject(new Error('Pending transport queue capacity exceeded'));
      }
      pendingBytes += bytes;
      const result = new Promise<TransportMakeRequestResponse>((resolve, reject) =>
        jobs.push({ envelope, bytes, resolve, reject }),
      );
      void wake();
      return result;
    },
    async flush(timeout = START_DELAY) {
      const deadline = Date.now() + Math.max(0, timeout);
      if (closed)
        return !active && !jobs.length && !backlog && (await base.flush(Math.max(0, timeout)));
      if (timeout <= 0) return false;
      const drain = (async () => {
        if (running) await running;
        if (closed || Date.now() >= deadline) return;
        retryAt = 0; // Explicit retry never overrides the independent category rate limits.
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        await wake();
      })();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        drain.then(() => true),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (!completed || active || jobs.length || backlog) return false;
      const remaining = deadline - Date.now();
      return remaining > 0 && (await base.flush(remaining));
    },
    stop() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      // Storage operations execute synchronously before their Promise settles. No retry owner survives close.
      if (active?.job) void persistJob(active.job, true);
      for (const job of jobs.splice(0)) void persistJob(job);
    },
  };
}
function utf8Bytes(value: string): number {
  let size = 0;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}
