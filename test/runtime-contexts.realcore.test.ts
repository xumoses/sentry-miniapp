import * as Sentry from '../src/index';
import { installedIntegrations, type Envelope } from '@sentry/core';
import { resetPlatformCache } from '../src/crossPlatform';
import { _resetAppLifecycle } from '../src/appLifecycle';

const g = globalThis as any;
let navigatorDescriptor: PropertyDescriptor | undefined;
let envelopes: Envelope[];
const events = (): any[] =>
  envelopes.flatMap((envelope) =>
    envelope[1].filter((item) => item[0].type === 'event').map((item) => item[1]),
  );
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
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    ...options,
  })!;
}
function simulatedMac(
  hints: unknown = {
    platform: 'macOS',
    platformVersion: '27.0.1',
    architecture: 'arm',
    bitness: '64',
  },
) {
  g.wx.getDeviceInfo = jest.fn(() => ({
    platform: 'devtools',
    system: 'iOS 10.0.1',
    brand: 'devtools',
    model: 'iPhone12/13(Pro)',
  }));
  g.wx.getAppBaseInfo = jest.fn(() => ({
    version: '8.0.5',
    SDKVersion: '3.7.12',
    language: 'zh_CN',
  }));
  g.wx.getAccountInfoSync = jest.fn(() => ({
    miniProgram: { appId: 'synthetic-app-id', version: '2.4.0' },
  }));
  const getHighEntropyValues = jest.fn(() => Promise.resolve(hints));
  Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: {
      platform: 'MacIntel',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) wechatdevtools/2.02.2607271 Chrome/136.0.0.0',
      userAgentData: { platform: 'macOS', getHighEntropyValues },
    },
  });
  resetPlatformCache();
  return getHighEntropyValues;
}
beforeEach(() => {
  navigatorDescriptor = Object.getOwnPropertyDescriptor(g, 'navigator');
  envelopes = [];
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
});
afterEach(async () => {
  jest.useRealTimers();
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  if (navigatorDescriptor) Object.defineProperty(g, 'navigator', navigatorDescriptor);
  else delete g.navigator;
  _resetAppLifecycle();
});

test('real core error uses macOS host version rather than simulated iPhone in WeChat DevTools', async () => {
  const read = simulatedMac();
  const client = initialize();
  Sentry.captureException(new Error('synthetic devtools context regression'));
  await client.flush(2000);
  expect(events()).toHaveLength(1);
  expect(events()[0].contexts.os).toEqual({ name: 'macOS', version: '27.0.1' });
  expect(events()[0].contexts.device.simulator).toBe(true);
  expect(events()[0].contexts.device).not.toHaveProperty('model');
  expect(events()[0].contexts.device).not.toHaveProperty('brand');
  expect(events()[0].contexts.miniapp_simulator).toEqual(
    expect.objectContaining({
      system: 'iOS 10.0.1',
      model: 'iPhone12/13(Pro)',
      brand: 'devtools',
      version: '8.0.5',
    }),
  );
  expect(events()[0].contexts.miniapp_host).toEqual({
    name: 'wechatdevtools',
    version: '2.02.2607271',
    sdk_version: '3.7.12',
  });
  expect(events()[0].contexts.app.app_version).toBe('2.4.0');
  expect(read).toHaveBeenCalledTimes(1);
});

test('unavailable Client Hints preserves only a known host name and never uses simulated UA OS', async () => {
  simulatedMac();
  delete g.navigator.userAgentData;
  const client = initialize();
  const contexts = await client.getRuntimeContexts();
  expect(contexts['os']).toEqual({ name: 'macOS' });
  expect(contexts['device']).not.toHaveProperty('system');
  expect(contexts['device']).not.toHaveProperty('screen_resolution');
  expect(contexts['miniapp_simulator']?.['screen_resolution']).toBe('390x844');
  expect(contexts['runtime']).toEqual({ name: 'miniapp', version: '3.7.12' });
});

