import * as Sentry from '../src/index';
import { installedIntegrations } from '@sentry/core';
import type { Envelope } from '@sentry/core';
import { resetPlatformCache } from '../src/crossPlatform';
import { _resetAppLifecycle } from '../src/appLifecycle';
import { createMiniappOfflineStore } from '../src/transports/offlineStore';
import { createMiniappTransport } from '../src/transports/xhr';

const g = globalThis as any;
let envelopes: Envelope[];
let storage: Record<string, string>;
const items = (type: string): any[] => {
  const result: unknown[] = [];
  for (const envelope of envelopes)
    for (const item of envelope[1]) if (item[0].type === type) result.push(item[1]);
  return result;
};
function initialize(options: Sentry.MiniappOptions = {}) {
  return Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    defaultIntegrations: false,
    enableAutoSessionTracking: false,
    enableNavigationBreadcrumbs: false,
    enableUserInteractionBreadcrumbs: false,
    enableNetworkStatusMonitoring: false,
    enableSourceMap: false,
    enableOfflineCache: false,
    transport: () => ({
      send: async (env) => {
        envelopes.push(env);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    ...options,
  })!;
}

beforeEach(() => {
  envelopes = [];
  storage = {};
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
  g.Page = jest.fn((config) => config);
  g.App = jest.fn((config) => config);
  Object.assign(g.wx, {
    request: jest.fn(),
    setStorageSync: (key: string, value: string) => {
      storage[key] = value;
    },
    getStorageSync: (key: string) => storage[key],
    removeStorageSync: (key: string) => {
      delete storage[key];
    },
  });
  resetPlatformCache();
});
afterEach(async () => {
  jest.useRealTimers();
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  delete g.Page;
  delete g.App;
  _resetAppLifecycle();
  jest.useRealTimers();
});

test('initialScope, errors of every JS value, causes, attachments and client reports use real core pipeline', async () => {
  const client = initialize({
    integrations: [new Sentry.Integrations.LinkedErrors()],
    initialScope: { tags: { 'build.commit': 'local' }, user: { id: 'synthetic' } },
    release: 'local-review',
    dist: 'local-sha',
    beforeSend: (event) => (event.message === 'drop-me' ? null : event),
  });
  for (const value of [null, undefined, 42, { message: 'structured' }])
    Sentry.captureException(value);
  const cause = new Error('inner');
  const outer = Object.assign(new Error('outer'), { cause });
  Sentry.captureException(outer, {
    attachments: [{ filename: 'test.bin', data: new Uint8Array([0, 255, 10]) }],
  });
  Sentry.captureMessage('drop-me');
  await client.flush(2000);
  expect(items('event')).toHaveLength(5);
  const event = items('event').find((entry) =>
    entry.exception.values.some((value: any) => value.value === 'outer'),
  );
  expect(event.tags['build.commit']).toBe('local');
  expect(event.dist).toBe('local-sha');
  expect(event.exception.values.map((value: any) => value.value)).toEqual(['inner', 'outer']);
  expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  expect(items('attachment')[0]).toEqual(new Uint8Array([0, 255, 10]));
  // beforeSend resolves asynchronously; another flush reports its outcome.
  await client.flush(2000);
  expect(
    items('client_report').some((entry) =>
      entry.discarded_events.some((outcome: any) => outcome.reason === 'before_send'),
    ),
  ).toBe(true);
});

test('logs and metrics flush real envelopes with scope attributes and processing hooks', async () => {
  const client = initialize({
    enableLogs: true,
    enableMetrics: true,
    beforeSendLog: (log) =>
      log.message === 'drop' ? null : { ...log, attributes: { ...log.attributes, checked: true } },
    beforeSendMetric: (metric) => (metric.name === 'drop' ? null : metric),
  });
  Sentry.setAttribute('build.kind', 'local');
  Sentry.logger.info('kept', { route: 'home' });
  Sentry.logger.info('drop');
  Sentry.metrics.count('events', 2);
  Sentry.metrics.gauge('queue', 3);
  Sentry.metrics.distribution('duration', 12, { unit: 'millisecond' });
  Sentry.metrics.count('drop');
  await client.flush(2000);
  expect(
    items('log')
      .flatMap((entry) => entry.items)
      .map((entry) => entry.body),
  ).toEqual(['kept']);
  expect(items('log')[0].items[0].attributes.checked.value).toBe(true);
  expect(items('log')[0].items[0].attributes['build.kind'].value).toBe('local');
  expect(
    items('trace_metric')
      .flatMap((entry) => entry.items)
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(['duration', 'events', 'queue']);
});

test('manual feedback keeps hints, attachments, scope and beforeSendFeedback hook', async () => {
  const client = initialize();
  const observed = jest.fn();
  client.on('beforeSendFeedback', observed);
  Sentry.withScope((scope) => {
    scope.setTag('screen', 'help');
    Sentry.captureFeedback(
      { message: 'Synthetic feedback', associatedEventId: 'a'.repeat(32) },
      { attachments: [{ filename: 'note.txt', data: 'synthetic' }] },
    );
  });
  await client.flush(2000);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(items('feedback')[0].tags.screen).toBe('help');
  expect(items('feedback')[0].contexts.feedback.associated_event_id).toBe('a'.repeat(32));
  expect(Array.from(items('attachment')[0])).toEqual(
    Array.from(new TextEncoder().encode('synthetic')),
  );
});

test('native/Taro Page lifecycle, HTTP child span and callback error share trace context', async () => {
  const originalRequest = g.wx.request;
  const client = initialize({
    integrations: [
      new Sentry.Integrations.PageTracing(),
      new Sentry.Integrations.NetworkBreadcrumbs({
        tracePropagationTargets: [/^https:\/\/api\.example\.test\//],
      }),
    ],
    tracesSampleRate: 1,
  });
  const config = g.Page({
    onLoad() {
      g.wx.request({
        url: 'https://api.example.test/items?token=secret',
        success() {
          Sentry.captureException(new Error('request callback'));
        },
      });
    },
  });
  const page = { route: 'taroMiniapp/pages/Home/index' };
  jest.useFakeTimers();
  config.onLoad.call(page);
  config.onShow.call(page);
  const options = originalRequest.mock.calls[0][0];
  expect(options.header['sentry-trace']).toMatch(/^[a-f0-9]{32}-[a-f0-9]{16}-1$/);
  options.success({ statusCode: 200 });
  config.onReady.call(page);
  config.onHide.call(page);
  jest.useRealTimers();
  await client.flush(2000);
  const transaction = items('transaction')[0];
  expect(transaction.transaction).toBe(page.route);
  expect(transaction.spans.some((span: any) => span.op === 'http.client')).toBe(true);
  expect(items('event')[0].contexts.trace.trace_id).toBe(transaction.contexts.trace.trace_id);
  expect(JSON.stringify(envelopes)).not.toContain('token=secret');
});

test('explicit [] disables propagation, preserves caller options and mixed case existing headers', () => {
  const request = g.wx.request;
  initialize({
    integrations: [new Sentry.Integrations.NetworkBreadcrumbs({ tracePropagationTargets: [] })],
    tracesSampleRate: 1,
  });
  const options = {
    url: 'https://api.example.test/a',
    header: { 'Sentry-Trace': 'existing' },
    success: jest.fn(),
  };
  const originalCallback = options.success;
  g.wx.request(options);
  expect(request.mock.calls[0][0].header).toEqual({ 'Sentry-Trace': 'existing' });
  expect(options.success).toBe(originalCallback);
  expect(request.mock.calls[0][0]).not.toBe(options);
  expect(options.header).toEqual({ 'Sentry-Trace': 'existing' });
});

test('offline store roundtrips binary, isolates projects, and bounds negative limits', async () => {
  const first = createMiniappOfflineStore({ storageKey: 'project:one' } as any);
  const second = createMiniappOfflineStore({ storageKey: 'project:two' } as any);
  const env: Envelope = [
    { event_id: 'a'.repeat(32), sent_at: new Date().toISOString() },
    [[{ type: 'attachment', filename: 'test.bin', length: 3 }, new Uint8Array([0, 255, 10])]],
  ];
  await first.push(env);
  expect(await second.shift()).toBeUndefined();
  expect(await first.shift()).toEqual(env);
  const disabled = createMiniappOfflineStore({ offlineCacheLimit: -1 } as any);
  await disabled.push(env);
  expect(await disabled.shift()).toBeUndefined();
});

test('failed offline retries preserve the original retention deadline', async () => {
  const dateNow = jest.mocked(Date.now);
  const originalTime = Date.now();
  const store = createMiniappOfflineStore({
    storageKey: 'expiry',
    offlineCacheMaxAge: 1000,
  } as any);
  const envelope: Envelope = [
    { event_id: 'a'.repeat(32), sent_at: new Date().toISOString() },
    [[{ type: 'event' }, { message: 'expires' }]],
  ];
  await store.push(envelope);
  dateNow.mockReturnValue(originalTime + 900);
  const retry = await store.shift();
  await store.unshift(retry!);
  dateNow.mockReturnValue(originalTime + 1100);
  expect(await store.shift()).toBeUndefined();
  dateNow.mockReturnValue(originalTime);
});

test('creating another client does not bypass consent and close stops queued retries', async () => {
  jest.useFakeTimers();
  const send = jest.fn(async () => ({ statusCode: 200 }));
  const options = {
    dsn: 'https://public@ingest.example.test/1',
    requireConsent: true,
    transport: () => ({ send, flush: async () => true }),
  };
  const first = new Sentry.MiniappClient(options);
  new Sentry.MiniappClient({
    dsn: 'https://other@ingest.example.test/2',
    enableOfflineCache: false,
  });
  await first
    .getTransport()!
    .send([
      { event_id: 'a'.repeat(32), sent_at: new Date().toISOString() },
      [[{ type: 'event' }, { message: 'blocked' }]],
    ]);
  await jest.advanceTimersByTimeAsync(6000);
  expect(send).not.toHaveBeenCalled();
  expect(first.getConsent()).toBe(false);
  first.setConsent(true);
  await jest.advanceTimersByTimeAsync(120);
  expect(send).toHaveBeenCalledTimes(1);
  first.setConsent(false);
  await first
    .getTransport()!
    .send([
      { event_id: 'a'.repeat(32), sent_at: new Date().toISOString() },
      [[{ type: 'event' }, { message: 'preserve' }]],
    ]);
  const closing = first.close(0);
  await jest.advanceTimersByTimeAsync(10);
  await closing;
  await jest.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(Object.values(storage).join()).toContain('preserve');
});

test('transport honors custom headers, mixed case rate limits and binary ArrayBuffer body', async () => {
  g.wx.request = jest.fn((options) =>
    options.success({ statusCode: 429, header: { 'X-Sentry-Rate-Limits': '60::organization' } }),
  );
  resetPlatformCache();
  const transport = createMiniappTransport({
    url: 'https://ingest.example.test/envelope/',
    headers: { 'X-Custom': 'present' },
    recordDroppedEvent: () => {},
  });
  const env: Envelope = [
    { event_id: 'a'.repeat(32), sent_at: new Date().toISOString() },
    [[{ type: 'attachment', filename: 'test.bin', length: 2 }, new Uint8Array([0, 255])]],
  ];
  await transport.send(env);
  expect(g.wx.request.mock.calls[0][0].header['X-Custom']).toBe('present');
  expect(g.wx.request.mock.calls[0][0].data).toBeInstanceOf(ArrayBuffer);
  await transport.send(env);
  expect(g.wx.request).toHaveBeenCalledTimes(1);
});

test('sampling callbacks, streamed spans, and default integration filtering take effect', async () => {
  const sampler = jest.fn(() => 1);
  const client = initialize({
    tracesSampler: sampler,
    traceLifecycle: 'stream',
    integrations: [Sentry.spanStreamingIntegration()],
    beforeSendSpan: Sentry.withStreamedSpan((span) => ({ ...span, name: `checked:${span.name}` })),
  });
  Sentry.startSpan({ name: 'manual', op: 'task' }, () => {});
  await client.flush(2000);
  expect(sampler).toHaveBeenCalled();
  expect(
    items('span')
      .flatMap((item) => item.items)
      .some((span) => span.name === 'checked:manual'),
  ).toBe(true);
  expect(client.getOptions().integrations.map((integration: any) => integration.name)).toEqual([
    'SpanStreaming',
  ]);
});

test('disabled clients send no events, feedback, logs, metrics or client reports', async () => {
  const client = initialize({ enabled: false, enableLogs: true, enableMetrics: true });
  Sentry.captureException(new Error('disabled'));
  Sentry.captureFeedback({ message: 'disabled' });
  Sentry.logger.info('disabled');
  Sentry.metrics.count('disabled');
  client.recordDroppedEvent('before_send', 'error');
  await client.flush(2000);
  expect(envelopes).toEqual([]);
});

test('reinit keeps the new instrumentation after a delayed old close and preserves page receiver/results', async () => {
  let resolveFlush!: (flushed: boolean) => void;
  const oldClient = initialize({
    integrations: [new Sentry.Integrations.PageTracing()],
    tracesSampleRate: 1,
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: () =>
        new Promise<boolean>((resolve) => {
          resolveFlush = resolve;
        }),
    }),
  });
  const nextClient = initialize({
    integrations: [new Sentry.Integrations.PageTracing()],
    tracesSampleRate: 1,
  });
  const wrappedPage = g.Page;
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveFlush(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(oldClient.getOptions().enabled).toBe(false);
  expect(Sentry.getClient()).toBe(nextClient);
  expect(g.Page).toBe(wrappedPage);
  const page = { route: 'home' };
  const onLoad = jest.fn(function (this: unknown, value: unknown) {
    expect(this).toBe(page);
    return value;
  });
  const onReady = jest.fn(() => {
    throw new Error('business failure');
  });
  const config = g.Page({ onLoad, onReady });
  jest.useFakeTimers();
  expect(config.onLoad.call(page, 'result')).toBe('result');
  expect(() => config.onReady.call(page)).toThrow('business failure');
  config.onHide.call(page);
  jest.useRealTimers();
  Sentry.captureMessage('new client alive');
  await nextClient.flush(2000);
  expect(items('event')[0].message).toBe('new client alive');
});

test('system contexts distinguish OS, miniapp version and host/base-library versions', async () => {
  g.wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'synthetic', version: '2.4.0' } });
  resetPlatformCache();
  const client = initialize();
  Sentry.captureMessage('contexts');
  await client.flush(2000);
  expect(items('event')[0].contexts.os).toEqual({ name: 'iOS', version: '15.0' });
  expect(items('event')[0].contexts.app.app_version).toBe('2.4.0');
  expect(items('event')[0].contexts.miniapp_host).toEqual({
    name: 'wechat',
    version: '8.0.5',
    sdk_version: '2.19.4',
  });
});

