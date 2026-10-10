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

import { uuid4, type Breadcrumb } from '@sentry/core';

import { normalizeReplayRpx, TARO_REPLAY_BASE_STYLESHEET } from './replay-styles';
import { boundReplayEvents } from './replay-buffer';

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
  Scroll = 3,
}

interface TaroAttributeLike {
  name: string;
  value: unknown;
}

export interface TaroReplayScrollEventLike {
  detail?: { scrollTop?: unknown; scrollLeft?: unknown; value?: unknown };
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
  addEventListener?: (type: string, listener: (event: TaroReplayScrollEventLike) => void) => void;
  removeEventListener?: (
    type: string,
    listener: (event: TaroReplayScrollEventLike) => void,
  ) => void;
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
  /** Trusted, caller-built page CSS using Replay selectors; no stylesheet is read at runtime. */
  stylesheet?: string;
  /** Audited build-time image sources; dynamic data URLs remain filtered. */
  staticImageSources?: Readonly<Record<string, string>>;
  /** Masks every Taro text node by default. Set to false only for privacy-safe content. */
  maskAllText?: boolean;
  /** Masks ordinary inputs by default; password and explicitly marked inputs always stay masked. */
  maskInputValues?: boolean;
  maxDurationMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  /** Keeps a rolling tail while retaining the initial Meta + FullSnapshot checkpoint. */
  rollingWindowMs?: number;
  /** Allows a process-wide coordinator to keep one id across root attachments. */
  replayId?: string;
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
  'root-portal': 'div',
  'picker-view': 'div',
  'picker-view-column': 'div',
};

const SELF_CLOSING_TAGS = new Set(['img', 'input']);
const SYNTHETIC_NODE_MAX_ID = 9;
const MAX_STATIC_IMAGE_SOURCE_BYTES = 128 * 1024;
const STATIC_IMAGE_DATA_URI =
  /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
const URL_ATTRIBUTE_NAMES = new Set(['action', 'formaction', 'href', 'poster', 'src']);
const INPUT_MASK_ATTRIBUTE_NAMES = new Set(['password', 'type', 'data-sentry-mask']);
const SENSITIVE_ATTRIBUTE_NAME =
  /(?:authorization|cookie|token|password|passwd|secret|api[-_]?key|open[-_]?id|union[-_]?id|phone|email|idcard|user[-_]?id|account)/i;

interface ScrollPosition {
  x: number;
  y: number;
}

// A still-mounted page retains its native offset when the buffer promotes and
// creates a new recorder. Weak keys release the offset with the virtual node.
const scrollPositions = new WeakMap<TaroReplayNodeLike, ScrollPosition>();
const pickerValues = new WeakMap<TaroReplayNodeLike, number[]>();

function isRootPortal(node: TaroReplayNodeLike): boolean {
  return normaliseNodeName(node) === 'root-portal';
}

function portalEnabled(node: TaroReplayNodeLike): boolean {
  const value = rawAttributeValue(node, 'enable');
  return isRootPortal(node) && value !== false && value !== 'false' && value !== 0;
}

function isPickerView(node: TaroReplayNodeLike): boolean {
  return normaliseNodeName(node) === 'picker-view';
}

function pickerColumns(node: TaroReplayNodeLike): TaroReplayNodeLike[] {
  return toArray(node.childNodes).filter(
    (child) => normaliseNodeName(child) === 'picker-view-column',
  );
}

function pickerRows(node: TaroReplayNodeLike): TaroReplayNodeLike[] {
  return toArray(node.childNodes).filter((child) => child.nodeType === 1);
}

function normalisePickerValues(node: TaroReplayNodeLike, value: unknown): number[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return pickerColumns(node).map((column, index) => {
    const numeric = Number(values[index]);
    const selected = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    return Math.min(selected, Math.max(0, pickerRows(column).length - 1));
  });
}

function getPickerValues(node: TaroReplayNodeLike): number[] {
  return normalisePickerValues(
    node,
    pickerValues.get(node) ??
      rawAttributeValue(node, 'value') ??
      rawAttributeValue(node, 'defaultvalue'),
  );
}