test('unverified browser identity cannot supply host OS or a version', async () => {
  const read = simulatedMac();
  g.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)';
  const contexts = await initialize().getRuntimeContexts();
  expect(contexts['os']).toEqual({ name: 'unknown' });
  expect(contexts['miniapp_host']).toEqual({ name: 'wechat-devtools', sdk_version: '3.7.12' });
  expect(contexts['browser']).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

test.each(['reject', 'throw', 'malformed'] as const)(
  'Client Hints %s cannot interrupt an error event',
  async (mode) => {
    const read = simulatedMac();
    if (mode === 'reject') read.mockImplementation(() => Promise.reject(new Error('denied')));
    if (mode === 'throw')
      read.mockImplementation(() => {
        throw new Error('denied');
      });
    if (mode === 'malformed')
      read.mockImplementation(() =>
        Promise.resolve({ platform: {}, platformVersion: { secret: 'not-a-version' } }),
      );
    const client = initialize();
    Sentry.captureException(new Error('synthetic fallback'));
    await client.flush(2000);
    expect(events()).toHaveLength(1);
    expect(events()[0].contexts.os).toEqual({ name: 'macOS' });
    expect(JSON.stringify(events())).not.toContain('not-a-version');
  },
);

test('Client Hints timeout is at most 200ms, cached once, and late completion cannot change contexts', async () => {
  const read = simulatedMac();
  let resolve!: (value: unknown) => void;
  read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const client = initialize();
  jest.useFakeTimers();
  const pending = Promise.resolve(client.getRuntimeContexts());
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await jest.advanceTimersByTimeAsync(199);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  const first = await pending;
  expect(first['os']).toEqual({ name: 'macOS' });
  resolve({ platform: 'macOS', platformVersion: '99.0.0' });
  await Promise.resolve();
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'macOS' });
  expect(read).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
  Sentry.captureException(new Error('synthetic after timeout'));
  await client.flush(2000);
  expect(events()).toHaveLength(1);
});

test.each([
  { platform: 'ios', system: 'iOS 18.1', name: 'iOS', version: '18.1' },
  { platform: 'android', system: 'Android 15', name: 'Android', version: '15' },
  { platform: 'mac', system: 'macOS 27.0.1', name: 'macOS', version: '27.0.1' },
  { platform: 'windows', system: 'Windows 11', name: 'Windows', version: '11' },
])(
  'real $platform clients only use miniapp API data',
  async ({ platform, system, name, version }) => {
    g.wx.getDeviceInfo = jest.fn(() => ({
      platform,
      system,
      brand: 'Synthetic',
      model: 'Synthetic device',
    }));
    const navigatorRead = jest.fn(() => {
      throw new Error('navigator must not be read');
    });
    Object.defineProperty(g, 'navigator', { configurable: true, get: navigatorRead });
    resetPlatformCache();
    const client = initialize();
    Sentry.captureException(new Error('synthetic real-device path'));
    await client.flush(2000);
    expect(events()[0].contexts.os).toEqual({ name, version });
    expect(events()[0].contexts.device.model).toBe('Synthetic device');
    expect(events()[0].contexts.device).not.toHaveProperty('simulator');
    expect(events()[0].contexts.device).not.toHaveProperty('version');
    expect(events()[0].contexts.browser).toEqual({ name: 'WeChat', version: '8.0.5' });
    expect(events()[0].contexts.miniapp_host).toEqual({
      name: 'wechat',
      version: '8.0.5',
      sdk_version: '2.19.4',
    });
    expect(navigatorRead).not.toHaveBeenCalled();
  },
);

test('enableSystemInfo:false skips all system/account/navigator collection', async () => {
  const hints = simulatedMac();
  const navigatorRead = jest.fn(() => {
    throw new Error('disabled');
  });
  Object.defineProperty(g, 'navigator', { configurable: true, get: navigatorRead });
  const client = initialize({ enableSystemInfo: false });
  expect(await client.getRuntimeContexts()).toEqual({});
  Sentry.captureException(new Error('synthetic disabled contexts'));
  await client.flush(2000);
  expect(events()[0].contexts.os).toBeUndefined();
  expect(events()[0].contexts.device).toBeUndefined();
  for (const method of [
    'getDeviceInfo',
    'getAppBaseInfo',
    'getAccountInfoSync',
    'getWindowInfo',
    'getSystemInfoSync',
    'getSystemSetting',
    'getAppAuthorizeSetting',
  ])
    expect(g.wx[method]).not.toHaveBeenCalled();
  expect(navigatorRead).not.toHaveBeenCalled();
  expect(hints).not.toHaveBeenCalled();
});

test('shared defaults are isolated from scopes, account identity, mutation and client reinitialization', async () => {
  const hints = simulatedMac();
  const client = initialize();
  Sentry.setUser({ id: 'scope-user-canary' });
  Sentry.setContext('os', { name: 'ExplicitOS', version: 'explicit-version' });
  Sentry.setContext('device', { brand: 'Explicit brand' });
  const first = await client.getRuntimeContexts();
  first['os']!['version'] = 'mutated';
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'macOS', version: '27.0.1' });
  expect(JSON.stringify(await client.getRuntimeContexts())).not.toMatch(
    /scope-user-canary|synthetic-app-id/,
  );
  Sentry.captureException(new Error('synthetic explicit context'));
  await client.flush(2000);
  expect(events()[0].contexts.os).toEqual({ name: 'ExplicitOS', version: 'explicit-version' });
  expect(events()[0].contexts.device.brand).toBe('Explicit brand');
  expect(hints).toHaveBeenCalledTimes(1);
  const next = initialize();
  expect((await next.getRuntimeContexts())['os']).toEqual({ name: 'macOS', version: '27.0.1' });
  expect(hints).toHaveBeenCalledTimes(2);
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'macOS', version: '27.0.1' });
});