test('idle completion clears the page span and later hide preserves another active operation', async () => {
  jest.useFakeTimers();
  const client = initialize({
    integrations: [new Sentry.Integrations.PageTracing()],
    tracesSampleRate: 1,
  });
  const page = { route: 'home' };
  const config = g.Page({});
  config.onLoad.call(page);
  expect(Sentry.getActiveSpan()).toBeDefined();
  config.onReady.call(page);
  await jest.advanceTimersByTimeAsync(1100);
  expect(Sentry.getActiveSpan()).toBeUndefined();
  Sentry.startSpan({ name: 'new operation' }, (span) => {
    config.onHide.call(page);
    expect(Sentry.getActiveSpan()).toBe(span);
  });
  jest.useRealTimers();
  await client.flush(2000);
});

test('closed Page constructors and existing callbacks cannot instrument the next client', async () => {
  const old = initialize({
    integrations: [
      new Sentry.Integrations.PageBreadcrumbs(),
      new Sentry.Integrations.PageTracing(),
    ],
    tracesSampleRate: 1,
  });
  const savedPage = g.Page;
  const business = jest.fn(function (this: unknown, value: string) {
    return { receiver: this, value };
  });
  const config = savedPage({ onShow: business, onTap: business });
  await old.close(2000);
  const next = initialize({ tracesSampleRate: 1 });
  const page = { route: 'existing' };
  expect(config.onShow.call(page, 'show')).toEqual({ receiver: page, value: 'show' });
  expect(config.onTap.call(page, 'tap')).toEqual({ receiver: page, value: 'tap' });
  const late = savedPage({ onShow: business });
  expect(late.onShow.call(page, 'late')).toEqual({ receiver: page, value: 'late' });
  expect(Sentry.getActiveSpan()).toBeUndefined();
  Sentry.captureMessage('next');
  await next.flush(2000);
  expect(items('transaction')).toHaveLength(0);
  expect(items('event')[0].breadcrumbs ?? []).toEqual([]);
});

