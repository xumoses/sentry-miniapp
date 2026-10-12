import * as Sentry from '../src/index';
import { installedIntegrations, type Envelope } from '@sentry/core';
import { resetPlatformCache } from '../src/crossPlatform';
import { _resetAppLifecycle } from '../src/appLifecycle';

let envelopes: Envelope[];

beforeEach(() => {
  envelopes = [];
  installedIntegrations.length = 0;
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
  (globalThis as any).wx.getAccountInfoSync = () => ({
    miniProgram: { appId: 'synthetic-app', version: '2.4.0' },
  });
  resetPlatformCache();
});

afterEach(async () => {
  await Sentry.getClient()?.close(0);
  Sentry.getCurrentScope().setClient(undefined);
  _resetAppLifecycle();
});

test.each(['event', 'scope'] as const)(
  'default integrations honor app/runtime context removal through %s',
  async (source) => {
    const client = Sentry.init({
      dsn: 'https://public@ingest.example.com/1',
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
    })!;
    if (source === 'scope') {
      Sentry.setContext('app', { app_version: 'custom' });
      Sentry.setContext('runtime', { name: 'custom' });
      Sentry.setContext('app', null);
      Sentry.setContext('runtime', null);
    }
    Sentry.captureException(new Error(`synthetic ${source} context suppression`), {
      // JavaScript callers can explicitly suppress contexts with null.
      ...(source === 'event' ? { contexts: { app: null, runtime: null } as any } : {}),
    });
    await client.flush(2000);
    const events = envelopes.flatMap((envelope) =>
      envelope[1].filter((item) => item[0].type === 'event').map((item) => item[1]),
    ) as Sentry.Event[];
    expect(events).toHaveLength(1);
    if (source === 'event') {
      expect(events[0]?.contexts?.['app']).toBeNull();
      expect(events[0]?.contexts?.['runtime']).toBeNull();
    } else {
      // Core setContext(null) removes the scope override rather than storing a
      // null tombstone, so normal technical defaults become visible again.
      expect(events[0]?.contexts?.['app']).toEqual(
        expect.objectContaining({ app_version: '2.4.0' }),
      );
      expect(events[0]?.contexts?.['runtime']).toEqual({
        name: 'miniapp',
        version: '2.19.4',
      });
    }
    expect(events[0]?.contexts?.['os']).toEqual({ name: 'iOS', version: '15.0' });
  },
);
