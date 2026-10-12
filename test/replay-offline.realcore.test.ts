import { MiniappClient } from '../src/client';
import type { Envelope } from '@sentry/core';
import { resetPlatformCache } from '../src/crossPlatform';
import { _resetAppLifecycle } from '../src/appLifecycle';

const g = globalThis as any;
let storage: Record<string, string>;
let sent: string[];
let clients: MiniappClient[];
function replay(segment: number, size = 490000): Envelope {
  return [
    { event_id: 'a'.repeat(32) },
    [
      [
        { type: 'replay_event' },
        {
          replay_id: 'a'.repeat(32),
          segment_id: segment,
          type: 'replay_event',
          replay_type: 'session',
          urls: [],
          error_ids: [],
          trace_ids: [],
          segment_names: [],
          timestamp: 1640995200 + segment,
        },
      ],
      [
        { type: 'replay_recording', length: size + 100 },
        JSON.stringify({ segment_id: segment }) +
          '\n' +
          JSON.stringify([
            {
              type: segment === 0 ? 2 : 3,
              timestamp: 1640995200000,
              data: { synthetic: 'a'.repeat(size) },
            },
          ]),
      ],
    ],
  ];
}
function initialize(options: ConstructorParameters<typeof MiniappClient>[0] = {}) {
  const client = new MiniappClient({
    dsn: 'https://public@ingest.example.test/1',
    enableSystemInfo: false,
    ...options,
  });
  clients.push(client);
  return client;
}
beforeEach(() => {
  storage = {};
  sent = [];
  clients = [];
  g.wx = {
    request: jest.fn((options) => {
      sent.push(String(options.data));
      options.success({ statusCode: 200 });
    }),
    setStorageSync: jest.fn((key: string, value: string) => {
      if (Buffer.byteLength(value) > 1024 * 1024) throw new Error('storage limit');
      storage[key] = value;
    }),
    getStorageSync: jest.fn((key: string) => storage[key]),
    removeStorageSync: jest.fn((key: string) => {
      delete storage[key];
    }),
  };
  resetPlatformCache();
  _resetAppLifecycle();
  jest.useFakeTimers();
});
afterEach(async () => {
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const client of clients) await client.close(0);
  resetPlatformCache();
  _resetAppLifecycle();
});

test('default offline transport preserves both 490KB Replay segments sent before its 100ms drain', async () => {
  const client = initialize();
  await client.getTransport()!.send(replay(0));
  await client.getTransport()!.send(replay(1));
  await jest.advanceTimersByTimeAsync(500);
  const segments = sent
    .filter((body) => body.includes('replay_recording'))
    .map((body) => JSON.parse(body.split('\n')[2]!).segment_id);
  expect(segments).toEqual([0, 1]);
  expect(Object.values(storage).every((value) => Buffer.byteLength(value) <= 900 * 1024)).toBe(
    true,
  );
});

async function tick() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function segments() {
  return sent
    .filter((body) => body.includes('replay_recording'))
    .map((body) => JSON.parse(body.split('\n')[2]!).segment_id);
}
function saved() {
  return Object.values(storage).flatMap((value) => JSON.parse(value));
}
function errorEnvelope(id: string): Envelope {
  return [
    { event_id: id, sent_at: new Date().toISOString() },
    [[{ type: 'event' }, { event_id: id, message: 'synthetic error' }]],
  ];
}

test('concurrent large Replay sends wait for native ACK and flush waits for both requests', async () => {
  const pending: any[] = [];
  g.wx.request.mockImplementation((options: any) => {
    sent.push(options.data);
    pending.push(options);
  });
  const transport = initialize().getTransport()!;
  const first = transport.send(replay(0));
  const second = transport.send(replay(1));
  await tick();
  expect(segments()).toEqual([0]);
  expect(saved()).toEqual([]);
  const flush = transport.flush(20);
  await jest.advanceTimersByTimeAsync(20);
  expect(await flush).toBe(false);
  pending.shift().success({ statusCode: 200 });
  await first;
  await tick();
  expect(segments()).toEqual([0, 1]);
  pending.shift().success({ statusCode: 200 });
  await second;
  expect(await transport.flush(100)).toBe(true);
  expect(saved()).toEqual([]);
});

test('failed prefix stays persisted while a newer suffix waits, then retry drains FIFO', async () => {
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.fail({ errMsg: 'offline' });
  });
  const transport = initialize().getTransport()!;
  await transport.send(replay(0, 500));
  await transport.send(replay(1, 500));
  expect(segments()).toEqual([0]);
  expect(saved().map((item: any) => item.envelope[1][0][1].segment_id)).toEqual([0, 1]);
  expect(await transport.flush(100)).toBe(true);
  expect(segments()).toEqual([0, 0, 1]);
  expect(saved()).toEqual([]);
});

