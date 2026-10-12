import {
  createNetworkHeaderPolicy,
  snapshotNetworkOptions,
  sanitizeNetworkDetailUrl,
} from '../src/network-details';

const url = 'https://api.example.com/items';
const options = { networkDetailAllowUrls: [/^https:\/\/api\.example\.com\//] };

test('URL permission is opt-in, sanitized before matching, and deny wins', () => {
  expect(createNetworkHeaderPolicy({}).isAllowed(url)).toBe(false);
  const policy = createNetworkHeaderPolicy({ ...options, networkDetailDenyUrls: ['/private'] });
  expect(policy.isAllowed('https://user:password@api.example.com/items?token=secret#private')).toBe(
    true,
  );
  expect(policy.isAllowed(`${url}/private?allow=yes`)).toBe(false);
  expect(policy.isAllowed('https://other.example.com/items')).toBe(false);
  expect(
    createNetworkHeaderPolicy({ networkDetailAllowUrls: ['token=secret'] }).isAllowed(
      `${url}?token=secret`,
    ),
  ).toBe(false);
  expect(
    sanitizeNetworkDetailUrl('https://first@user:password@api.example.com/items?token=secret#x'),
  ).toBe(url);
});

test('snapshots are immutable and g/y regular expressions never share lastIndex', () => {
  const regexp = /^https:\/\/api\.example\.com\//gy;
  regexp.lastIndex = 5;
  const allow = [regexp];
  const names = ['X-Request-ID'];
  const config = { networkDetailAllowUrls: allow, networkRequestHeaders: names };
  const snapshot = snapshotNetworkOptions(config);
  const policy = createNetworkHeaderPolicy(snapshot);
  allow.splice(0, 1, /other/);
  names.push('X-Later');
  for (let i = 0; i < 3; i++) expect(policy.isAllowed(url)).toBe(true);
  expect(regexp.lastIndex).toBe(5);
  expect(policy.filterHeaders({ 'x-request-id': 'yes', 'x-later': 'no' }, 'request')).toEqual({
    'x-request-id': 'yes',
  });
  expect(Object.keys(snapshot)).toHaveLength(4);
  expect(Object.isFrozen(snapshot.networkDetailDenyUrls)).toBe(true);
  expect(snapshotNetworkOptions({})).toEqual({
    networkDetailAllowUrls: [],
    networkDetailDenyUrls: [],
    networkRequestHeaders: [],
    networkResponseHeaders: [],
  });
});

test.each([
  { deny: Array(101).fill('/not-matching') },
  { deny: [null] },
  { deny: ['x'.repeat(2049)] },
])('invalid or incomplete deny configuration fails closed', ({ deny }) => {
  expect(
    createNetworkHeaderPolicy({ ...options, networkDetailDenyUrls: deny as any }).isAllowed(url),
  ).toBe(false);
});

test('deny field accessor and proxy failures fail closed without executing getters', () => {
  const getter = jest.fn(() => {
    throw new Error('getter');
  });
  const config = Object.defineProperty({ ...options }, 'networkDetailDenyUrls', { get: getter });
  expect(createNetworkHeaderPolicy(config).isAllowed(url)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  const deniedArray = Object.defineProperty([], '0', { get: getter, enumerable: true });
  expect(
    createNetworkHeaderPolicy({ ...options, networkDetailDenyUrls: deniedArray }).isAllowed(url),
  ).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  const denied = new Proxy([], {
    get() {
      throw new Error('proxy');
    },
  });
  expect(
    createNetworkHeaderPolicy({ ...options, networkDetailDenyUrls: denied }).isAllowed(url),
  ).toBe(false);
});

test('default/custom headers are lowercase scalars and credential families can never be opted in', () => {
  const sensitive = [
    'Authorization',
    'Cookie',
    'Set-Cookie',
    'X-Token',
    'X-API-Key',
    'Password',
    'X-Authentication',
    'X_Auth_Key',
    'X-OpenID',
    'X-Session',
    '__proto__',
    'constructor',
  ];
  const policy = createNetworkHeaderPolicy({
    ...options,
    networkRequestHeaders: [...sensitive, 'X-Request-ID', 'X-Count', 'X-Boolean', 'X-Object', '*'],
  });
  const headers = Object.fromEntries(sensitive.map((key) => [key, 'sensitive-canary']));
  Object.assign(headers, {
    'Content-Type': 'application/json',
    ACCEPT: '*/*',
    'Content-Length': 12,
    'X-Request-ID': 'correlation',
    'X-Count': 0,
    'X-Boolean': false,
    'X-Object': { secret: 'no' },
    'X-Unlisted': 'no',
  });
  expect(policy.filterHeaders(headers, 'request')).toEqual({
    'content-type': 'application/json',
    accept: '*/*',
    'content-length': '12',
    'x-request-id': 'correlation',
    'x-count': '0',
    'x-boolean': 'false',
  });
  expect(policy.filterHeaders(headers, 'response')).toEqual({
    'content-type': 'application/json',
    accept: '*/*',
    'content-length': '12',
  });
});

test('header inspection ignores throwing accessors/proxies and never invokes toString', () => {
  const getter = jest.fn(() => {
    throw new Error('getter');
  });
  const headers = Object.defineProperty({ accept: '*/*' }, 'Content-Type', {
    get: getter,
    enumerable: true,
  });
  const policy = createNetworkHeaderPolicy(options);
  expect(policy.filterHeaders(headers, 'request')).toEqual({ accept: '*/*' });
  expect(getter).not.toHaveBeenCalled();
  expect(
    policy.filterHeaders(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('proxy');
          },
        },
      ),
      'response',
    ),
  ).toEqual({});
  const toString = jest.fn(() => {
    throw new Error('toString');
  });
  expect(policy.filterHeaders({ accept: { toString } }, 'request')).toEqual({});
  expect(toString).not.toHaveBeenCalled();
});

test('header counts, UTF-8 bytes, names and control characters have fixed bounds', () => {
  const names = Array.from({ length: 30 }, (_, i) => `x-${i}`);
  const policy = createNetworkHeaderPolicy({
    ...options,
    networkRequestHeaders: [...names, 'n'.repeat(129), 'bad name'],
  });
  expect(
    Object.keys(
      policy.filterHeaders(Object.fromEntries(names.map((name) => [name, 'v'])), 'request'),
    ),
  ).toHaveLength(20);
  const output = policy.filterHeaders(
    Object.fromEntries(names.map((name) => [name, '文'.repeat(341)])),
    'request',
  );
  expect(Object.keys(output)).toHaveLength(3);
  expect(
    Object.entries(output).reduce(
      (total, [name, value]) => total + Buffer.byteLength(name + value),
      0,
    ),
  ).toBeLessThanOrEqual(4096);
  expect(
    policy.filterHeaders(
      { 'x-0': '文'.repeat(342), 'x-1': 'a'.repeat(1025), 'x-2': 'a\r\nb' } as any,
      'request',
    ),
  ).toEqual({});
  expect(policy.filterHeaders({ ['n'.repeat(129)]: 'no', 'bad name': 'no' }, 'request')).toEqual(
    {},
  );
});
