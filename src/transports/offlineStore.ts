import type { Envelope, OfflineStore, OfflineTransportOptions } from '@sentry/core';
import { sdk } from '../crossPlatform';
import { replayIdentity } from './replayIdentity';

const DEFAULT_OFFLINE_CACHE_SIZE = 30;
const DEFAULT_MAX_AGE = 86400000; // 24 小时
const OFFLINE_STORE_KEY = 'sentry_offline_store';
// 微信等平台单 key storage 上限约 1MB；留余量到 900KB，超出则按淘汰策略丢弃再写，
// 避免 setStorageSync 因超限抛错导致整批离线缓存写入静默失败。
const DEFAULT_MAX_STORE_BYTES = 900 * 1024;

interface CachedEnvelope {
  envelope: Envelope;
  timestamp: number;
  binaryPayloads?: number[];
}

/** 因超限 / 过期丢弃事件的原因。 */
export type DropReason = 'count' | 'bytes' | 'age';

/**
 * 缓存淘汰策略：
 * - `'error-priority'`（默认，弱网重试场景）：满则优先丢弃最旧的非 error 事件，保留异常。
 * - `'preserve-oldest'`（同意门禁场景）：满则从**最新**端丢弃，保留最旧的冷启动数据。
 */
export type EvictionMode = 'error-priority' | 'preserve-oldest';

export interface MiniappOfflineStoreOptions extends OfflineTransportOptions {
  offlineCacheLimit?: number;
  /** Isolate projects/clients; omitted only for legacy direct store callers. */
  storageKey?: string;
  /** 离线缓存过期时间（ms），默认 86400000 (24h) */
  offlineCacheMaxAge?: number;
  /** 单 key 字节上限（默认约 900KB，受平台 Storage 限制） */
  maxBytes?: number;
  /** 淘汰策略，默认 `'error-priority'` */
  evictionMode?: EvictionMode;
  /** 因超限 / 过期丢弃事件时回调（用于可观测，如同意前缓存丢弃统计） */
  onDrop?: (reason: DropReason, dropped: number) => void;
  /** @internal Scheduler requires an explicit rejection when persistence fails. */
  strictPersistence?: boolean;
  /** @internal Preserve Replay prefixes and notify the sender about lost dependencies. */
  protectReplayOrder?: boolean;
  /** @internal Individual losses, including dependent Replay suffixes. */
  onDiscardEnvelope?: (envelope: Envelope, reason: DropReason) => void;
}

/**
 * Creates an offline store using miniapp storage API.
 * 支持事件过期淘汰、按条数 / 体积上限淘汰，以及两种淘汰策略（见 {@link EvictionMode}）。
 */
export interface MiniappOfflineStore extends OfflineStore {
  /** @internal Read without removing the in-flight persisted prefix. */
  peek(): Promise<Envelope | undefined>;
  /** @internal Remove an acknowledged/discarded envelope. */
  remove(envelope: Envelope): Promise<void>;
}