test('capacity rejection never evicts the Replay prefix or permits later suffixes through client.sendEnvelope', async () => {
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.fail({ errMsg: 'offline' });
  });
  const client = initialize();
  await client.sendEnvelope(replay(0));
  await client.sendEnvelope(replay(1)); // core consumes transport rejection: scheduler still blocks this chain.
  await client.sendEnvelope(replay(2, 500));
  expect(segments()).toEqual([0]);
  expect(saved().map((item: any) => item.envelope[1][0][1].segment_id)).toEqual([0]);
  expect(await client.getTransport()!.flush(100)).toBe(true);
  await client.sendEnvelope(replay(3, 500));
  expect(segments()).toEqual([0, 0]);
  expect(Object.values(storage).every((value) => Buffer.byteLength(value) <= 900 * 1024)).toBe(
    true,
  );
});

test('consent shares one FIFO for errors and Replay and checks again after async storage reads', async () => {
  const client = initialize({ requireConsent: true });
  const transport = client.getTransport()!;
  await transport.send(errorEnvelope('first'));
  await transport.send(replay(0, 500));
  await transport.send(errorEnvelope('last'));
  expect(sent).toEqual([]);
  expect(await transport.flush(100)).toBe(false);
  let revoke = true;
  g.wx.getStorageSync.mockImplementation((key: string) => {
    if (revoke) {
      revoke = false;
      client.setConsent(false);
    }
    return storage[key];
  });
  client.setConsent(true);
  await tick();
  expect(sent).toEqual([]);
  client.setConsent(true);
  await tick();
  expect(sent.map((body) => JSON.parse(body.split('\n')[0]!).event_id)).toEqual([
    'first',
    'a'.repeat(32),
    'last',
  ]);
  expect(await transport.flush(100)).toBe(true);
});

test('close retains fresh in-flight work and prevents old owner from sending the next segment', async () => {
  const pending: any[] = [];
  g.wx.request.mockImplementation((options: any) => {
    sent.push(options.data);
    pending.push(options);
  });
  const client = initialize();
  const first = client.getTransport()!.send(replay(0, 500));
  const second = client.getTransport()!.send(replay(1, 500));
  await tick();
  const closing = client.close(0);
  await tick();
  pending.shift().success({ statusCode: 200 });
  await jest.advanceTimersByTimeAsync(20);
  await Promise.all([first, second, closing]);
  await jest.advanceTimersByTimeAsync(10000);
  expect(segments()).toEqual([0]);
  expect(saved()).toHaveLength(2);
  g.wx.request.mockImplementation((options: any) => {
    sent.push(options.data);
    options.success({ statusCode: 200 });
  });
  expect(await initialize().getTransport()!.flush(100)).toBe(true);
  expect(segments()).toEqual([0, 0, 1]);
});

test('429 Retry-After remains authoritative during explicit flush and preserves the prefix', async () => {
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.success({ statusCode: 429, header: { 'Retry-After': '2' } });
  });
  const transport = initialize().getTransport()!;
  await transport.send(replay(0, 500));
  await transport.send(replay(1, 500));
  expect(await transport.flush(100)).toBe(false);
  expect(segments()).toEqual([0]);
  await jest.advanceTimersByTimeAsync(1999);
  expect(segments()).toEqual([0]);
  await jest.advanceTimersByTimeAsync(1);
  expect(segments()).toEqual([0, 0, 1]);
  expect(saved()).toEqual([]);
});

test.each([400, 413, undefined])(
  'permanent or missing native ACK (%s) blocks all dependent segments',
  async (statusCode) => {
    g.wx.request.mockImplementationOnce((options: any) => {
      sent.push(options.data);
      options.success({ statusCode });
    });
    const transport = initialize().getTransport()!;
    if (statusCode === undefined)
      await expect(transport.send(replay(0, 500))).rejects.toThrow('not acknowledged');
    else expect((await transport.send(replay(0, 500))).statusCode).toBe(statusCode);
    await expect(transport.send(replay(1, 500))).rejects.toThrow('prefix');
    expect(segments()).toEqual([0]);
    expect(saved()).toEqual([]);
  },
);

test('storage failure is explicit and never permits an orphan, even when core swallows the rejection', async () => {
  g.wx.setStorageSync.mockImplementation(() => {
    throw new Error('quota');
  });
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.fail({ errMsg: 'offline' });
  });
  const client = initialize();
  await client.sendEnvelope(replay(0, 500));
  await client.sendEnvelope(replay(1, 500));
  await jest.advanceTimersByTimeAsync(10000);
  expect(segments()).toEqual([0]);
});

