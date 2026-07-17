/**
 * PROTOTYPE — Taro virtual DOM -> rrweb event recorder.
 *
 * Question being tested: can Taro's in-memory DOM and MutationObserver produce
 * a small, Sentry-compatible rrweb recording without a browser DOM?
 *
 * This module is deliberately opt-in and has no persistence or automatic SDK
 * integration. It should remain on the replay POC branch until the experiment
 * has been evaluated in a real mini program.
 */

import type { Breadcrumb } from '@sentry/core';

export const TARO_DOM_REPLAY_POC_MARKER = 'TARO_DOM_REPLAY_POC';

const enum RrwebEventType {
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
}

const enum RrwebNodeType {
  Document = 0,
  Element = 2,
  Text = 3,
  Comment = 5,
}

const enum RrwebIncrementalSource {
  Mutation = 0,
}

interface TaroAttributeLike {
  name: string;
  value: unknown;
}

export interface TaroReplayNodeLike {
  nodeType: number;
  nodeName?: string;
  tagName?: string;
  sid?: string;
  uid?: string;
  textContent?: string | null;
  parentNode?: TaroReplayNodeLike | null;
  childNodes?: TaroReplayNodeLike[];
  attributes?: TaroAttributeLike[] | ArrayLike<TaroAttributeLike>;
  getAttribute?: (name: string) => unknown;
  hasAttribute?: (name: string) => boolean;
}

export interface TaroReplayMutationRecordLike {
  type: 'attributes' | 'characterData' | 'childList';
  target: TaroReplayNodeLike;
  addedNodes?: TaroReplayNodeLike[] | ArrayLike<TaroReplayNodeLike>;
  removedNodes?: TaroReplayNodeLike[] | ArrayLike<TaroReplayNodeLike>;
  nextSibling?: TaroReplayNodeLike | null;
  previousSibling?: TaroReplayNodeLike | null;
  attributeName?: string | null;
}

export interface TaroReplayMutationObserverLike {
  observe(target: TaroReplayNodeLike, options: Record<string, boolean>): void;
  disconnect(): void;
}

export interface TaroReplayMutationObserverConstructor {
  new (callback: (records: TaroReplayMutationRecordLike[]) => void): TaroReplayMutationObserverLike;
}

interface SerializedNodeBase {
  id: number;
  type: RrwebNodeType;
}

interface SerializedDocumentNode extends SerializedNodeBase {
  type: RrwebNodeType.Document;
  childNodes: SerializedNode[];
}

interface SerializedElementNode extends SerializedNodeBase {
  type: RrwebNodeType.Element;
  tagName: string;
  attributes: Record<string, string | number | true | null>;
  childNodes: SerializedNode[];
}

interface SerializedTextNode extends SerializedNodeBase {
  type: RrwebNodeType.Text | RrwebNodeType.Comment;
  textContent: string;
}

type SerializedNode = SerializedDocumentNode | SerializedElementNode | SerializedTextNode;