export function createMiniappOfflineStore(
  options: MiniappOfflineStoreOptions,
): MiniappOfflineStore {
  // 用 ?? 而非 ||：尊重显式的 0（|| 会把 0 当成未设置而回退默认值）。
  const maxCacheSize = boundedLimit(options.offlineCacheLimit, DEFAULT_OFFLINE_CACHE_SIZE);
  const storageKey = options.storageKey || OFFLINE_STORE_KEY;
  const maxAge = boundedLimit(options.offlineCacheMaxAge, DEFAULT_MAX_AGE);
  const maxBytes = Math.min(
    DEFAULT_MAX_STORE_BYTES,
    boundedLimit(options.maxBytes, DEFAULT_MAX_STORE_BYTES),
  );
  const evictionMode = options.evictionMode ?? 'error-priority';
  const onDrop = options.onDrop;
  const originalTimestamps = new WeakMap<Envelope, number>();

  function report(reason: DropReason, dropped: number): void {
    if (dropped > 0 && typeof onDrop === 'function') {
      try {
        onDrop(reason, dropped);
      } catch (_e) {
        // 回调里抛错不应影响 store 主流程
      }
    }
  }

  function discard(store: CachedEnvelope[], index: number, reason: DropReason): number {
    const removed = store.splice(index, 1);
    const identity = removed[0] && replayIdentity(removed[0].envelope);
    if (options.protectReplayOrder && identity) {
      for (let i = store.length - 1; i >= 0; i--) {
        const other = replayIdentity(store[i]!.envelope);
        if (other?.id === identity.id && other.segment >= identity.segment)
          removed.push(...store.splice(i, 1));
      }
    }
    for (const item of removed) {
      try {
        options.onDiscardEnvelope?.(item.envelope, reason);
      } catch {
        /* observational */
      }
    }
    return removed.length;
  }

  function evictExpired(store: CachedEnvelope[]): CachedEnvelope[] {
    let dropped = 0;
    for (let index = store.length - 1; index >= 0; index--) {
      if (store[index] && Date.now() - store[index]!.timestamp >= maxAge)
        dropped += discard(store, index, 'age');
    }
    report('age', dropped);
    return store;
  }

  function dropIndex(
    store: CachedEnvelope[],
    context: 'push' | 'unshift',
    incoming?: Envelope,
  ): number {
    const identity = incoming && replayIdentity(incoming);
    // A newly queued suffix must never evict its own required predecessor.
    if (
      options.protectReplayOrder &&
      identity &&
      context === 'push' &&
      store.some((item) => {
        const previous = replayIdentity(item.envelope);
        return previous?.id === identity.id && previous.segment < identity.segment;
      })
    ) {
      const index = store.findIndex((item) => item.envelope === incoming);
      if (index >= 0) return index;
    }
    if (evictionMode === 'preserve-oldest') return store.length - 1;
    if (context === 'unshift') {
      const index = findLastIndex(store, (item) => !isErrorEnvelope(item.envelope));
      return index >= 0 ? index : store.length - 1;
    }
    const index = store.findIndex((item) => !isErrorEnvelope(item.envelope));
    return index >= 0 ? index : 0;
  }

  function evictByCount(
    store: CachedEnvelope[],
    context: 'push' | 'unshift',
    incoming: Envelope,
  ): number {
    let dropped = 0;
    while (store.length > maxCacheSize)
      dropped += discard(store, dropIndex(store, context, incoming), 'count');
    return dropped;
  }

  function persist(
    store: CachedEnvelope[],
    context: 'push' | 'unshift' = 'push',
    incoming?: Envelope,
  ): CachedEnvelope[] {
    const storageApi = sdk().setStorageSync;
    if (!storageApi) {
      if (options.strictPersistence) throw new Error('Offline storage is unavailable');
      return [];
    }
    let serialized = serializeStore(store);
    let dropped = 0;
    while (store.length > 0 && utf8ByteLength(serialized) > maxBytes) {
      dropped += discard(store, dropIndex(store, context, incoming), 'bytes');
      serialized = serializeStore(store);
    }
    report('bytes', dropped);
    try {
      storageApi(storageKey, serialized);
      return store;
    } catch (error) {
      if (options.strictPersistence) throw error;
      return [];
    }
  }

  return {
    peek: async () => {
      const store = getStore(storageKey, options.strictPersistence);
      const before = store.length;
      evictExpired(store);
      if (before !== store.length) persist(store);
      return store[0]?.envelope;
    },
    remove: async (env) => {
      const store = getStore(storageKey, options.strictPersistence);
      const key = JSON.stringify(env);
      const index = store.findIndex((item) => JSON.stringify(item.envelope) === key);
      if (index >= 0) store.splice(index, 1);
      persist(store);
    },
    push: async (env: Envelope): Promise<void> => {
      try {
        const store = evictExpired(getStore(storageKey, options.strictPersistence));
        store.push({ envelope: env, timestamp: Date.now() });
        report('count', evictByCount(store, 'push', env));
        const kept = persist(store, 'push', env);
        if (options.strictPersistence && !kept.some((item) => item.envelope === env))
          throw new Error('Offline queue capacity exceeded');
      } catch (e) {
        if (options.strictPersistence) throw e;
        console.warn('[sentry-miniapp] Failed to push to offline store', e);
      }
    },
    unshift: async (env: Envelope): Promise<void> => {
      try {
        const store = evictExpired(getStore(storageKey, options.strictPersistence));
        // A failed retry must not restart the retention period indefinitely.
        store.unshift({ envelope: env, timestamp: originalTimestamps.get(env) ?? Date.now() });
        report('count', evictByCount(store, 'unshift', env));
        const kept = persist(store, 'unshift', env);
        if (options.strictPersistence && !kept.some((item) => item.envelope === env))
          throw new Error('Offline queue capacity exceeded');
      } catch (e) {
        if (options.strictPersistence) throw e;
        console.warn('[sentry-miniapp] Failed to unshift to offline store', e);
      }
    },
    shift: async (): Promise<Envelope | undefined> => {
      try {
        const before = getStore(storageKey, options.strictPersistence);
        const hadItems = before.length > 0;
        const store = evictExpired(before);
        if (store.length === 0) {
          if (hadItems) {
            persist(store);
          }
          return undefined;
        }
        const item = store.shift();
        if (item) originalTimestamps.set(item.envelope, item.timestamp);
        persist(store);
        return item?.envelope;
      } catch (e) {
        if (options.strictPersistence) throw e;
        console.warn('[sentry-miniapp] Failed to shift from offline store', e);
        return undefined;
      }
    },
  };
}

