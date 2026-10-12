import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { deflateSync, inflateSync } from 'node:zlib';
import { getGlobalSingleton, getMainCarrier, parseEnvelope, SDK_VERSION } from '@sentry/core';
import type { Envelope } from '@sentry/core';
import { installPolyfills } from '../src/polyfills';
import { encodeUtf8 } from '../src/utf8';
import { MiniappClient } from '../src/client';
import { createMiniappOfflineStore } from '../src/transports/offlineStore';
import { resetConsentState } from '../src/consent';
import { resetPlatformCache } from '../src/crossPlatform';

describe('miniapp UTF-8 encoding', () => {
  it.each([
    '',
    '\0\nASCII',
    '\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff',
    '中文与 emoji ✅😀𐀀\udbff\udfff',
    '\ud800A\udfff\ud800\ud800\udc00\udfff',
  ])('matches standard UTF-8, including replacement of unpaired surrogates: %j', (input) => {
    expect(Buffer.from(encodeUtf8(input))).toEqual(Buffer.from(input, 'utf8'));
  });

  let originalEncoder: PropertyDescriptor | undefined;
  let originalPolyfill: ((input: string) => Uint8Array) | undefined;
  const carrier = getMainCarrier().__SENTRY__![SDK_VERSION]!;
  beforeEach(() => {
    originalEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    originalPolyfill = carrier.encodePolyfill;
    delete carrier.encodePolyfill;
  });
  afterEach(() => {
    if (originalEncoder) Object.defineProperty(globalThis, 'TextEncoder', originalEncoder);
    else Reflect.deleteProperty(globalThis, 'TextEncoder');
    if (originalPolyfill) carrier.encodePolyfill = originalPolyfill;
    else delete carrier.encodePolyfill;
    resetPlatformCache();
    resetConsentState();
  });
  const removeEncoder = (): void => {
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  };

  it('registers only the official core hook, retaining an existing encoder override', () => {
    const native = globalThis.TextEncoder;
    installPolyfills();
    expect(globalThis.TextEncoder).toBe(native);
    expect(carrier.encodePolyfill).toBeUndefined();
    removeEncoder();
    const supplied = jest.fn(encodeUtf8);
    getGlobalSingleton('encodePolyfill', () => supplied);
    installPolyfills();
    expect(carrier.encodePolyfill).toBe(supplied);
    expect(globalThis.TextEncoder).toBeUndefined();
  });

  it.each(['online', 'consent', 'offline'] as const)(
    'delivers compressed binary through the real SDK %s path without TextEncoder',
    async (mode) => {
      removeEncoder();
      installPolyfills();
      expect(globalThis.TextEncoder).toBeUndefined();
      const events = JSON.stringify([
        { type: 5, timestamp: 1, data: { text: '中文✅😀'.repeat(100) } },
      ]);
      const replayId = 'a'.repeat(32);
      const recordings = [0, 1].map(
        (segment) =>
          new Uint8Array(
            Buffer.concat([
              Buffer.from(JSON.stringify({ segment_id: segment }) + '\n'),
              deflateSync(Buffer.from(events)),
            ]),
          ),
      );
      const envelopes: Envelope[] = recordings.map((recording, segment) => [
        { event_id: replayId },
        [
          [
            { type: 'replay_event' },
            {
              replay_id: replayId,
              segment_id: segment,
              replay_type: 'session',
              urls: [],
              error_ids: [],
              trace_ids: [],
              segment_names: [],
              tags: { title: '中文✅😀' },
            },
          ],
          [{ type: 'replay_recording', length: recording.length }, recording],
        ],
      ]);
      const bodies: ArrayBuffer[] = [];
      const storage = new Map<string, string>();
      let failNext = mode === 'offline';
      const request = jest.fn(
        (options: {
          data: ArrayBuffer;
          success(result: unknown): void;
          fail(result: unknown): void;
        }) => {
          if (failNext) {
            failNext = false;
            options.fail({ errMsg: 'synthetic offline' });
          } else {
            bodies.push(options.data);
            options.success({ statusCode: 200, header: {} });
          }
        },
      );
      Object.assign((globalThis as typeof globalThis & { wx: object }).wx, {
        request,
        getStorageSync: (key: string) => storage.get(key),
        setStorageSync: (key: string, value: string) => storage.set(key, value),
        removeStorageSync: (key: string) => storage.delete(key),
      });
      resetPlatformCache();
      const dsn = 'https://public@ingest.example.test/1';
      const client = new MiniappClient({
        dsn,
        defaultIntegrations: false,
        integrations: [],
        sendClientReports: false,
        enableSystemInfo: false,
        requireConsent: mode === 'consent',
      });
      try {
        for (const envelope of envelopes) await client.sendEnvelope(envelope);
        if (mode !== 'online') {
          expect(bodies).toHaveLength(0);
          expect(storage.size).toBe(1);
          const stored = await createMiniappOfflineStore({
            storageKey: `sentry_offline_store:${encodeURIComponent(dsn)}`,
            recordDroppedEvent: () => {},
          }).peek();
          expect(stored?.[1][0]?.[1]).toEqual(envelopes[0]![1][0]![1]);
          expect(stored?.[1][1]?.[1]).toEqual(recordings[0]);
          expect(stored?.[1][1]?.[1]).toBeInstanceOf(Uint8Array);
        }
        if (mode === 'consent') {
          expect(request).not.toHaveBeenCalled();
          client.setConsent(true);
        }
        expect(await client.flush(1000)).toBe(true);
        expect(request).toHaveBeenCalledTimes(mode === 'offline' ? 3 : 2);
        expect(bodies).toHaveLength(2);
        for (const [index, body] of bodies.entries()) {
          expect(body).toBeInstanceOf(ArrayBuffer);
          const decoded = parseEnvelope(new Uint8Array(body));
          expect(decoded[1][0]![1]).toEqual(envelopes[index]![1][0]![1]);
          const payload = decoded[1][1]![1] as Uint8Array;
          expect(decoded[1][1]![0].length).toBe(recordings[index]!.byteLength);
          expect(payload).toEqual(recordings[index]);
          const split = payload.indexOf(10);
          expect(JSON.parse(Buffer.from(payload.subarray(0, split)).toString())).toEqual({
            segment_id: index,
          });
          expect(inflateSync(payload.subarray(split + 1)).toString()).toBe(events);
        }
        expect([...storage.values()].every((value) => JSON.parse(value).length === 0)).toBe(true);
      } finally {
        await client.close(0);
      }
    },
  );
});
