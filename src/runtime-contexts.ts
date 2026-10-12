import { appName, getAccountInfo, getSystemInfo, type SystemInfo } from './crossPlatform';

/** Pure technical defaults shared by error events and Replay; never scope/account identity. */
export type MiniappRuntimeContexts = Record<string, Record<string, unknown>>;
const CLIENT_HINTS_TIMEOUT_MS = 200;

function read(value: unknown, name: string): unknown {
  try {
    return value && (typeof value === 'object' || typeof value === 'function')
      ? (value as Record<string, unknown>)[name]
      : undefined;
  } catch {
    return undefined;
  }
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    ? value
    : undefined;
}
function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000
    ? Math.round(value)
    : 0;
}
function hostPlatform(value: unknown): string | undefined {
  switch (text(value)?.toLowerCase()) {
    case 'macos':
    case 'macintel':
    case 'macppc':
      return 'macOS';
    case 'windows':
    case 'win32':
    case 'win64':
      return 'Windows';
    case 'linux':
    case 'linux x86_64':
    case 'linux aarch64':
      return 'Linux';
    case 'chrome os':
      return 'Chrome OS';
    default:
      return undefined;
  }
}
function copy(contexts: MiniappRuntimeContexts): MiniappRuntimeContexts {
  return Object.fromEntries(Object.entries(contexts).map(([name, value]) => [name, { ...value }]));
}

async function readClientHints(userAgentData: unknown): Promise<unknown> {
  const getValues = read(userAgentData, 'getHighEntropyValues');
  if (typeof getValues !== 'function') return undefined;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(), CLIENT_HINTS_TIMEOUT_MS);
    try {
      Promise.resolve(
        getValues.call(userAgentData, ['platformVersion', 'architecture', 'bitness']),
      ).then(finish, () => finish());
    } catch {
      finish();
    }
  });
}

async function collect(info: SystemInfo | null): Promise<MiniappRuntimeContexts> {
  const field = (name: string): string => text(read(info, name)) || 'unknown';
  const host = appName();
  const system = field('system');
  const platform = field('platform');
  const brand = text(read(info, 'brand'));
  const model = text(read(info, 'model'));
  const screenResolution = `${dimension(read(info, 'screenWidth'))}x${dimension(read(info, 'screenHeight'))}`;
  const parsedSystem = /^(.*?)(?:\s+|_)(\d[\w.+_-]*)$/.exec(system);
  const contexts: MiniappRuntimeContexts = {
    device: {
      ...(brand ? { brand } : {}),
      ...(model ? { model } : {}),
      screen_resolution: screenResolution,
      language: field('language'),
      system,
      platform,
    },
    os: {
      name: parsedSystem?.[1] || system,
      ...(parsedSystem?.[2] ? { version: parsedSystem[2] } : {}),
    },
    app: { app_version: text(getAccountInfo().version) || 'unknown' },
    runtime: { name: 'miniapp', version: field('SDKVersion') },
    miniapp_host: { name: host, version: field('version'), sdk_version: field('SDKVersion') },
  };
  if (platform.toLowerCase() !== 'devtools') {
    if (host === 'wechat') contexts['browser'] = { name: 'WeChat', version: field('version') };
    return contexts;
  }

  // wx devtools fields describe the emulated phone, not the development computer.
  contexts['miniapp_simulator'] = {
    brand: field('brand'),
    model: field('model'),
    system,
    platform,
    version: field('version'),
    screen_resolution: screenResolution,
  };
  contexts['device'] = {
    simulator: true,
    platform: 'devtools',
    language: field('language'),
  };
  contexts['os'] = { name: 'unknown' };
  contexts['miniapp_host'] = { name: `${host}-devtools`, sdk_version: field('SDKVersion') };

  // Only the explicit developer-tools platform may inspect browser globals.
  const navigator = read(globalThis, 'navigator');
  const userAgent = read(navigator, 'userAgent');
  const toolVersion =
    typeof userAgent === 'string' && userAgent.length <= 8192
      ? /(?:^|\s)wechatdevtools\/(\d+(?:\.\d+){1,4})(?=\s|$)/i.exec(userAgent)?.[1]
      : undefined;
  if (host !== 'wechat' || !toolVersion) return contexts;
  contexts['browser'] = { name: 'WeChat DevTools', version: toolVersion };
  contexts['miniapp_host'] = {
    name: 'wechatdevtools',
    version: toolVersion,
    sdk_version: field('SDKVersion'),
  };
  const userAgentData = read(navigator, 'userAgentData');
  const fallbackName =
    hostPlatform(read(userAgentData, 'platform')) || hostPlatform(read(navigator, 'platform'));
  if (fallbackName) contexts['os'] = { name: fallbackName };
  const hints = await readClientHints(userAgentData);
  const name = hostPlatform(read(hints, 'platform'));
  if (!name) return contexts;
  contexts['os'] = { name };
  const version = text(read(hints, 'platformVersion'));
  // Windows UA-CH versions describe an API contract, not the marketed OS version.
  // Only macOS is promoted to an exact OS version; other hosts keep a truthful name.
  if (name === 'macOS' && version && /^\d+(?:\.\d+){0,3}$/.test(version)) {
    contexts['os']['version'] = version;
  }
  const architecture = text(read(hints, 'architecture'));
  const bitness = text(read(hints, 'bitness'));
  if (architecture === 'arm' && bitness === '64') contexts['device']['arch'] = 'arm64';
  else if (architecture === 'x86' && bitness === '64') contexts['device']['arch'] = 'x86_64';
  else if (architecture === 'x86' && bitness === '32') contexts['device']['arch'] = 'x86';
  return contexts;
}

/** One bounded read per owning client; every consumer receives independent defaults. */
export function createRuntimeContextProvider(
  enabled: boolean,
): () => Promise<MiniappRuntimeContexts> {
  let cached: Promise<MiniappRuntimeContexts> | undefined;
  return () => {
    if (!enabled) return Promise.resolve({});
    if (!cached) {
      let usable = false;
      const pending = Promise.resolve()
        .then(() => {
          const info = getSystemInfo();
          usable = ['brand', 'model', 'system', 'platform'].some(
            (name) => !!text(read(info, name)),
          );
          return collect(info);
        })
        .catch(() => ({}));
      cached = pending;
      void pending.then(() => {
        // Retry on a later event if platform APIs were not ready. A known device's
        // Client Hints timeout/rejection remains cached and never loops per event.
        if (!usable && cached === pending) cached = undefined;
      });
    }
    return cached.then(copy);
  };
}
