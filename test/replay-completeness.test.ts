import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  startTaroDomReplayPoc,
  type StartTaroDomReplayPocOptions,
  type TaroReplayMutationRecordLike,
  type TaroReplayNodeLike,
  type TaroReplayScrollEventLike,
  type TaroReplayPocEvent,
  type TaroReplayPocCapture,
} from '../src/replay-poc';
import { boundReplayEvents } from '../src/replay-buffer';
import { createCheckpointRebaser } from '../src/rebase';

let serial = 0;
interface Node extends TaroReplayNodeLike {
  props: Record<string, unknown>;
}
function element(name = 'view', props: Record<string, unknown> = {}, children: Node[] = []): Node {
  const result: Node = {
    nodeType: 1,
    nodeName: name,
    sid: String(++serial),
    props,
    childNodes: children,
    get attributes() {
      return Object.entries(this.props).map(([name, value]) => ({ name, value }));
    },
    getAttribute(name) {
      return this.props[name];
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.props, name);
    },
  };
  children.forEach((child) => {
    child.parentNode = result;
  });
  return result;
}
function text(value: string): Node {
  return { nodeType: 3, nodeName: '#text', sid: String(++serial), textContent: value, props: {} };
}
function harness(root: Node) {
  let callback = (_records: TaroReplayMutationRecordLike[]) => {};
  const listeners = new Map<string, (event: TaroReplayScrollEventLike) => void>();
  root.addEventListener = (name, fn) => {
    listeners.set(name, fn);
  };
  root.removeEventListener = (name) => {
    listeners.delete(name);
  };
  class Observer {
    constructor(fn: typeof callback) {
      callback = fn;
    }
    observe() {}
    disconnect = jest.fn();
  }
  return {
    MutationObserver: Observer,
    listeners,
    mutate: (records: TaroReplayMutationRecordLike[]) => callback(records),
    emit: (name: string, event: TaroReplayScrollEventLike) => listeners.get(name)?.(event),
  };
}
const active: ReturnType<typeof startTaroDomReplayPoc>[] = [];
function start(options: StartTaroDomReplayPocOptions) {
  const controller = startTaroDomReplayPoc(options);
  active.push(controller);
  return controller;
}
afterEach(() => {
  active.splice(0).forEach((controller) => controller.stop());
  jest.restoreAllMocks();
  jest.useRealTimers();
});
function json(events: unknown): string {
  return JSON.stringify(events);
}
function latestSnapshot(events: TaroReplayPocEvent[]): TaroReplayPocEvent {
  return events.filter((event) => event.type === 2).at(-1)!;
}

