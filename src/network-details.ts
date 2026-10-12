/** Replay-only network details. URL rules match sanitized origin/path, never query/hash. */
export interface NetworkDetailOptions {
  networkDetailAllowUrls?: readonly (string | RegExp)[];
  networkDetailDenyUrls?: readonly (string | RegExp)[];
  networkRequestHeaders?: readonly string[];
  networkResponseHeaders?: readonly string[];
}

export interface ReplayNetworkDetails {
  url: string;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
}

export interface NetworkHeaderPolicy {
  isAllowed(url: unknown): boolean;
  filterHeaders(headers: unknown, direction: 'request' | 'response'): Record<string, string>;
}

const DEFAULT_HEADERS = ['content-type', 'content-length', 'accept'];
const MAX_HEADERS = 20;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_BYTES = 1024;
const MAX_TOTAL_BYTES = 4096;
const MAX_SCANNED_HEADERS = 200;
const MAX_CONFIG_ENTRIES = 100;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const SENSITIVE_HEADER =
  /auth|cookie|token|api[-_]?key|password|passwd|secret|credential|session|csrf|xsrf|openid|unionid|^proxy-|^sec-|^sentry-|^baggage$|^x-forwarded-|^forwarded$|^x-real-ip$|^__proto__$|^prototype$|^constructor$/i;

/** Read only own data fields: inspecting telemetry must never invoke application getters. */
export function readNetworkDataField(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotList(
  value: unknown,
  allowPatterns: boolean,
  strict = false,
): readonly (string | RegExp)[] {
  const result: (string | RegExp)[] = [];
  try {
    if (value === undefined) return Object.freeze(result);
    if (!Array.isArray(value) || value.length > MAX_CONFIG_ENTRIES) {
      return strict ? Object.freeze([Object.freeze(/.*/)]) : Object.freeze(result);
    }
    for (let index = 0; index < Math.min(value.length, MAX_CONFIG_ENTRIES); index++) {
      const item = readNetworkDataField(value, String(index));
      if (typeof item === 'string' && item.length > 0 && item.length <= 2048) {
        result.push(item);
      } else if (allowPatterns && item instanceof RegExp && item.source.length <= 2048) {
        result.push(Object.freeze(new RegExp(item.source, item.flags)));
      } else if (strict) {
        return Object.freeze([Object.freeze(/.*/)]);
      }
    }
  } catch {
    if (strict) return Object.freeze([Object.freeze(/.*/)]);
    // Invalid allow/header configuration cannot add new permissions.
  }
  return Object.freeze(result);
}

function snapshotDenyUrls(options: NetworkDetailOptions): readonly (string | RegExp)[] {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'networkDetailDenyUrls');
    if (descriptor && !('value' in descriptor)) return Object.freeze([Object.freeze(/.*/)]);
    return snapshotList(descriptor?.value, true, true);
  } catch {
    return Object.freeze([Object.freeze(/.*/)]);
  }
}

/** All keys are present so spreading a snapshot cannot reintroduce later caller changes. */
export function snapshotNetworkOptions(
  options: NetworkDetailOptions,
): Required<NetworkDetailOptions> {
  return Object.freeze({
    networkDetailAllowUrls: snapshotList(
      readNetworkDataField(options, 'networkDetailAllowUrls'),
      true,
    ),
    networkDetailDenyUrls: snapshotDenyUrls(options),
    networkRequestHeaders: snapshotList(
      readNetworkDataField(options, 'networkRequestHeaders'),
      false,
    ) as readonly string[],
    networkResponseHeaders: snapshotList(
      readNetworkDataField(options, 'networkResponseHeaders'),
      false,
    ) as readonly string[],
  });
}

/** Removes credentials before URL matching as well as query/fragment secrets. */
export function sanitizeNetworkDetailUrl(url: string): string {
  const clean =
    url
      .replace(/[\t\r\n]/g, '')
      .trim()
      .split(/[?#]/, 1)[0] || '';
  if (/^(?:data|javascript|blob|file):/i.test(clean)) return '';
  return clean.replace(
    /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/]*)/i,
    (_match, scheme: string, authority: string) =>
      `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}`,
  );
}

function matches(url: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) => {
    try {
      // A fresh RegExp also keeps g/y matching independent of frozen/caller lastIndex.
      return typeof pattern === 'string'
        ? url.includes(pattern)
        : new RegExp(pattern.source, pattern.flags).test(url);
    } catch {
      return false;
    }
  });
}

function byteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function createNetworkHeaderPolicy(options: NetworkDetailOptions): NetworkHeaderPolicy {
  const config = snapshotNetworkOptions(options);
  const names = (extra: readonly string[]): Set<string> =>
    new Set([...DEFAULT_HEADERS, ...extra.map((name) => name.toLowerCase())]);
  const requestNames = names(config.networkRequestHeaders);
  const responseNames = names(config.networkResponseHeaders);
  return {
    isAllowed(url: unknown): boolean {
      if (typeof url !== 'string') return false;
      const clean = sanitizeNetworkDetailUrl(url);
      return (
        !!clean &&
        !matches(clean, config.networkDetailDenyUrls) &&
        matches(clean, config.networkDetailAllowUrls)
      );
    },
    filterHeaders(headers: unknown, direction: 'request' | 'response'): Record<string, string> {
      const output: Record<string, string> = {};
      const allowedNames = direction === 'request' ? requestNames : responseNames;
      let bytes = 0;
      let count = 0;
      try {
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return output;
        for (const originalName of Object.keys(headers).slice(0, MAX_SCANNED_HEADERS)) {
          const name = originalName.toLowerCase();
          if (
            name.length > MAX_NAME_LENGTH ||
            !HEADER_NAME.test(name) ||
            SENSITIVE_HEADER.test(name) ||
            !allowedNames.has(name) ||
            Object.prototype.hasOwnProperty.call(output, name)
          )
            continue;
          const raw = readNetworkDataField(headers, originalName);
          if (
            typeof raw !== 'string' &&
            typeof raw !== 'boolean' &&
            !(typeof raw === 'number' && Number.isFinite(raw))
          )
            continue;
          const value = String(raw);
          if (
            value.length > MAX_VALUE_BYTES ||
            Array.from(value).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            continue;
          const valueBytes = byteLength(value);
          const fieldBytes = name.length + valueBytes;
          if (valueBytes > MAX_VALUE_BYTES || bytes + fieldBytes > MAX_TOTAL_BYTES) continue;
          output[name] = value;
          bytes += fieldBytes;
          if (++count >= MAX_HEADERS) break;
        }
      } catch {
        // Proxies and unusual platform response objects must not break the request.
      }
      return output;
    },
  };
}