/**
 * 判断 envelope 是否包含错误事件
 */
function isErrorEnvelope(envelope: Envelope): boolean {
  try {
    const items = envelope[1] || [];
    return items.some((item: any) => {
      const itemType = item[0]?.type;
      return itemType === 'event' || itemType === 'error';
    });
  } catch (_e) {
    return true; // 无法判断时当作错误事件保留
  }
}

/**
 * 从后往前查找匹配项的索引
 */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function getStore(storageKey: string, strict = false): CachedEnvelope[] {
  const storageApi = sdk().getStorageSync;
  if (!storageApi) {
    return [];
  }
  let storedStr: any;
  try {
    storedStr = storageApi(storageKey);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
  if (!storedStr) {
    return [];
  }
  try {
    const parsed = typeof storedStr === 'string' ? JSON.parse(storedStr) : storedStr;
    // 兼容旧版本格式（直接存储 Envelope[]）
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (parsed[0] && 'envelope' in parsed[0] && 'timestamp' in parsed[0]) {
        return parsed.map(restoreBinaryPayloads);
      }
      // 旧格式：直接是 Envelope 数组，迁移为新格式
      return parsed.map((env: Envelope) => ({
        envelope: env,
        timestamp: Date.now(),
      }));
    }
    return [];
  } catch (_e) {
    // 解析失败 = 存储被写坏（部分写入 / 配额截断等）。主动清键自愈，避免坏数据常驻、
    // 让后续 flush 永远读到空，且坏 blob 一直占着这个 key 的空间。
    removeStore(storageKey);
    return [];
  }
}

function removeStore(storageKey: string): void {
  try {
    const removeApi = sdk().removeStorageSync;
    if (removeApi) {
      removeApi(storageKey);
    }
  } catch (_e) {
    // ignore
  }
}

/** 估算字符串的 UTF-8 字节数（小程序运行时不保证有 TextEncoder），用于体积上限判断。 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个 4 字节字符，跳过低位代理
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function serializeStore(store: CachedEnvelope[]): string {
  return JSON.stringify(
    store.map((cached) => {
      const binaryPayloads: number[] = [];
      const items = cached.envelope[1].map((item, index) => {
        if (!(item[1] instanceof Uint8Array)) return item;
        binaryPayloads.push(index);
        return [item[0], Array.from(item[1])];
      });
      return {
        ...cached,
        envelope: [cached.envelope[0], items],
        ...(binaryPayloads.length ? { binaryPayloads } : {}),
      };
    }),
  );
}

function restoreBinaryPayloads(cached: CachedEnvelope): CachedEnvelope {
  if (!cached.binaryPayloads?.length) return cached;
  const binaryPayloads = new Set(cached.binaryPayloads);
  const items = cached.envelope[1].map((item, index) =>
    binaryPayloads.has(index) && Array.isArray(item[1]) ? [item[0], new Uint8Array(item[1])] : item,
  );
  return { timestamp: cached.timestamp, envelope: [cached.envelope[0], items] as Envelope };
}