describe('Replay privacy and supported native events', () => {
  it.each([
    '//user:synthetic-password@example.test/a?synthetic-token=1#fragment',
    ' \nhttps://user:synthetic-password@example.test/a?synthetic-token=1',
    'ht\ttps://user:synthetic-password@example.test/a?synthetic-token=1',
    'https:user:synthetic-password@example.test/a?synthetic-token=1',
    'https:///user:synthetic-password@example.test/a?synthetic-token=1',
    'https:\\' + '\\user:synthetic-password@example.test/a?synthetic-token=1',
    'javascript:synthetic-password',
  ])('cleans URL credentials before snapshots, mutations and network capture: %s', (url) => {
    const root = element('image', { src: url });
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      href: url,
      blockAllMedia: false,
    });
    root.props['src'] = url + '/changed';
    h.mutate([{ type: 'attributes', target: root, attributeName: 'src' }]);
    controller.addBreadcrumb({ category: 'xhr', data: { url } });
    const captured = json(controller.getCapture());
    expect(captured).not.toContain('synthetic-password');
    expect(captured).not.toContain('synthetic-token');
  });

  it.each([
    'background:url("https://user:synthetic-password@example.test/a?token=synthetic-token#fragment")',
    'background:u\\72l(https://example.test/a\\3f token=synthetic-token)',
    'background:image-set("https://example.test/a?token=synthetic-token" 1x)',
    'background:URL(data:image/png;base64,synthetic-token)',
  ])('scrubs runtime CSS URLs in snapshots and mutations: %s', (style) => {
    const root = element('view', { style });
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, blockAllMedia: false });
    root.props['style'] = style + ';height:20rpx';
    h.mutate([{ type: 'attributes', target: root, attributeName: 'style' }]);
    const captured = json(controller.getCapture());
    expect(captured).not.toContain('synthetic-password');
    expect(captured).not.toContain('synthetic-token');
    expect(captured).toContain('height:10px');
  });

  it('defaults to private media and display attributes while preserving audited static image opt-in', () => {
    const root = element(
      'view',
      { title: 'private-title', style: 'background:url(https://example.test/photo)' },
      [
        element('image', { src: 'https://example.test/private-photo' }),
        element('image', { src: '/static/logo.png' }),
        element('input', { placeholder: 'private-placeholder', value: 'private-input' }),
      ],
    );
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      staticImageSources: { '/static/logo.png': 'data:image/png;base64,aWNvbg==' },
    });
    const captured = json(controller.getCapture());
    for (const secret of [
      'private-title',
      'private-placeholder',
      'private-input',
      'private-photo',
      'example.test/photo',
    ])
      expect(captured).not.toContain(secret);
    expect(captured).toContain('data:image/png;base64,aWNvbg==');
  });

  it.each([
    'image',
    'img',
    'video',
    'audio',
    'live-player',
    'live-pusher',
    'camera',
    'canvas',
    'web-view',
  ])('withholds %s resource URLs in snapshots and mutations by default', (name) => {
    const root = element(name, {
      src: 'https://example.test/private-media',
      poster: 'https://example.test/private-poster',
    });
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver });
    root.props['src'] = 'https://example.test/private-changed';
    root.props['poster'] = 'https://example.test/private-poster-changed';
    h.mutate([
      { type: 'attributes', target: root, attributeName: 'src' },
      { type: 'attributes', target: root, attributeName: 'poster' },
    ]);
    expect(json(controller.getCapture())).not.toContain('private-');
    controller.stop();
    const allowed = start({ root, MutationObserver: h.MutationObserver, blockAllMedia: false });
    expect(json(allowed.getCapture())).toContain('private-changed');
  });

  it.each([
    'background:url(https://example.test/a?token=synthetic-token',
    'background:url("https://example.test/a?token=synthetic-token)',
    '/*synthetic-token',
  ])('fails closed on incomplete runtime CSS URL syntax: %s', (style) => {
    const root = element('view', { style });
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, blockAllMedia: false });
    expect(json(controller.getCapture())).not.toContain('synthetic-token');
  });

  it('forces explicit text/input masks, blocks subtrees and handles marker changes', () => {
    const input = element('input', { value: 'private-input' });
    const masked = element('view', { 'data-sentry-mask': true, title: 'private-title' }, [
      text('private-text'),
      input,
    ]);
    const blocked = element(
      'view',
      { 'data-sentry-block': true, 'data-visible': 'private-attribute' },
      [text('private-block')],
    );
    const root = element('view', {}, [masked, blocked]);
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
    });
    expect(json(controller.getCapture())).not.toContain('private-');
    blocked.props['data-visible'] = 'private-after';
    h.mutate([{ type: 'attributes', target: blocked, attributeName: 'data-visible' }]);
    expect(json(controller.getCapture())).not.toContain('private-after');
    root.props['data-sentry-block'] = true;
    h.mutate([{ type: 'attributes', target: root, attributeName: 'data-sentry-block' }]);
    expect(json(latestSnapshot(controller.getCapture().events))).not.toContain('"tagName":"input"');
  });

  it('records native input without requiring a DOM mutation, deduplicates controlled echo and survives restart', () => {
    const input = element('textarea', { value: '' });
    const root = element('view', {}, [input]);
    const h = harness(root);
    const options = { root, MutationObserver: h.MutationObserver, maskInputValues: false };
    const controller = start(options);
    h.emit('input', { target: { dataset: { sid: input.sid! } }, detail: { value: 'typed value' } });
    h.emit('input', { target: input, detail: { value: 'typed value' } });
    expect(
      controller.getCapture().events.filter((event) => event.data['source'] === 5),
    ).toHaveLength(1);
    expect(controller.getCapture().events.at(-1)?.data).toMatchObject({
      source: 5,
      text: 'typed value',
      isChecked: false,
    });
    controller.stop();
    const next = start(options);
    expect(json(next.getCapture())).toContain('typed value');
    input.props['value'] = 'programmatic';
    h.mutate([{ type: 'attributes', target: input, attributeName: 'value' }]);
    expect(next.getCapture().events.at(-1)?.data).toMatchObject({
      source: 5,
      text: 'programmatic',
    });
  });

  it('masks native password events and never records interaction text or guessed coordinates', () => {
    const input = element('input', { password: true, value: '' });
    const root = element('view', {}, [input]);
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      maskInputValues: false,
    });
    h.emit('input', { target: input, detail: { value: 'private-password' } });
    h.emit('tap', { target: input });
    h.emit('touchstart', { target: input, touches: [{ clientX: 12, clientY: 34 }] });
    h.emit('focus', { target: input });
    const events = controller.getCapture().events;
    expect(json(events)).not.toContain('private-password');
    expect(
      events.filter((event) => event.data['source'] === 2).map((event) => event.data['type']),
    ).toEqual([7, 5]);
    expect(events.find((event) => event.data['type'] === 7)?.data).toMatchObject({ x: 12, y: 34 });
    controller.stop();
    expect(h.listeners.size).toBe(0);
  });

  it('drains session segments without replacing observers, IDs, listeners or privacy state', () => {
    const input = element('input', { value: '' });
    const root = element('view', {}, [input]);
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      maskInputValues: false,
    });
    const first = controller.takeSegment();
    const count = h.listeners.size;
    expect(first.events.map((event) => event.type)).toEqual([4, 2]);
    h.emit('input', { target: input, detail: { value: 'after segment' } });
    const second = controller.takeSegment();
    expect(second.events.map((event) => event.type)).toEqual([3]);
    expect(second.events[0]?.data).toMatchObject({ source: 5, text: 'after segment' });
    expect(second.replayId).toBe(first.replayId);
    expect(h.listeners.size).toBe(count);
    expect(controller.getCapture().events).toEqual([]);
    expect(controller.getCapture().stopReason).toBeNull();
  });

  it('captures taps as safe breadcrumbs and bounds native touch movement frequency', () => {
    let now = 1000;
    const root = element();
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, now: () => now });
    const event = { target: root, touches: [{ clientX: 10, clientY: 20 }] };
    h.emit('tap', event);
    h.emit('touchmove', event);
    h.emit('touchmove', event);
    now += 50;
    h.emit('touchmove', event);
    const events = controller.getCapture().events;
    expect(events.filter((item) => item.data['source'] === 6)).toHaveLength(2);
    expect(events.find((item) => item.type === 5)?.data).toMatchObject({
      tag: 'breadcrumb',
      payload: { category: 'ui.click', message: 'view' },
    });
  });

  it('stops an oversized mutation batch before serializing it and releases native listeners', () => {
    const root = element();
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, mutationLimit: 1 });
    const previous = controller.getCapture().events;
    h.mutate([
      { type: 'attributes', target: root, attributeName: 'value' },
      { type: 'attributes', target: root, attributeName: 'style' },
    ]);
    expect(controller.getCapture().stopReason).toBe('mutation-limit');
    expect(controller.getCapture().events).toEqual(previous);
    expect(h.listeners.size).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])(
    'keeps duration, event, byte and mutation bounds finite for %s',
    (invalid) => {
      jest.useFakeTimers();
      const root = element();
      const h = harness(root);
      const duration = start({
        root,
        MutationObserver: h.MutationObserver,
        maxDurationMs: invalid,
      });
      jest.advanceTimersByTime(30000);
      expect(duration.getCapture().stopReason).toBe('duration');

      const events = start({ root, MutationObserver: h.MutationObserver, maxEvents: invalid });
      for (let index = 0; index < 500; index++) events.addBreadcrumb({ category: 'test' });
      expect(events.getCapture().stopReason).toBe('limit');
      expect(events.getCapture().events.length).toBeLessThanOrEqual(500);

      const bytes = start({
        root,
        MutationObserver: h.MutationObserver,
        maxBytes: invalid,
        stylesheet: '/*' + 'x'.repeat(524288) + '*/',
      });
      expect(bytes.getCapture().stopReason).toBe('limit');
      expect(bytes.getCapture().stats.approximateBytes).toBeLessThanOrEqual(524288);

      const mutations = start({
        root,
        MutationObserver: h.MutationObserver,
        mutationLimit: invalid,
      });
      h.mutate(
        Array.from({ length: 10001 }, () => ({
          type: 'attributes' as const,
          target: root,
          attributeName: 'style',
        })),
      );
      expect(mutations.getCapture().stopReason).toBe('mutation-limit');
    },
  );

  it('records real page scroll/resize, rebases them after expiry and skips invalid coordinates', () => {
    let now = 1000;
    const root = element();
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      rollingWindowMs: 30000,
      now: () => now,
    });
    expect(controller.recordPageScroll({ scrollTop: -1 })).toBe(false);
    expect(controller.recordViewport({ width: NaN, height: 600 })).toBe(false);
    now = 2000;
    expect(controller.recordPageScroll({ scrollTop: 420, scrollLeft: 12 })).toBe(true);
    now = 3000;
    expect(controller.recordViewport({ width: 800, height: 600 })).toBe(true);
    now = 40000;
    controller.addBreadcrumb({ category: 'test' });
    const capture = controller.takeSegment();
    expect(capture.events[0]?.data).toMatchObject({ width: 800, height: 600 });
    expect(capture.events[1]?.data['initialOffset']).toEqual({ top: 420, left: 12 });
    expect(controller.getCapture().events).toEqual(capture.events);
    controller.stop();
    const restarted = start({ root, MutationObserver: h.MutationObserver });
    expect(restarted.getCapture().events[1]?.data['initialOffset']).toEqual({ top: 420, left: 12 });
  });

  it('preserves action history and adds a regular modal without a redundant checkpoint', () => {
    let now = 1000;
    const root = element();
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      rollingWindowMs: 30000,
      now: () => now,
    });
    now = 5000;
    controller.addBreadcrumb({ category: 'ui.click', message: 'open modal' });
    now = 6000;
    const modal = element();
    modal.parentNode = root;
    root.childNodes!.push(modal);
    h.mutate([{ type: 'childList', target: root, addedNodes: [modal] }]);
    const capture = controller.getCapture();
    expect(json(capture)).toContain('open modal');
    expect(capture.events.filter((event) => event.type === 2)).toHaveLength(1);
    const detached = controller.getCapture();
    detached.events[0]!.data['href'] = 'caller mutation';
    expect(json(controller.getCapture())).not.toContain('caller mutation');
  });

  it('does not repeatedly serialize a large unchanged checkpoint for every scroll event', () => {
    const root = element('scroll-view');
    const h = harness(root);
    const stringify = jest.spyOn(JSON, 'stringify');
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      rollingWindowMs: 30000,
      stylesheet: '/*' + 'x'.repeat(450000) + '*/',
    });
    for (let index = 1; index <= 100; index++) h.emit('scroll', { detail: { scrollTop: index } });
    const fullSerializations = stringify.mock.calls.filter(([value]) => value?.type === 2).length;
    expect(fullSerializations).toBeLessThan(5);
    const capture = controller.getCapture();
    expect(capture.stats.approximateBytes).toBe(
      capture.events.reduce((sum, event) => sum + Buffer.byteLength(json(event)), 0),
    );
    expect(capture.events).toHaveLength(102);
  });
});

