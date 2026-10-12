import { startTaroDomReplayPoc } from '../src/replay-poc';
import type { NetworkDetailOptions } from '../src/network-details';

class Observer {
  observe() {}
  disconnect() {}
}
function record(config: NetworkDetailOptions, data: Record<string, unknown>) {
  const recorder = startTaroDomReplayPoc({
    root: { sid: 'root', nodeName: 'view', nodeType: 1, childNodes: [] },
    MutationObserver: Observer,
    ...config,
  });
  try {
    recorder.addBreadcrumb({ category: 'xhr', type: 'http', data });
    return recorder
      .getCapture()
      .events.find((event) => event.type === 5 && (event.data as any).tag === 'performanceSpan')!
      .data as any;
  } finally {
    recorder.stop();
  }
}
const data = {
  url: 'https://user:password@api.example.com/items?secret=query#secret',
  request_headers: {
    Accept: 'application/json',
    Authorization: 'credential-canary',
    'X-Request-ID': 'correlation-canary',
  },
  response_headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'cookie-canary' },
  request_body: 'body-canary',
  response_body: 'body-canary',
};

test('manual network breadcrumbs expose no headers without URL permission', () => {
  const event = record({}, data);
  expect(event.payload.data.request).toEqual({ headers: {}, _meta: { warnings: ['URL_SKIPPED'] } });
  expect(JSON.stringify(event)).not.toContain('canary');
  expect(JSON.stringify(event)).not.toContain('password');
  expect(JSON.stringify(event)).not.toContain('secret');
});

test('allowed network spans re-filter headers but never bodies, and do not claim URL skipped', () => {
  const event = record(
    {
      networkDetailAllowUrls: [/^https:\/\/api\.example\.com\//],
      networkRequestHeaders: ['X-Request-ID', 'Authorization'],
      networkResponseHeaders: ['Set-Cookie'],
    },
    data,
  );
  expect(event.payload.data.request).toEqual({
    headers: { accept: 'application/json', 'x-request-id': 'correlation-canary' },
    _meta: { warnings: [] },
  });
  expect(event.payload.data.response.headers).toEqual({ 'content-type': 'application/json' });
  const json = JSON.stringify(event);
  for (const value of ['credential-canary', 'cookie-canary', 'body-canary', 'password', 'secret'])
    expect(json).not.toContain(value);
});

test('deny rules and throwing header field accessors cannot leak or interrupt recording', () => {
  const getter = jest.fn(() => {
    throw new Error('getter');
  });
  const headers = Object.defineProperty({ url: data.url }, 'request_headers', { get: getter });
  expect(
    record({ networkDetailAllowUrls: ['api.example.com'] }, headers).payload.data.request.headers,
  ).toEqual({});
  expect(getter).not.toHaveBeenCalled();
  const event = record(
    { networkDetailAllowUrls: ['api.example.com'], networkDetailDenyUrls: ['/items'] },
    data,
  );
  expect(event.payload.data.response._meta.warnings).toEqual(['URL_SKIPPED']);
  expect(JSON.stringify(event)).not.toContain('canary');
});