test('SDK init forwards header policy to Replay hints while real error envelopes stay header-free', async () => {
  const originalRequest = g.wx.request;
  const client = Sentry.init({
    dsn: 'https://public@ingest.example.test/1',
    enableAutoSessionTracking: false,
    enableNetworkStatusMonitoring: false,
    enableOfflineCache: false,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    integrations: (integrations) =>
      integrations.filter((entry) => entry.name === 'NetworkBreadcrumbs'),
    networkDetailAllowUrls: [/^https:\/\/api\.example\.test\//],
    networkRequestHeaders: ['X-Request-ID', 'Authorization'],
    networkResponseHeaders: ['X-Response-ID', 'Set-Cookie'],
  })!;
  const hints: any[] = [];
  client.on('beforeAddBreadcrumb', (_breadcrumb, hint) => {
    hints.push(hint);
  });
  g.wx.request({
    url: 'https://api.example.test/items?secret=query-canary',
    header: {
      Accept: 'application/json',
      'X-Request-ID': 'request-correlation-canary',
      Authorization: 'credential-canary',
    },
  });
  originalRequest.mock.calls[0][0].success({
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Response-ID': 'response-correlation-canary',
      'Set-Cookie': 'cookie-canary',
    },
  });
  expect(hints[0].replayNetworkDetails).toEqual({
    url: 'https://api.example.test/items',
    request_headers: { accept: 'application/json', 'x-request-id': 'request-correlation-canary' },
    response_headers: {
      'content-type': 'application/json',
      'x-response-id': 'response-correlation-canary',
    },
  });
  Sentry.captureException(new Error('synthetic network failure'));
  await client.flush(2000);
  expect(items('event')[0].breadcrumbs).toHaveLength(1);
  const json = JSON.stringify(items('event'));
  for (const value of [
    'request_headers',
    'response_headers',
    'request-correlation-canary',
    'response-correlation-canary',
    'credential-canary',
    'cookie-canary',
    'query-canary',
  ])
    expect(json).not.toContain(value);
});

test('actual init does not evaluate privacy configuration accessors and malformed deny fails closed', () => {
  const originalRequest = g.wx.request;
  const getter = jest.fn(() => {
    throw new Error('privacy accessor');
  });
  const options: Sentry.MiniappOptions = {
    dsn: 'https://public@ingest.example.test/1',
    networkDetailAllowUrls: ['api.example.test'],
    enableAutoSessionTracking: false,
    enableNetworkStatusMonitoring: false,
    integrations: (integrations) =>
      integrations.filter((entry) => entry.name === 'NetworkBreadcrumbs'),
  };
  Object.defineProperty(options, 'networkDetailDenyUrls', { get: getter, enumerable: true });
  const client = Sentry.init(options)!;
  const hints = jest.fn();
  client.on('beforeAddBreadcrumb', hints);
  g.wx.request({ url: 'https://api.example.test/items', header: { Accept: 'never-captured' } });
  originalRequest.mock.calls[0][0].success({ statusCode: 200 });
  expect(getter).not.toHaveBeenCalled();
  expect(hints.mock.calls[0][1]?.replayNetworkDetails).toBeUndefined();
});