describe('bounded session streaming', () => {
  interface PlaybackNode {
    id: number;
    attributes?: Record<string, unknown>;
    childNodes?: PlaybackNode[];
    textContent?: string;
  }
  function playback(controller: ReturnType<typeof startTaroDomReplayPoc>): PlaybackNode[] {
    const events = controller.getCapture().events;
    const state = createCheckpointRebaser(events[1]!);
    events.slice(2).forEach((event) => {
      if (event.type === 3 && event.data['source'] === 0) {
        // rrweb's incremental rebuild uses buildNodeWithSN(skipChild:true), unlike
        // a FullSnapshot. A nested-only addition must not accidentally pass here.
        const adds = event.data['adds'] as Array<{ node: PlaybackNode }>;
        state.apply({
          ...event,
          data: {
            ...event.data,
            adds: adds.map((add) => ({
              ...add,
              node: add.node.childNodes ? { ...add.node, childNodes: [] } : add.node,
            })),
          },
        });
      } else state.apply(event);
    });
    const nodes: PlaybackNode[] = [];
    const visit = (node: PlaybackNode): void => {
      nodes.push(node);
      node.childNodes?.forEach(visit);
    };
    visit(state.getSnapshot().data['node'] as PlaybackNode);
    return nodes;
  }
  function labels(controller: ReturnType<typeof startTaroDomReplayPoc>): string[] {
    return playback(controller)
      .filter((node) => node.textContent && !node.textContent.startsWith('html,body'))
      .map((node) => node.textContent!);
  }

  it('requires flat incremental text descendants for rrweb skipChild playback', () => {
    const root = element();
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const nested = element('view', {}, [
      text('prefix'),
      element('text', {}, [text('visible child')]),
    ]);
    nested.parentNode = root;
    root.childNodes = [nested];
    h.mutate([{ type: 'childList', target: root, addedNodes: [nested] }]);
    const capture = controller.getCapture();
    const adds = capture.events.at(-1)!.data['adds'] as Array<{
      parentId: number;
      nextId: number | null;
      node: PlaybackNode;
    }>;
    expect(adds).toHaveLength(4);
    const available = new Set<number>();
    // The initial parent already exists; every newly introduced parent/next sibling
    // must precede its dependent descendant in this event.
    available.add(adds[0]!.parentId);
    for (const add of adds) {
      expect(available.has(add.parentId)).toBe(true);
      if (add.nextId !== null) expect(available.has(add.nextId)).toBe(true);
      expect(add.node.childNodes ?? []).toEqual([]);
      available.add(add.node.id);
    }
    expect(labels(controller)).toEqual(['prefix', 'visible child']);
    const rootAdd = adds[0]!;
    const legacyNested = {
      ...rootAdd,
      node: {
        ...rootAdd.node,
        childNodes: [{ id: 9999, type: 3, textContent: 'nested-only invisible' }],
      },
    };
    const legacy = {
      ...controller,
      getCapture: () => ({
        ...capture,
        events: [
          ...capture.events.slice(0, 2),
          {
            ...capture.events.at(-1)!,
            data: { ...capture.events.at(-1)!.data, adds: [legacyNested] },
          },
        ],
      }),
    };
    expect(labels(legacy)).toEqual([]);
  });

  it('reports detached byte/count statistics without cloning the event payload', () => {
    const root = element();
    const h = harness(root);
    const reported: Array<{ eventCount: number; approximateBytes: number }> = [];
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      onBufferChange: (stats) => {
        reported.push({ ...stats });
        stats.eventCount = 0;
        stats.approximateBytes = 0;
      },
    });
    const initial = controller.getCapture();
    expect(reported.at(-1)).toEqual({
      eventCount: initial.stats.eventCount,
      approximateBytes: initial.stats.approximateBytes,
    });
    expect(initial.stats.eventCount).toBe(2);
    controller.recordPageScroll({ scrollTop: 123 });
    expect(reported.at(-1)!.eventCount).toBe(3);
    controller.takeSegment();
    expect(reported.at(-1)).toEqual({ eventCount: 0, approximateBytes: 0 });
  });

  it('omits a subtree added and removed before the observer batch finishes', () => {
    const root = element();
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const transient = element('view', {}, [text('TRANSIENT')]);
    transient.parentNode = root;
    h.mutate([
      { type: 'childList', target: root, addedNodes: [transient] },
      { type: 'childList', target: root, removedNodes: [transient] },
    ]);
    expect(labels(controller)).toEqual([]);
    expect(json(controller.getCapture())).not.toContain('TRANSIENT');
    expect(controller.getCapture().events.map((event) => event.type)).toEqual([4, 2]);
  });

  it('uses the surviving next sibling when the original nextSibling was removed in the batch', () => {
    const a = element('view', {}, [text('A')]);
    const b = element('view', {}, [text('B')]);
    const root = element('view', {}, [a, b]);
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const x = element('view', {}, [text('X')]);
    x.parentNode = root;
    root.childNodes = [x, b];
    h.mutate([
      { type: 'childList', target: root, addedNodes: [x], nextSibling: a },
      { type: 'childList', target: root, removedNodes: [a] },
    ]);
    expect(labels(controller)).toEqual(['X', 'B']);
    expect(controller.getCapture().events.map((event) => event.type)).toEqual([4, 2, 3]);
  });

  it('normalizes same-batch moves across parents while preserving IDs and final sibling order', () => {
    const a = element('view', {}, [text('A')]);
    const b = element('view', {}, [text('B')]);
    const c = element('view', {}, [text('C')]);
    const left = element('view', {}, [a]);
    const right = element('view', {}, [b, c]);
    const root = element('view', {}, [left, right]);
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const initialIds = new Map(playback(controller).map((node) => [node.textContent, node.id]));
    left.childNodes = [b];
    b.parentNode = left;
    right.childNodes = [c, a];
    a.parentNode = right;
    h.mutate([
      { type: 'childList', target: left, removedNodes: [a] },
      { type: 'childList', target: right, addedNodes: [a], nextSibling: b },
      { type: 'childList', target: right, removedNodes: [b] },
      { type: 'childList', target: left, addedNodes: [b] },
    ]);
    expect(labels(controller)).toEqual(['B', 'C', 'A']);
    for (const node of playback(controller).filter((node) =>
      ['A', 'B', 'C'].includes(node.textContent!),
    ))
      expect(node.id).toBe(initialIds.get(node.textContent));
    expect(controller.getCapture().events.map((event) => event.type)).toEqual([4, 2, 3]);
  });

  it('orders adjacent additions from separate records and includes a nested addition only once', () => {
    const d = element('view', {}, [text('D')]);
    const root = element('view', {}, [d]);
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const a = element('view', {}, [text('A')]);
    const b = element('view', {}, [text('B')]);
    const c = element('view', {}, [text('C')]);
    root.childNodes = [a, b, c, d];
    for (const node of [a, b, c]) node.parentNode = root;
    h.mutate([
      { type: 'childList', target: root, addedNodes: [a, b], nextSibling: d },
      { type: 'childList', target: root, addedNodes: [c], nextSibling: d },
      { type: 'childList', target: b, addedNodes: b.childNodes! },
    ]);
    expect(labels(controller)).toEqual(['A', 'B', 'C', 'D']);
    const recordedNodes = playback(controller);
    expect(new Set(recordedNodes.map((node) => node.id)).size).toBe(recordedNodes.length);
    expect(controller.getCapture().events.at(-1)!.data['adds']).toHaveLength(6);
    expect(controller.getCapture().events.map((event) => event.type)).toEqual([4, 2, 3]);
  });

  it('keeps sibling order and masks added inputs without a repairing full snapshot', () => {
    const previous = element('view', {}, [text('previous')]);
    const next = element('view', {}, [text('next')]);
    const root = element('view', {}, [previous, next]);
    const h = harness(root);
    const controller = start({ root, MutationObserver: h.MutationObserver, maskAllText: false });
    const inserted = element('view', {}, [
      text('inserted'),
      element('input', { type: 'password', value: 'added-secret' }),
    ]);
    inserted.parentNode = root;
    root.childNodes = [previous, inserted, next];
    h.mutate([{ type: 'childList', target: root, addedNodes: [inserted], nextSibling: next }]);
    root.childNodes = [inserted, next];
    h.mutate([{ type: 'childList', target: root, removedNodes: [previous] }]);
    const events = controller.getCapture().events;
    expect(events.map((event) => event.type)).toEqual([4, 2, 3, 3]);
    expect(json(events)).not.toContain('added-secret');
    const finalState = createCheckpointRebaser(events[1]!);
    events.slice(2).forEach((event) => finalState.apply(event));
    const playback = json(finalState.getSnapshot());
    expect(playback).not.toContain('previous');
    expect(playback.indexOf('inserted')).toBeLessThan(playback.indexOf('"next"'));
    expect(playback).toContain('************');
  });

  it('keeps a CSS-heavy checkpoint once while additions stream across bounded segments', () => {
    const root = element();
    const h = harness(root);
    const segments: TaroReplayPocCapture[] = [];
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      maskAllText: false,
      stylesheet: '/*' + 'x'.repeat(480000) + '*/',
      onBufferFull: () => segments.push(controller.takeSegment()),
    });
    for (let index = 0; index < 40; index++) {
      const row = element('view', {}, [text(`row-${index}:` + 'x'.repeat(1800))]);
      row.parentNode = root;
      root.childNodes!.push(row);
      h.mutate([{ type: 'childList', target: root, addedNodes: [row] }]);
    }
    expect(controller.getCapture().stopReason).toBeNull();
    segments.push(controller.takeSegment());
    expect(segments).toHaveLength(2);
    const events = segments.flatMap((segment) => segment.events);
    expect(events.filter((event) => event.type === 2)).toHaveLength(1);
    expect(events.filter((event) => event.type === 3)).toHaveLength(40);
    expect(segments.reduce((total, segment) => total + segment.stats.mutationCount, 0)).toBe(40);
    for (const segment of segments) {
      expect(segment.stats.approximateBytes).toBeLessThanOrEqual(512 * 1024);
      expect(segment.stats.approximateBytes).toBe(
        segment.events.reduce((sum, event) => sum + Buffer.byteLength(json(event)), 0),
      );
    }
    const reconstructed = createCheckpointRebaser(events[1]!);
    events.slice(2).forEach((event) => reconstructed.apply(event));
    const finalState = json(reconstructed.getSnapshot());
    for (let index = 0; index < 40; index++) expect(finalState).toContain(`row-${index}:`);
    expect(events.slice(2).every((event) => Buffer.byteLength(json(event)) < 3000)).toBe(true);
  });

  it('promotes the error buffer without rebuilding IDs, privacy state or the observer', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1000);
    const input = element('input', { value: 'private-value', type: 'password' });
    const root = element('view', {}, [input]);
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      rollingWindowMs: 30000,
      maxDurationMs: 100,
      maskInputValues: false,
    });
    h.emit('input', { target: input, detail: { value: 'before-promotion' } });
    const prepared = controller.getCapture();
    const inputId = prepared.events.at(-1)!.data['id'];
    jest.advanceTimersByTime(50);
    expect(controller.promoteToSession(200)).toBe(true);
    expect(controller.getCapture().events).toEqual([]);
    expect(controller.getCapture().replayId).toBe(prepared.replayId);
    input.props['type'] = 'text';
    h.mutate([{ type: 'attributes', target: input, attributeName: 'type' }]);
    h.emit('input', { target: input, detail: { value: 'after-promotion' } });
    controller.recordPageScroll({ scrollTop: 123 });
    const after = controller.takeSegment();
    expect(after.events.some((event) => event.type === 2 || event.type === 4)).toBe(false);
    expect(after.events.find((event) => event.data['source'] === 5)?.data['id']).toBe(inputId);
    expect(json(after)).not.toContain('after-promotion');
    expect(after.events.at(-1)!.data).toMatchObject({ source: 3, id: 1, y: 123 });
    expect(controller.getCapture().events).toEqual([]);
    jest.advanceTimersByTime(60);
    expect(controller.getCapture().stopReason).toBeNull();
    jest.advanceTimersByTime(140);
    expect(controller.getCapture().stopReason).toBe('duration');
    expect(controller.promoteToSession(100)).toBe(false);
    expect(json(prepared)).not.toContain('before-promotion');
  });

  it('never drains an incomplete initial checkpoint, rolling buffer, or oversized event', () => {
    const drain = jest.fn();
    const root = element('view', {}, [text('small')]);
    const h = harness(root);
    const initial = start({
      root,
      MutationObserver: h.MutationObserver,
      maxEvents: 1,
      onBufferFull: drain,
    });
    expect(initial.getCapture().stopReason).toBe('limit');
    const rolling = start({
      root,
      MutationObserver: h.MutationObserver,
      maxEvents: 2,
      rollingWindowMs: 30000,
      onBufferFull: drain,
    });
    rolling.addBreadcrumb({ category: 'ui.click' });
    expect(rolling.getCapture().stopReason).toBeNull();
    rolling.stop();
    const oversized = start({
      root,
      MutationObserver: h.MutationObserver,
      maxBytes: 8192,
      maskAllText: false,
      onBufferFull: drain,
    });
    const child = root.childNodes![0]!;
    child.textContent = 'x'.repeat(10000);
    h.mutate([{ type: 'characterData', target: child }]);
    expect(oversized.getCapture().stopReason).toBe('limit');
    expect(drain).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops when the scheduler throws after draining: %s', (afterDrain) => {
    const root = element();
    const h = harness(root);
    const controller = start({
      root,
      MutationObserver: h.MutationObserver,
      maxEvents: 2,
      onBufferFull: () => {
        if (afterDrain) controller.takeSegment();
        throw new Error('scheduler failed');
      },
    });
    expect(() => controller.addBreadcrumb({ category: 'ui.click' })).not.toThrow();
    expect(controller.getCapture().stopReason).toBe('buffer-drain');
    expect(controller.getCapture().events.map((event) => event.type)).toEqual(
      afterDrain ? [] : [4, 2],
    );
  });
});