test('more than 64 independent Replay sessions can start without unbounded chain state', async () => {
  const transport = initialize().getTransport()!;
  for (let index = 0; index < 70; index++) {
    const envelope = replay(0, 20);
    (envelope[1][0]![1] as any).replay_id = index.toString(16).padStart(32, '0');
    await transport.send(envelope);
  }
  expect(segments()).toHaveLength(70);
});

test('restored suffix without an ACK ledger is discarded; retry timestamps are refreshed without retaining ACKed data', async () => {
  const key = 'sentry_offline_store:' + encodeURIComponent('https://public@ingest.example.test/1');
  const first = replay(0, 100);
  first[0].sent_at = '2001-01-01T00:00:00.000Z';
  storage[key] = JSON.stringify([
    { envelope: replay(2, 100), timestamp: Date.now() },
    { envelope: errorEnvelope('preserved-error'), timestamp: Date.now() },
  ]);
  const client = initialize();
  expect(await client.getTransport()!.flush(100)).toBe(true);
  expect(segments()).toEqual([]);
  expect(sent).toHaveLength(1);
  const next = initialize({ dsn: 'https://public@ingest.example.test/2' });
  const otherKey =
    'sentry_offline_store:' + encodeURIComponent('https://public@ingest.example.test/2');
  storage[otherKey] = JSON.stringify([{ envelope: first, timestamp: Date.now() }]);
  expect(await next.getTransport()!.flush(100)).toBe(true);
  expect(JSON.parse(sent[1]!.split('\n')[0]!).sent_at).toBe(new Date().toISOString());
  expect(JSON.parse(storage[otherKey]!)).toEqual([]);
});

test('expired store is cleared, client reports are not retried, and pending memory remains bounded', async () => {
  const key = 'sentry_offline_store:' + encodeURIComponent('https://public@ingest.example.test/1');
  storage[key] = JSON.stringify([{ envelope: replay(0, 100), timestamp: Date.now() - 86400001 }]);
  const transport = initialize().getTransport()!;
  expect(await transport.flush(100)).toBe(true);
  expect(JSON.parse(storage[key]!)).toEqual([]);
  await expect(transport.send(replay(0, 2 * 1024 * 1024))).rejects.toThrow('capacity');
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.fail({ errMsg: 'offline' });
  });
  const report: Envelope = [
    {},
    [[{ type: 'client_report' }, { timestamp: 1, discarded_events: [] }]],
  ];
  await expect(transport.send(report)).rejects.toThrow();
  await jest.advanceTimersByTimeAsync(10000);
  expect(sent).toHaveLength(1);
  expect(saved()).toEqual([]);
});

test('optional consent changes cannot disable a client that did not require consent', async () => {
  const client = initialize();
  client.setConsent(false);
  expect(client.getConsent()).toBe(true);
  await client.getTransport()!.send(replay(0, 100));
  expect(segments()).toEqual([0]);
});

test('failure to remove an acknowledged backlog entry backs off instead of busy-looping', async () => {
  const key = 'sentry_offline_store:' + encodeURIComponent('https://public@ingest.example.test/1');
  storage[key] = JSON.stringify([{ envelope: replay(0, 100), timestamp: Date.now() }]);
  g.wx.setStorageSync.mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  const transport = initialize().getTransport()!;
  const queued = Promise.resolve(transport.send(replay(1, 100))).catch(() => undefined);
  await tick();
  expect(segments()).toEqual([0]);
  await jest.advanceTimersByTimeAsync(4999);
  expect(segments()).toEqual([0]);
  g.wx.setStorageSync.mockImplementation((key: string, value: string) => {
    storage[key] = value;
  });
  await jest.advanceTimersByTimeAsync(1);
  await queued;
  expect(segments()).toEqual([0, 0, 1]);
  expect(saved()).toEqual([]);
});

test('permanent HTTP rejection status survives core sendEnvelope and blocks dependent segments', async () => {
  g.wx.request.mockImplementationOnce((options: any) => {
    sent.push(options.data);
    options.success({ statusCode: 400 });
  });
  const client = initialize();
  expect((await client.sendEnvelope(replay(0, 100)))?.statusCode).toBe(400);
  await client.sendEnvelope(replay(1, 100));
  expect(segments()).toEqual([0]);
});

test('grant during persistence switches large queued successors to ACK-ordered delivery', async () => {
  const client = initialize({ requireConsent: true });
  const transport = client.getTransport()!;
  await transport.send(replay(0));
  client.setConsent(true);
  await transport.send(replay(1));
  expect(await transport.flush(100)).toBe(true);
  expect(segments()).toEqual([0, 1]);
  expect(saved()).toEqual([]);
  expect(
    g.wx.setStorageSync.mock.calls.every(
      ([, value]: [string, string]) => Buffer.byteLength(value) <= 900 * 1024,
    ),
  ).toBe(true);
});