export interface TaroReplayPocEvent {
  type: RrwebEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface TaroReplayPocMetadata {
  environment?: string;
  release?: string;
  sdk?: {
    name: string;
    version: string;
  };
  user?: Record<string, unknown>;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, Record<string, unknown>>;
}

export interface TaroReplayPocCapture {
  marker: typeof TARO_DOM_REPLAY_POC_MARKER;
  version: 1;
  replayId: string;
  href: string;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  events: TaroReplayPocEvent[];
  metadata: TaroReplayPocMetadata | undefined;
  stats: {
    eventCount: number;
    mutationCount: number;
    breadcrumbCount: number;
    networkCount: number;
    approximateBytes: number;
  };
  warnings: string[];
}

export interface StartTaroDomReplayPocOptions {
  root: TaroReplayNodeLike;
  MutationObserver: TaroReplayMutationObserverConstructor;
  href?: string;
  width?: number;
  height?: number;
  maskInputValues?: boolean;
  maxDurationMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  metadata?: TaroReplayPocMetadata;
  now?: () => number;
  onEvent?: (event: TaroReplayPocEvent) => void;
  onStop?: (capture: TaroReplayPocCapture) => void;
}

export interface TaroDomReplayPocController {
  addBreadcrumb(breadcrumb: Breadcrumb): boolean;
  getCapture(): TaroReplayPocCapture;
  stop(reason?: string): TaroReplayPocCapture;
}

const TAG_MAP: Record<string, string> = {
  root: 'div',
  view: 'div',
  text: 'span',
  image: 'img',
  input: 'input',
  textarea: 'textarea',
  button: 'button',
  form: 'form',
  label: 'label',
  scrollview: 'div',
  'scroll-view': 'div',
  swiper: 'div',
  'swiper-item': 'div',
};

const SELF_CLOSING_TAGS = new Set(['img', 'input']);
const SYNTHETIC_NODE_MAX_ID = 9;

function makeReplayId(now: number): string {
  const time = now.toString(16).padStart(12, '0');
  let random = '';
  while (random.length < 20) {
    random += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return `${time}${random}`.slice(0, 32);
}

function toArray<T>(value: T[] | ArrayLike<T> | undefined): T[] {
  return value ? Array.from(value) : [];
}

function normaliseNodeName(node: TaroReplayNodeLike): string {
  return (node.nodeName || node.tagName || 'unknown').toLowerCase();
}

function primitiveAttributeValue(value: unknown): string | number | true | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return true;
  if (typeof value === 'number') return value;
  return String(value);
}

function maskValue(value: unknown): string {
  return '*'.repeat(Math.max(1, String(value ?? '').length));
}

function isInputNode(node: TaroReplayNodeLike): boolean {
  const nodeName = normaliseNodeName(node);
  return nodeName === 'input' || nodeName === 'textarea';
}

function sanitizeAttributeValue(
  node: TaroReplayNodeLike,
  name: string,
  value: unknown,
  maskInputValues: boolean,
): string | number | true | null {
  const safeValue =
    maskInputValues && isInputNode(node) && name === 'value' ? maskValue(value) : value;
  return primitiveAttributeValue(safeValue);
}

function cloneCapture(capture: TaroReplayPocCapture): TaroReplayPocCapture {
  return {
    ...capture,
    events: capture.events.slice(),
    metadata: capture.metadata
      ? {
          ...capture.metadata,
          ...(capture.metadata.sdk ? { sdk: { ...capture.metadata.sdk } } : {}),
          ...(capture.metadata.user ? { user: { ...capture.metadata.user } } : {}),
          ...(capture.metadata.tags ? { tags: { ...capture.metadata.tags } } : {}),
          ...(capture.metadata.contexts
            ? { contexts: JSON.parse(JSON.stringify(capture.metadata.contexts)) }
            : {}),
        }
      : undefined,
    stats: { ...capture.stats },
    warnings: capture.warnings.slice(),
  };
}

/**
 * Starts the throwaway Taro DOM recorder. Call this after the Taro page root is
 * mounted (for example in useReady), and call stop from useUnload.
 */
export function startTaroDomReplayPoc(
  options: StartTaroDomReplayPocOptions,
): TaroDomReplayPocController {
  if (!options.root || typeof options.root !== 'object') {
    throw new Error('[sentry-miniapp replay POC] A mounted Taro root node is required');
  }

  const now = options.now || Date.now;
  const startedAt = now();
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  const maxEvents = options.maxEvents ?? 500;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maskInputValues = options.maskInputValues !== false;
  const warnings = new Set<string>();
  const idsBySid = new Map<string, number>();
  const idsByNode = new WeakMap<object, number>();
  let lastEventTimestamp = startedAt - 1;
  let nextNodeId = SYNTHETIC_NODE_MAX_ID + 1;
  let mutationCount = 0;
  let stopped = false;
  const resources: {
    timer?: ReturnType<typeof setTimeout>;
    observer?: TaroReplayMutationObserverLike;
  } = {};

  const capture: TaroReplayPocCapture = {
    marker: TARO_DOM_REPLAY_POC_MARKER,
    version: 1,
    replayId: makeReplayId(startedAt),
    href: options.href || 'https://miniapp.local/replay-poc',
    startedAt,
    endedAt: null,
    stopReason: null,
    events: [],
    metadata: options.metadata,
    stats: {
      eventCount: 0,
      mutationCount: 0,
      breadcrumbCount: 0,
      networkCount: 0,
      approximateBytes: 0,
    },
    warnings: [],
  };

  function idFor(node: TaroReplayNodeLike): number {
    const sid = node.sid || node.uid;
    if (sid) {
      const existing = idsBySid.get(sid);
      if (existing !== undefined) return existing;
      const id = nextNodeId++;
      idsBySid.set(sid, id);
      idsByNode.set(node, id);
      return id;
    }

    const existing = idsByNode.get(node);
    if (existing !== undefined) return existing;
    const id = nextNodeId++;
    idsByNode.set(node, id);
    return id;
  }

  function readAttributes(node: TaroReplayNodeLike): Record<string, string | number | true | null> {
    const result: Record<string, string | number | true | null> = {
      'data-taro-node': normaliseNodeName(node),
    };

    for (const attribute of toArray(node.attributes)) {
      if (!attribute || !attribute.name || /^on/i.test(attribute.name)) continue;
      result[attribute.name] = sanitizeAttributeValue(
        node,
        attribute.name,
        attribute.value,
        maskInputValues,
      );
    }

    return result;
  }

  function serializeNode(node: TaroReplayNodeLike): SerializedNode {
    const nodeName = normaliseNodeName(node);
    if (node.nodeType === 3 || nodeName === '#text' || nodeName === 'comment') {
      const comment = nodeName === 'comment';
      return {
        id: idFor(node),
        type: comment ? RrwebNodeType.Comment : RrwebNodeType.Text,
        textContent: String(node.textContent ?? ''),
      };
    }

    const tagName = TAG_MAP[nodeName] || 'div';
    if (!TAG_MAP[nodeName])
      warnings.add(`unsupported Taro node rendered as placeholder: ${nodeName}`);
    const attributes = readAttributes(node);
    if (!TAG_MAP[nodeName]) attributes['data-taro-unsupported'] = nodeName;

    return {
      id: idFor(node),
      type: RrwebNodeType.Element,
      tagName,
      attributes,
      childNodes: SELF_CLOSING_TAGS.has(tagName) ? [] : toArray(node.childNodes).map(serializeNode),
    };
  }

  function fullSnapshot(): SerializedDocumentNode {
    const styleText: SerializedTextNode = {
      id: 6,
      type: RrwebNodeType.Text,
      textContent:
        'html,body{margin:0;padding:0;font-family:sans-serif} [data-taro-node="view"],[data-taro-node="root"]{display:block;box-sizing:border-box} [data-taro-unsupported]{outline:1px dashed #d20a10}',
    };
    const style: SerializedElementNode = {
      id: 5,
      type: RrwebNodeType.Element,
      tagName: 'style',
      attributes: {},
      childNodes: [styleText],
    };
    const head: SerializedElementNode = {
      id: 3,
      type: RrwebNodeType.Element,
      tagName: 'head',
      attributes: {},
      childNodes: [style],
    };
    const body: SerializedElementNode = {
      id: 4,
      type: RrwebNodeType.Element,
      tagName: 'body',
      attributes: {},
      childNodes: [serializeNode(options.root)],
    };
    const html: SerializedElementNode = {
      id: 2,
      type: RrwebNodeType.Element,
      tagName: 'html',
      attributes: {},
      childNodes: [head, body],
    };
    return {
      id: 1,
      type: RrwebNodeType.Document,
      childNodes: [html],
    };
  }

  function addEvent(event: TaroReplayPocEvent): boolean {
    const eventBytes = JSON.stringify(event).length;
    if (
      capture.events.length >= maxEvents ||
      capture.stats.approximateBytes + eventBytes > maxBytes
    ) {
      stop('limit');
      return false;
    }

    capture.events.push(event);
    capture.stats.eventCount = capture.events.length;
    capture.stats.approximateBytes += eventBytes;
    options.onEvent?.(event);
    return true;
  }

  function nextTimestamp(candidate = now()): number {
    lastEventTimestamp = Math.max(candidate, lastEventTimestamp + 1);
    return lastEventTimestamp;
  }

  function breadcrumbTimestampMs(breadcrumb: Breadcrumb): number {
    const timestamp = breadcrumb.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return now();
    return timestamp > 9_999_999_999 ? timestamp : timestamp * 1_000;
  }

  function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  function networkRequestOrResponse(size: unknown): Record<string, unknown> {
    const byteSize = finiteNumber(size);
    return {
      headers: {},
      ...(byteSize === undefined ? {} : { size: byteSize }),
      _meta: { warnings: ['URL_SKIPPED'] },
    };
  }

  function addBreadcrumb(breadcrumb: Breadcrumb): boolean {
    if (stopped || !breadcrumb || typeof breadcrumb.category !== 'string') return false;

    const timestampMs = breadcrumbTimestampMs(breadcrumb);
    const data = breadcrumb.data || {};
    const isNetwork =
      (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') &&
      typeof data['url'] === 'string';
    let event: TaroReplayPocEvent;

    if (isNetwork) {
      const endTimestamp = timestampMs / 1_000;
      const duration = finiteNumber(data['duration']) ?? 0;
      event = {
        type: RrwebEventType.Custom,
        timestamp: nextTimestamp(timestampMs),
        data: {
          tag: 'performanceSpan',
          payload: {
            op: `resource.${breadcrumb.category}`,
            description: data['url'],
            startTimestamp: Math.max(0, endTimestamp - duration / 1_000),
            endTimestamp,
            data: {
              method: typeof data['method'] === 'string' ? data['method'] : 'GET',
              statusCode: finiteNumber(data['status_code']) ?? 0,
              request: networkRequestOrResponse(data['request_body_size'] ?? data['request_size']),
              response: networkRequestOrResponse(
                data['response_body_size'] ?? data['response_size'],
              ),
            },
          },
        },
      };
    } else {
      event = {
        type: RrwebEventType.Custom,
        timestamp: nextTimestamp(timestampMs),
        data: {
          tag: 'breadcrumb',
          payload: {
            ...breadcrumb,
            timestamp: timestampMs / 1_000,
          },
        },
      };
    }

    if (!addEvent(event)) return false;
    if (isNetwork) capture.stats.networkCount++;
    else capture.stats.breadcrumbCount++;
    return true;
  }

  function currentAttributeValue(
    node: TaroReplayNodeLike,
    attributeName: string,
  ): string | number | true | null {
    // Taro keeps inline styles in Style.cssText rather than Element.props, so
    // hasAttribute('style') is false even while getAttribute('style') is valid.
    if (attributeName !== 'style' && node.hasAttribute && !node.hasAttribute(attributeName)) {
      return null;
    }
    const raw = node.getAttribute ? node.getAttribute(attributeName) : null;
    if (attributeName === 'style' && (raw === null || raw === undefined || raw === '')) return null;
    return sanitizeAttributeValue(node, attributeName, raw, maskInputValues);
  }

  function handleMutations(records: TaroReplayMutationRecordLike[]): void {
    if (stopped) return;
    const texts: Array<{ id: number; value: string }> = [];
    const attributes: Array<{
      id: number;
      attributes: Record<string, string | number | true | null>;
    }> = [];
    const removes: Array<{ parentId: number; id: number }> = [];
    const adds: Array<{ parentId: number; nextId: number | null; node: SerializedNode }> = [];

    for (const record of records) {
      mutationCount++;
      if (record.type === 'characterData') {
        texts.push({ id: idFor(record.target), value: String(record.target.textContent ?? '') });
      } else if (record.type === 'attributes' && record.attributeName) {
        attributes.push({
          id: idFor(record.target),
          attributes: {
            [record.attributeName]: currentAttributeValue(record.target, record.attributeName),
          },
        });
      } else if (record.type === 'childList') {
        const parentId = idFor(record.target);
        for (const removedNode of toArray(record.removedNodes)) {
          removes.push({ parentId, id: idFor(removedNode) });
        }
        for (const addedNode of toArray(record.addedNodes)) {
          adds.push({
            parentId,
            nextId: record.nextSibling ? idFor(record.nextSibling) : null,
            node: serializeNode(addedNode),
          });
        }
      }
    }

    if (!texts.length && !attributes.length && !removes.length && !adds.length) return;
    capture.stats.mutationCount = mutationCount;
    capture.warnings = Array.from(warnings);
    addEvent({
      type: RrwebEventType.IncrementalSnapshot,
      timestamp: nextTimestamp(),
      data: {
        source: RrwebIncrementalSource.Mutation,
        texts,
        attributes,
        removes,
        adds,
      },
    });
  }

  function stop(reason = 'manual'): TaroReplayPocCapture {
    if (stopped) return cloneCapture(capture);
    stopped = true;
    if (resources.timer) clearTimeout(resources.timer);
    resources.observer?.disconnect();
    capture.endedAt = Math.max(now(), lastEventTimestamp);
    capture.stopReason = reason;
    capture.warnings = Array.from(warnings);
    const result = cloneCapture(capture);
    options.onStop?.(result);
    return result;
  }

  const controller: TaroDomReplayPocController = {
    addBreadcrumb,
    getCapture: () => cloneCapture(capture),
    stop,
  };

  addEvent({
    type: RrwebEventType.Meta,
    timestamp: nextTimestamp(startedAt),
    data: {
      href: capture.href,
      width: options.width ?? 375,
      height: options.height ?? 667,
    },
  });
  addEvent({
    type: RrwebEventType.FullSnapshot,
    timestamp: nextTimestamp(startedAt),
    data: {
      node: fullSnapshot(),
      initialOffset: { top: 0, left: 0 },
    },
  });

  capture.warnings = Array.from(warnings);
  // A very small maxEvents/maxBytes can stop while the initial snapshot is
  // being appended. Do not create live resources after that terminal state.
  if (stopped) return controller;

  resources.observer = new options.MutationObserver(handleMutations);
  resources.observer.observe(options.root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  resources.timer = setTimeout(() => stop('duration'), maxDurationMs);

  return controller;
}