function hasNodeAncestor(
  node: TaroReplayNodeLike,
  predicate: (node: TaroReplayNodeLike) => boolean,
): boolean {
  for (
    let current: TaroReplayNodeLike | null | undefined = node;
    current;
    current = current.parentNode
  ) {
    if (predicate(current)) return true;
  }
  return false;
}

function containsRootPortal(node: TaroReplayNodeLike): boolean {
  return isRootPortal(node) || toArray(node.childNodes).some(containsRootPortal);
}

function isScrollView(node: TaroReplayNodeLike): boolean {
  const name = normaliseNodeName(node);
  return name === 'scroll-view' || name === 'scrollview';
}

function scrollCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getScrollPosition(node: TaroReplayNodeLike): ScrollPosition {
  const remembered = scrollPositions.get(node);
  if (remembered) return remembered;
  return {
    x:
      scrollCoordinate(rawAttributeValue(node, 'scrollLeft')) ??
      scrollCoordinate(rawAttributeValue(node, 'scroll-left')) ??
      0,
    y:
      scrollCoordinate(rawAttributeValue(node, 'scrollTop')) ??
      scrollCoordinate(rawAttributeValue(node, 'scroll-top')) ??
      0,
  };
}

function sanitizeUrl(value: string): string {
  if (value.startsWith('data:')) {
    const mimeType = value.match(/^data:([^;,]+)/)?.[1] || 'text/plain';
    return `data:${mimeType}`;
  }

  const withoutQueryOrFragment = value.split(/[?#]/, 1)[0] || '';
  return withoutQueryOrFragment.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]+@)/i,
    '$1[filtered]:[filtered]@',
  );
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
  return String(value ?? '').replace(/\S/gu, '*');
}

function isInputNode(node: TaroReplayNodeLike): boolean {
  const nodeName = normaliseNodeName(node);
  return nodeName === 'input' || nodeName === 'textarea';
}

function rawAttributeValue(node: TaroReplayNodeLike, name: string): unknown {
  const attribute = toArray(node.attributes).find(
    (item) => item && typeof item.name === 'string' && item.name.toLowerCase() === name,
  );
  if (attribute) return attribute.value;
  if (node.hasAttribute && !node.hasAttribute(name)) return undefined;
  const value = node.getAttribute?.(name);
  return !node.hasAttribute && value === '' ? undefined : value;
}

function hasMaskingFlag(node: TaroReplayNodeLike, name: string): boolean {
  const value = rawAttributeValue(node, name);
  return value === true || value === 1 || value === '' || value === 'true' || value === '1';
}

function sanitizeAttributeValue(
  node: TaroReplayNodeLike,
  name: string,
  value: unknown,
  maskInputValues: boolean,
): string | number | true | null {
  let safeValue = value;
  if (SENSITIVE_ATTRIBUTE_NAME.test(name)) {
    safeValue = '[Filtered]';
  } else if (maskInputValues && isInputNode(node) && name.toLowerCase() === 'value') {
    safeValue = maskValue(value);
  } else if (URL_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
    safeValue = sanitizeUrl(String(value ?? ''));
  }
  return primitiveAttributeValue(safeValue);
}