describe('rolling checkpoint transitions', () => {
  it('rebases a serialized root element scroll into element attributes', () => {
    const events: TaroReplayPocEvent[] = [
      { type: 4, timestamp: 0, data: {} },
      { type: 2, timestamp: 1, data: { node: { id: 1, type: 2, tagName: 'div' } } },
      { type: 3, timestamp: 2, data: { source: 3, id: 1, x: 12, y: 120 } },
    ];
    const bounded = boundReplayEvents(events, {
      now: 40000,
      windowMs: 30000,
      maxEvents: 500,
      maxBytes: 524288,
    });
    expect(bounded[1]!.data['node']).toMatchObject({
      attributes: { rr_scrollLeft: 12, rr_scrollTop: 120 },
    });
    expect(bounded[1]!.data['initialOffset']).toBeUndefined();
  });

  it('retains multiple pages in-window and advances Meta and DOM together on count eviction', () => {
    const meta = (timestamp: number, href: string): TaroReplayPocEvent => ({
      type: 4,
      timestamp,
      data: { href },
    });
    const full = (timestamp: number, value: string): TaroReplayPocEvent => ({
      type: 2,
      timestamp,
      data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 3, textContent: value }] } },
    });
    const events = [
      meta(0, '/one'),
      full(1, 'one'),
      { type: 5 as TaroReplayPocEvent['type'], timestamp: 2, data: { action: true } },
      meta(3, '/two'),
      full(4, 'two'),
    ];
    const bounds = { now: 4, windowMs: 30000, maxEvents: 50, maxBytes: 524288 };
    expect(boundReplayEvents(events, bounds)).toEqual(events);
    const limited = boundReplayEvents(events, { ...bounds, maxEvents: 2 });
    expect(limited).toEqual(events.slice(3));
    expect(events).toHaveLength(5);
  });
});