test('Windows Client Hints API contract version is not misreported as the OS version', async () => {
  simulatedMac({
    platform: 'Windows',
    platformVersion: '13.0.0',
    architecture: 'x86',
    bitness: '64',
  });
  const contexts = await initialize().getRuntimeContexts();
  expect(contexts['os']).toEqual({ name: 'Windows' });
  expect(contexts['device']?.['arch']).toBe('x86_64');
});

test('deprecated System integration delegates to the same defaults and cannot override the host OS', async () => {
  const hints = simulatedMac();
  const client = initialize({ integrations: [new Sentry.Integrations.System()] });
  Sentry.captureException(new Error('synthetic legacy integration'));
  await client.flush(2000);
  expect(events()[0].contexts.os).toEqual({ name: 'macOS', version: '27.0.1' });
  expect(events()[0].contexts.os.kernel_version).toBeUndefined();
  expect(events()[0].contexts.device.arch).toBe('arm64');
  expect(events()[0].contexts.app.app_version).toBe('2.4.0');
  expect(events()[0].tags['app.version']).toBe('2.4.0');
  expect(hints).toHaveBeenCalledTimes(1);
});

test('transient unavailable system APIs recover on the next error without poisoning the client cache', async () => {
  g.wx = {
    request: jest.fn(),
    getDeviceInfo: jest.fn(() => {
      throw new Error('not ready');
    }),
  };
  resetPlatformCache();
  const client = initialize();
  Sentry.captureException(new Error('synthetic unavailable device'));
  await client.flush(2000);
  expect(events()[0].contexts.os).toEqual({ name: 'unknown' });
  g.wx.getDeviceInfo.mockImplementation(() => ({
    brand: 'Synthetic',
    model: 'Device',
    platform: 'ios',
    system: 'iOS 18.1',
  }));
  Sentry.captureException(new Error('synthetic recovered device'));
  await client.flush(2000);
  expect(events()[1].contexts.os).toEqual({ name: 'iOS', version: '18.1' });
  expect(g.wx.getDeviceInfo).toHaveBeenCalledTimes(2);
});

test('partial base information is retained but does not permanently cache a missing device identity', async () => {
  g.wx = {
    request: jest.fn(),
    getAppBaseInfo: () => ({ version: '8.0.5', SDKVersion: '3.7.12' }),
    getDeviceInfo: jest.fn(() => ({})),
  };
  resetPlatformCache();
  const client = initialize();
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'unknown' });
  g.wx.getDeviceInfo.mockImplementation(() => ({ platform: 'android', system: 'Android 15' }));
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'Android', version: '15' });
  expect(g.wx.getDeviceInfo).toHaveBeenCalledTimes(2);
});

test('explicit event context overrides and nulls survive the shared-default fill', async () => {
  simulatedMac();
  const client = initialize();
  Sentry.captureEvent({
    message: 'synthetic context overrides',
    contexts: {
      os: null,
      device: { model: 'Explicit event model' },
      miniapp_host: { name: 'Explicit host' },
    } as any, // JavaScript callers may explicitly suppress a context with null.
  });
  await client.flush(2000);
  expect(events()[0].contexts.os).toBeNull();
  expect(events()[0].contexts.device.model).toBe('Explicit event model');
  expect(events()[0].contexts.miniapp_host.name).toBe('Explicit host');
  expect((await client.getRuntimeContexts())['os']).toEqual({ name: 'macOS', version: '27.0.1' });
});

test('DevTools omits unknown hardware identifiers instead of triggering device-catalog normalization', async () => {
  simulatedMac();
  const client = initialize();
  Sentry.captureException(new Error('synthetic unknown device catalog regression'));
  await client.flush(2000);
  expect(events()[0].contexts.device).toEqual({
    simulator: true,
    platform: 'devtools',
    language: 'zh_CN',
    arch: 'arm64',
  });
  expect(events()[0].contexts.miniapp_simulator.model).toBe('iPhone12/13(Pro)');
  expect(events()[0].contexts.miniapp_simulator.brand).toBe('devtools');
});

test.each([{}, { platform: 'ios', system: 'iOS 18.1' }])(
  'missing native hardware identifiers are omitted: %j',
  async (device) => {
    g.wx = { request: jest.fn(), getDeviceInfo: () => device };
    resetPlatformCache();
    const client = initialize();
    Sentry.captureException(new Error('synthetic missing hardware regression'));
    await client.flush(2000);
    expect(events()[0].contexts.device).not.toHaveProperty('model');
    expect(events()[0].contexts.device).not.toHaveProperty('brand');
  },
);