/** Counts UTF-8 bytes without relying on TextEncoder, which is absent in some mini program runtimes. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      /* istanbul ignore else -- JSON.stringify escapes unpaired UTF-16 surrogates. */
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
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
  const maskAllText = options.maskAllText !== false;
  const maskInputValues = options.maskInputValues !== false;
  const viewportWidth = options.width ?? 375;
  const stylesheet = normalizeReplayRpx(
    `${TARO_REPLAY_BASE_STYLESHEET}\n${options.stylesheet || ''}`,
    viewportWidth,
  );
  const sensitiveInputs = new WeakSet<TaroReplayNodeLike>();

  function shouldMaskInputValues(node: TaroReplayNodeLike): boolean {
    if (!isInputNode(node)) return false;
    if (
      hasMaskingFlag(node, 'password') ||
      String(rawAttributeValue(node, 'type') ?? '').toLowerCase() === 'password' ||
      hasMaskingFlag(node, 'data-sentry-mask')
    ) {
      // A password reveal toggle must not turn this recording's password field into clear text.
      sensitiveInputs.add(node);
    }
    return maskInputValues || sensitiveInputs.has(node);
  }
  const warnings = new Set<string>();
  const idsBySid = new Map<string, number>();
  const idsByNode = new WeakMap<object, number>();
  const lastTextValues = new WeakMap<object, string>();
  const lastAttributeValues = new WeakMap<object, Map<string, string | number | true | null>>();
  const scrollListeners = new Map<TaroReplayNodeLike, (event: TaroReplayScrollEventLike) => void>();
  const pickerListeners = new Map<TaroReplayNodeLike, (event: TaroReplayScrollEventLike) => void>();
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
    replayId: options.replayId || uuid4(),
    href: sanitizeUrl(options.href || 'https://miniapp.local/replay-poc'),
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

  function attachScrollSubtree(node: TaroReplayNodeLike): void {
    if (stopped) return;
    if (
      isScrollView(node) &&
      node.addEventListener &&
      node.removeEventListener &&
      !scrollListeners.has(node)
    ) {
      const listener = (event: TaroReplayScrollEventLike): void => {
        if (stopped || scrollListeners.get(node) !== listener) return;
        const previous = getScrollPosition(node);
        const position = {
          x: scrollCoordinate(event.detail?.scrollLeft) ?? previous.x,
          y: scrollCoordinate(event.detail?.scrollTop) ?? previous.y,
        };
        if (position.x === previous.x && position.y === previous.y) return;
        scrollPositions.set(node, position);
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: { source: RrwebIncrementalSource.Scroll, id: idFor(node), ...position },
        });
      };
      try {
        node.addEventListener('scroll', listener);
        scrollListeners.set(node, listener);
      } catch {
        // An unsupported event surface must not affect page rendering.
      }
    }
    if (
      isPickerView(node) &&
      node.addEventListener &&
      node.removeEventListener &&
      !pickerListeners.has(node)
    ) {
      const listener = (event: TaroReplayScrollEventLike): void => {
        if (
          stopped ||
          pickerListeners.get(node) !== listener ||
          !Array.isArray(event.detail?.value)
        )
          return;
        const previous = getPickerValues(node);
        const selected = normalisePickerValues(node, event.detail.value);
        if (selected.every((value, index) => value === previous[index])) return;
        pickerValues.set(node, selected);
        addEvent({
          type: RrwebEventType.IncrementalSnapshot,
          timestamp: nextTimestamp(),
          data: {
            source: RrwebIncrementalSource.Mutation,
            texts: [],
            removes: [],
            adds: [],
            attributes: pickerColumns(node).map((column) => ({
              id: idFor(column),
              attributes: readAttributes(column),
            })),
          },
        });
      };
      try {
        node.addEventListener('change', listener);
        pickerListeners.set(node, listener);
      } catch {
        // Hosts without native picker events still retain the initial selected rows.
      }
    }
    for (const child of toArray(node.childNodes)) attachScrollSubtree(child);
  }

  function detachScrollSubtree(node: TaroReplayNodeLike): void {
    const listener = scrollListeners.get(node);
    if (listener) {
      try {
        node.removeEventListener?.('scroll', listener);
      } catch {
        // Preserve native lifecycle behavior if a platform cannot remove a listener.
      }
      scrollListeners.delete(node);
    }
    const pickerListener = pickerListeners.get(node);
    if (pickerListener) {
      try {
        node.removeEventListener?.('change', pickerListener);
      } catch {
        // Keep recorder teardown separate from application event handlers.
      }
      pickerListeners.delete(node);
    }
    for (const child of toArray(node.childNodes)) detachScrollSubtree(child);
  }

  function replayAttributeValue(
    node: TaroReplayNodeLike,
    name: string,
    value: unknown,
    maskNodeInputValues: boolean,
  ): string | number | true | null {
    if (
      normaliseNodeName(node) === 'image' &&
      name.toLowerCase() === 'src' &&
      typeof value === 'string'
    ) {
      const sources = options.staticImageSources;
      const trusted =
        sources && Object.prototype.hasOwnProperty.call(sources, value)
          ? sources[value]
          : undefined;
      if (
        typeof trusted === 'string' &&
        trusted.length <= MAX_STATIC_IMAGE_SOURCE_BYTES &&
        STATIC_IMAGE_DATA_URI.test(trusted)
      )
        return trusted;
    }
    return sanitizeAttributeValue(node, name, value, maskNodeInputValues);
  }

  function pickerPlaybackStyle(node: TaroReplayNodeLike, original: unknown): string {
    const declarations = [typeof original === 'string' ? original : ''];
    if (isPickerView(node)) {
      const indicator = String(rawAttributeValue(node, 'indicatorstyle') ?? '');
      const height = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(indicator)?.[1] ?? '34px';
      declarations.push(
        `--taro-replay-picker-item-height:${normalizeReplayRpx(height, viewportWidth)}`,
      );
    } else if (
      normaliseNodeName(node) === 'picker-view-column' &&
      node.parentNode &&
      isPickerView(node.parentNode)
    ) {
      const index = pickerColumns(node.parentNode).indexOf(node);
      declarations.push(
        `--taro-replay-picker-selected:${getPickerValues(node.parentNode)[index] ?? 0}`,
      );
    } else if (node.parentNode && normaliseNodeName(node.parentNode) === 'picker-view-column') {
      declarations.push(`--taro-replay-picker-row:${pickerRows(node.parentNode).indexOf(node)}`);
    }
    return declarations.filter(Boolean).join(';');
  }

  function readAttributes(node: TaroReplayNodeLike): Record<string, string | number | true | null> {
    const result: Record<string, string | number | true | null> = {
      'data-taro-node': normaliseNodeName(node),
    };
    const remembered = new Map<string, string | number | true | null>();
    const maskNodeInputValues = shouldMaskInputValues(node);

    for (const attribute of toArray(node.attributes)) {
      if (!attribute || !attribute.name || /^on/i.test(attribute.name)) continue;
      let value = replayAttributeValue(node, attribute.name, attribute.value, maskNodeInputValues);
      if (attribute.name === 'style' && typeof value === 'string') {
        value = normalizeReplayRpx(value, viewportWidth);
      }
      const playbackName = attribute.name === 'className' ? 'class' : attribute.name;
      result[playbackName] = value;
      remembered.set(attribute.name, value);
    }
    if (isScrollView(node)) {
      const position = getScrollPosition(node);
      result['rr_scrollTop'] = position.y;
      result['rr_scrollLeft'] = position.x;
    }
    if (
      isPickerView(node) ||
      normaliseNodeName(node) === 'picker-view-column' ||
      normaliseNodeName(node.parentNode ?? node) === 'picker-view-column'
    ) {
      result['style'] = pickerPlaybackStyle(node, result['style']);
      if (normaliseNodeName(node.parentNode ?? node) === 'picker-view-column')
        result['data-taro-picker-row'] = true;
    }
    lastAttributeValues.set(node, remembered);

    return result;
  }

  function serializeChildren(
    node: TaroReplayNodeLike,
    portals?: SerializedElementNode[],
  ): SerializedNode[] {
    const children: SerializedNode[] = [];
    for (const child of toArray(node.childNodes)) {
      const serialized = serializeNode(child, portals);
      if (portals && portalEnabled(child)) portals.push(serialized as SerializedElementNode);
      else children.push(serialized);
    }
    return children;
  }

  function serializeNode(
    node: TaroReplayNodeLike,
    portals?: SerializedElementNode[],
  ): SerializedNode {
    const nodeName = normaliseNodeName(node);
    if (node.nodeType === 3 || nodeName === '#text' || nodeName === 'comment') {
      const comment = nodeName === 'comment';
      const textContent = maskAllText
        ? maskValue(node.textContent)
        : String(node.textContent ?? '');
      lastTextValues.set(node, textContent);
      return {
        id: idFor(node),
        type: comment ? RrwebNodeType.Comment : RrwebNodeType.Text,
        textContent,
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
      childNodes: SELF_CLOSING_TAGS.has(tagName) ? [] : serializeChildren(node, portals),
    };
  }

  function fullSnapshot(): SerializedDocumentNode {
    const styleText: SerializedTextNode = {
      id: 6,
      type: RrwebNodeType.Text,
      textContent: stylesheet,
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
    const portals: SerializedElementNode[] = [];
    const root = serializeNode(options.root, portals);
    const body: SerializedElementNode = {
      id: 4,
      type: RrwebNodeType.Element,
      tagName: 'body',
      attributes: {},
      childNodes: [root, ...portals],
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
    if (stopped) return false;
    const eventBytes = utf8ByteLength(JSON.stringify(event));
    if (options.rollingWindowMs !== undefined) {
      const meta = capture.events[0];
      if (event.type === RrwebEventType.FullSnapshot && meta?.type === RrwebEventType.Meta) {
        const alignedMeta = { ...meta, timestamp: event.timestamp - 1 };
        const checkpointBytes = utf8ByteLength(JSON.stringify(alignedMeta)) + eventBytes;
        if (checkpointBytes > maxBytes || maxEvents < 2) {
          stop('limit');
          return false;
        }
        if (
          capture.events.length >= 2 &&
          (capture.stats.approximateBytes + eventBytes > maxBytes ||
            capture.events.length >= maxEvents)
        ) {
          // A complete new snapshot already contains the preceding DOM changes.
          // Replace the baseline instead of evicting that snapshot and keeping stale UI.
          capture.events = [alignedMeta, event];
          capture.startedAt = alignedMeta.timestamp;
          capture.stats.approximateBytes = checkpointBytes;
          capture.stats.eventCount = capture.events.length;
          options.onEvent?.(event);
          return true;
        }
      }
      const previousEvents = capture.events.slice();
      const previousStats = { ...capture.stats };
      capture.events.push(event);
      capture.stats.approximateBytes += eventBytes;
      if (capture.events.some((candidate) => candidate.type === RrwebEventType.FullSnapshot)) {
        const bounded = boundReplayEvents(capture.events, {
          now: event.timestamp,
          windowMs: options.rollingWindowMs,
          maxEvents,
          maxBytes,
        });
        if (!bounded.length) {
          capture.events = previousEvents;
          capture.stats = previousStats;
          stop('limit');
          return false;
        }
        capture.events = bounded;
        capture.startedAt = bounded[0]?.timestamp ?? capture.startedAt;
        capture.stats.approximateBytes = bounded.reduce(
          (total, candidate) => total + utf8ByteLength(JSON.stringify(candidate)),
          0,
        );
      }
      capture.stats.eventCount = capture.events.length;
      options.onEvent?.(event);
      return capture.events.includes(event);
    }
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
            description: sanitizeUrl(data['url'] as string),
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
    const raw = node.getAttribute
      ? node.getAttribute(attributeName)
      : rawAttributeValue(node, attributeName);
    if (
      attributeName === 'style' &&
      (isPickerView(node) ||
        normaliseNodeName(node) === 'picker-view-column' ||
        normaliseNodeName(node.parentNode ?? node) === 'picker-view-column')
    ) {
      return pickerPlaybackStyle(node, normalizeReplayRpx(String(raw ?? ''), viewportWidth));
    }
    if (attributeName === 'style' && (raw === null || raw === undefined || raw === '')) return null;
    const value = replayAttributeValue(node, attributeName, raw, shouldMaskInputValues(node));
    return attributeName === 'style' && typeof value === 'string'
      ? normalizeReplayRpx(value, viewportWidth)
      : value;
  }

  function handleMutations(records: TaroReplayMutationRecordLike[]): void {
    if (stopped) return;
    const visualCheckpoint = records.some(
      (record) =>
        (record.type === 'attributes' &&
          ((isRootPortal(record.target) && record.attributeName?.toLowerCase() === 'enable') ||
            (isPickerView(record.target) &&
              ['value', 'defaultvalue', 'indicatorstyle'].includes(
                record.attributeName?.toLowerCase() ?? '',
              )))) ||
        (record.type === 'childList' &&
          (hasNodeAncestor(record.target, isRootPortal) ||
            hasNodeAncestor(record.target, isPickerView) ||
            [...toArray(record.addedNodes), ...toArray(record.removedNodes)].some(
              containsRootPortal,
            ))),
    );
    if (visualCheckpoint) {
      for (const record of records) {
        mutationCount++;
        if (record.type === 'childList') {
          for (const node of toArray(record.removedNodes)) detachScrollSubtree(node);
          for (const node of toArray(record.addedNodes)) attachScrollSubtree(node);
        } else if (
          record.type === 'attributes' &&
          isPickerView(record.target) &&
          ['value', 'defaultvalue'].includes(record.attributeName?.toLowerCase() ?? '')
        ) {
          pickerValues.delete(record.target);
        }
      }
      addEvent({
        type: RrwebEventType.FullSnapshot,
        timestamp: nextTimestamp(),
        data: { node: fullSnapshot(), initialOffset: { top: 0, left: 0 } },
      });
      if (!stopped) capture.stats.mutationCount = mutationCount;
      capture.warnings = Array.from(warnings);
      return;
    }
    let needsStructuralCheckpoint = false;
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
        const value = maskAllText
          ? maskValue(record.target.textContent)
          : String(record.target.textContent ?? '');
        if (lastTextValues.get(record.target) === value) continue;
        lastTextValues.set(record.target, value);
        texts.push({
          id: idFor(record.target),
          value,
        });
      } else if (record.type === 'attributes' && record.attributeName) {
        const value = currentAttributeValue(record.target, record.attributeName);
        let remembered = lastAttributeValues.get(record.target);
        if (!remembered) {
          remembered = new Map<string, string | number | true | null>();
          lastAttributeValues.set(record.target, remembered);
        }
        const changedAttributes: Record<string, string | number | true | null> = {};
        if (
          !remembered.has(record.attributeName) ||
          remembered.get(record.attributeName) !== value
        ) {
          remembered.set(record.attributeName, value);
          const playbackName =
            record.attributeName === 'className' ? 'class' : record.attributeName;
          changedAttributes[playbackName] = value;
        }
        if (
          isInputNode(record.target) &&
          INPUT_MASK_ATTRIBUTE_NAMES.has(record.attributeName.toLowerCase())
        ) {
          // Changing an input into a password can require masking its existing value,
          // even when Taro does not emit a separate value mutation.
          const inputValue = currentAttributeValue(record.target, 'value');
          if (!remembered.has('value') || remembered.get('value') !== inputValue) {
            remembered.set('value', inputValue);
            changedAttributes['value'] = inputValue;
          }
        }
        if (!Object.keys(changedAttributes).length) continue;
        attributes.push({ id: idFor(record.target), attributes: changedAttributes });
      } else if (record.type === 'childList') {
        const parentId = idFor(record.target);
        for (const removedNode of toArray(record.removedNodes)) {
          detachScrollSubtree(removedNode);
          removes.push({ parentId, id: idFor(removedNode) });
        }
        for (const addedNode of toArray(record.addedNodes)) {
          if (addedNode.nodeType === 1) needsStructuralCheckpoint = true;
          adds.push({
            parentId,
            nextId: record.nextSibling ? idFor(record.nextSibling) : null,
            node: serializeNode(addedNode),
          });
          attachScrollSubtree(addedNode);
        }
      }
    }

    if (!texts.length && !attributes.length && !removes.length && !adds.length) return;
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
    if (!stopped) capture.stats.mutationCount = mutationCount;
    if (needsStructuralCheckpoint && !stopped) {
      addEvent({
        type: RrwebEventType.FullSnapshot,
        timestamp: nextTimestamp(),
        data: {
          node: fullSnapshot(),
          initialOffset: { top: 0, left: 0 },
        },
      });
    }
  }

  function stop(reason = 'manual'): TaroReplayPocCapture {
    if (stopped) return cloneCapture(capture);
    stopped = true;
    if (resources.timer) clearTimeout(resources.timer);
    resources.observer?.disconnect();
    for (const [node, listener] of pickerListeners) {
      try {
        node.removeEventListener?.('change', listener);
      } catch {
        /* Safe platform fallback. */
      }
    }
    pickerListeners.clear();
    for (const [node, listener] of scrollListeners) {
      try {
        node.removeEventListener?.('scroll', listener);
      } catch {
        // Cleanup never changes the host's unload result.
      }
    }
    scrollListeners.clear();
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
  attachScrollSubtree(options.root);
  resources.timer = setTimeout(() => stop('duration'), maxDurationMs);

  return controller;
}
