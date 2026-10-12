import { describe, expect, it, jest } from '@jest/globals';
import {
  startTaroDomReplayPoc,
  type TaroReplayMutationObserverLike,
  type TaroReplayMutationRecordLike,
  type TaroReplayNodeLike,
  type TaroReplayPocEvent,
  type TaroReplayScrollEventLike,
} from '../src/replay-poc';

interface TestElement extends TaroReplayNodeLike {
  props: Record<string, unknown>;
  styleText: string;
}

interface SerializedTestNode {
  id: number;
  type: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedTestNode[];
}

function textNode(value: string, sid: string): TaroReplayNodeLike {
  return { nodeType: 3, nodeName: '#text', sid, textContent: value, childNodes: [] };
}

function element(
  nodeName: string,
  sid: string,
  props: Record<string, unknown> = {},
  children: TaroReplayNodeLike[] = [],
  styleText = '',
): TestElement {
  const node: TestElement = {
    nodeType: 1,
    nodeName,
    sid,
    props,
    styleText,
    childNodes: children,
    get attributes() {
      const attributes = Object.entries(this.props).map(([name, value]) => ({ name, value }));
      return this.styleText
        ? [...attributes, { name: 'style', value: this.styleText }]
        : attributes;
    },
    getAttribute(name: string) {
      if (name === 'style') return this.styleText;
      return this.props[name] ?? '';
    },
    hasAttribute(name: string) {
      // Mirrors Taro 4: style is not stored in Element.props.
      return name !== 'style' && Object.prototype.hasOwnProperty.call(this.props, name);
    },
  };
  for (const child of children) child.parentNode = node;
  return node;
}

function scrollHarness() {
  const listeners = new Set<(event: TaroReplayScrollEventLike) => void>();
  const node = Object.assign(element('scroll-view', 'scroll', { scrollY: true }), {
    addEventListener: jest.fn(
      (name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
        if (name === 'scroll') listeners.add(listener);
      },
    ),
    removeEventListener: jest.fn(
      (name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
        if (name === 'scroll') listeners.delete(listener);
      },
    ),
  });
  return {
    node,
    listeners,
    emit: (event: TaroReplayScrollEventLike) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function findNode(
  root: SerializedTestNode,
  predicate: (node: SerializedTestNode) => boolean,
): SerializedTestNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.childNodes || []) {
    const found: SerializedTestNode | undefined = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function fullSnapshotNode(events: TaroReplayPocEvent[]): SerializedTestNode {
  return events[1]?.data['node'] as SerializedTestNode;
}

function mutationData(event: TaroReplayPocEvent) {
  return event.data as {
    texts: Array<{ id: number; value: string }>;
    attributes: Array<{ id: number; attributes: Record<string, unknown> }>;
    removes: Array<{ parentId: number; id: number }>;
    adds: Array<{ parentId: number; nextId: number | null; node: SerializedTestNode }>;
  };
}

function observerHarness() {
  class HarnessObserver implements TaroReplayMutationObserverLike {
    static current: HarnessObserver | undefined;
    readonly observe = jest.fn();
    readonly disconnect = jest.fn();

    constructor(private readonly callback: (records: TaroReplayMutationRecordLike[]) => void) {
      HarnessObserver.current = this;
    }

    emit(records: TaroReplayMutationRecordLike[]) {
      this.callback(records);
    }
  }

  return {
    MutationObserver: HarnessObserver,
    current: () => HarnessObserver.current,
  };
}

describe('Taro DOM Replay POC', () => {
  it('retains observed native scroll offsets across recorder restart on the same mounted root', () => {
    const observer = observerHarness();
    const scroll = scrollHarness();
    const options = { root: scroll.node, MutationObserver: observer.MutationObserver };
    const first = startTaroDomReplayPoc(options);
    scroll.emit({ detail: { scrollTop: 420, scrollLeft: 12 } });
    first.stop('error');
    expect(scroll.listeners.size).toBe(0);
    const second = startTaroDomReplayPoc(options);
    const snapshot = fullSnapshotNode(second.getCapture().events);
    second.stop();
    const replayScroll = findNode(
      snapshot,
      (node) => node.attributes?.['data-taro-node'] === 'scroll-view',
    );
    expect(replayScroll?.attributes).toMatchObject({ rr_scrollTop: 420, rr_scrollLeft: 12 });
    expect(scroll.listeners.size).toBe(0);
  });

  it('attaches inserted scroll views and cleans up listeners when their subtree is removed', () => {
    const observer = observerHarness();
    const root = element('view', 'root');
    const scroll = scrollHarness();
    const applicationListener = jest.fn();
    scroll.listeners.add(applicationListener);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    const wrapper = element('view', 'wrapper', {}, [scroll.node]);
    root.childNodes?.push(wrapper);
    wrapper.parentNode = root;
    observer.current()?.emit([{ type: 'childList', target: root, addedNodes: [wrapper] }]);
    expect(scroll.listeners.size).toBe(2);
    scroll.emit({ detail: { scrollTop: 100, scrollLeft: 0 } });
    const beforeRemoval = controller
      .getCapture()
      .events.filter((event) => event.data['source'] === 3);
    expect(beforeRemoval).toHaveLength(1);
    root.childNodes?.pop();
    observer.current()?.emit([{ type: 'childList', target: root, removedNodes: [wrapper] }]);
    expect(scroll.listeners.size).toBe(1);
    scroll.emit({ detail: { scrollTop: 200, scrollLeft: 0 } });
    const capture = controller.stop();
    expect(capture.events.filter((event) => event.data['source'] === 3)).toEqual(beforeRemoval);
    expect(applicationListener).toHaveBeenCalledTimes(2);
  });

  it('deduplicates scroll offsets, rejects invalid coordinates and observes the existing event cap', () => {
    const observer = observerHarness();
    const scroll = scrollHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: scroll.node,
      MutationObserver: observer.MutationObserver,
      maxEvents: 3,
    });
    scroll.emit({ detail: { scrollTop: 100, scrollLeft: 0 } });
    scroll.emit({ detail: { scrollTop: 100, scrollLeft: 0 } });
    scroll.emit({ detail: { scrollTop: -1, scrollLeft: Number.NaN } });
    scroll.emit({ detail: { scrollTop: Number.POSITIVE_INFINITY, scrollLeft: -1 } });
    expect(controller.getCapture().events).toHaveLength(3);
    scroll.emit({ detail: { scrollTop: 200, scrollLeft: 0 } });
    expect(controller.getCapture().stopReason).toBe('limit');
    expect(scroll.listeners.size).toBe(0);
  });

  it('skips unsupported or throwing native scroll listener APIs without changing recorder lifecycle', () => {
    const observer = observerHarness();
    const root = element('view', 'root', {}, [
      element('scroll-view', 'no-event-api', { scrollY: true }),
      Object.assign(element('scroll-view', 'throws', { scrollY: true }), {
        addEventListener: () => {
          throw new Error('Unsupported');
        },
        removeEventListener: jest.fn(),
      }),
    ]);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    expect(controller.getCapture().stopReason).toBeNull();
    expect(controller.stop().stopReason).toBe('manual');
    expect(observer.current()?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('records native scroll-view offsets without replacing the application listener', () => {
    const observer = observerHarness();
    const listeners = new Set<
      (event: { detail: { scrollTop: number; scrollLeft: number } }) => void
    >();
    const applicationListener = jest.fn();
    listeners.add(applicationListener);
    const scroll = Object.assign(element('scroll-view', 'scroll', { scrollY: true }), {
      addEventListener: jest.fn(
        (
          name: string,
          callback: (event: { detail: { scrollTop: number; scrollLeft: number } }) => void,
        ) => {
          if (name === 'scroll') listeners.add(callback);
        },
      ),
      removeEventListener: jest.fn(
        (
          name: string,
          callback: (event: { detail: { scrollTop: number; scrollLeft: number } }) => void,
        ) => {
          if (name === 'scroll') listeners.delete(callback);
        },
      ),
    });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root', {}, [scroll]),
      MutationObserver: observer.MutationObserver,
    });
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    const scrollNode = findNode(
      snapshot,
      (node) => node.attributes?.['data-taro-node'] === 'scroll-view',
    );
    const event = { detail: { scrollTop: 350, scrollLeft: 12 } };
    for (const listener of listeners) listener(event);
    const capture = controller.stop();
    expect(applicationListener).toHaveBeenCalledWith(event);
    expect(capture.events.filter((item) => item.type === 3 && item.data['source'] === 3)).toEqual([
      expect.objectContaining({
        data: { source: 3, id: scrollNode?.id, x: 12, y: 350 },
      }),
    ]);
    expect(listeners.size).toBe(1);
    expect(listeners.has(applicationListener)).toBe(true);
  });

  it('stores controlled scroll offsets in the FullSnapshot for playback restoration', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('scroll-view', 'scroll', { scrollY: true, scrollTop: 350, scrollLeft: 12 }),
      MutationObserver: observer.MutationObserver,
    });
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    controller.stop();
    const scrollNode = findNode(
      snapshot,
      (node) => node.attributes?.['data-taro-node'] === 'scroll-view',
    );
    expect(scrollNode?.attributes).toMatchObject({ rr_scrollTop: 350, rr_scrollLeft: 12 });
  });

  it('replaces an old rolling checkpoint when compiled CSS makes two snapshots exceed the byte cap', () => {
    const observer = observerHarness();
    const text = textNode('before', 'text');
    const root = element('view', 'root', {}, [text], 'color:red');
    const options = {
      root,
      MutationObserver: observer.MutationObserver,
      stylesheet: `/*${'x'.repeat(300 * 1_024)}*/`,
      maskAllText: false,
      rollingWindowMs: 30_000,
      maxBytes: 512 * 1_024,
      now: () => 1_000,
    };
    const controller = startTaroDomReplayPoc(options);
    const replayId = controller.getCapture().replayId;
    text.textContent = 'current';
    root.styleText = 'color:blue';
    const child = element('root-portal', 'added', {}, [textNode('added child', 'added-text')]);
    root.childNodes?.push(child);
    child.parentNode = root;
    observer.current()?.emit([
      { type: 'characterData', target: text },
      { type: 'attributes', target: root, attributeName: 'style' },
      { type: 'childList', target: root, addedNodes: [child] },
    ]);
    const checkpointCapture = controller.getCapture();
    const checkpoint = fullSnapshotNode(checkpointCapture.events);
    expect(findNode(checkpoint, (node) => node.textContent === 'current')).toBeDefined();
    expect(findNode(checkpoint, (node) => node.textContent === 'added child')).toBeDefined();
    expect(
      findNode(checkpoint, (node) => node.attributes?.['data-taro-node'] === 'view')?.attributes?.[
        'style'
      ],
    ).toBe('color:blue');
    expect(checkpointCapture.events.map((event) => event.type)).toEqual([4, 2]);
    expect(checkpointCapture.events[0]?.timestamp).toBe(
      (checkpointCapture.events[1]?.timestamp || 0) - 1,
    );
    text.textContent = 'after checkpoint';
    observer.current()?.emit([{ type: 'characterData', target: text }]);
    const capture = controller.stop();
    expect(capture.replayId).toBe(replayId);
    const recordedText = findNode(checkpoint, (node) => node.textContent === 'current');
    expect(mutationData(capture.events[2] as TaroReplayPocEvent).texts).toEqual([
      { id: recordedText?.id, value: 'after checkpoint' },
    ]);
    expect(capture.stats.approximateBytes).toBeLessThanOrEqual(options.maxBytes);
    expect(capture.stats.approximateBytes).toBe(
      capture.events.reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    );
  });

  it('lets native input padding and borders add to its line-height', () => {
    const observer = observerHarness();
    const input = element('input', 'input', {}, [], 'padding:8px;border:1px solid #ccc');
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: input,
      MutationObserver: observer.MutationObserver,
    });
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    controller.stop();
    const css = findNode(snapshot, (node) => node.tagName === 'style')?.childNodes?.[0]
      ?.textContent;
    expect(css).toMatch(/\[data-taro-node="input"\]\{[^}]*height:auto;min-height:1\.4rem/);
    expect(findNode(snapshot, (node) => node.tagName === 'input')?.attributes?.['style']).toBe(
      'padding:8px;border:1px solid #ccc',
    );
  });

  it.each([undefined, 30_000])(
    'keeps injected stylesheet bytes within the recorder cap in rolling mode %s and skips observation after a limit stop',
    (rollingWindowMs) => {
      const observer = observerHarness();
      const options = {
        root: element('view', 'root'),
        MutationObserver: observer.MutationObserver,
        stylesheet: '.fixture{color:red}'.repeat(1_000),
        maxBytes: 4_096,
        ...(rollingWindowMs === undefined ? {} : { rollingWindowMs }),
      };
      const controller = startTaroDomReplayPoc(options);
      const capture = controller.getCapture();
      expect(capture.stopReason).toBe('limit');
      expect(capture.stats.approximateBytes).toBeLessThanOrEqual(options.maxBytes);
      expect(observer.current()).toBeUndefined();
    },
  );

  it('preserves native content-box views so status-bar padding adds to the navigation height', () => {
    const observer = observerHarness();
    const root = element('view', 'navigation', {}, [], 'height:44px;padding-top:47px');
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    controller.stop();
    const css = findNode(snapshot, (node) => node.tagName === 'style')?.childNodes?.[0]
      ?.textContent;
    expect(css).toMatch(/\[data-taro-node="view"\],\[data-taro-node="root"\]\{display:block\}/);
    expect(
      findNode(snapshot, (node) => node.attributes?.['data-taro-node'] === 'view')?.attributes?.[
        'style'
      ],
    ).toBe('height:44px;padding-top:47px');
  });

  it('keeps compiled page styles and mini-program button layout in the full snapshot', () => {
    const observer = observerHarness();
    const options = {
      root: element('view', 'header', { class: 'compiled-header' }, [
        element('button', 'button', {}, [textNode('Increment', 'button-label')]),
      ]),
      MutationObserver: observer.MutationObserver,
      width: 390,
      stylesheet:
        '.compiled-header{position:fixed;top:20rpx;background:#d20a10}' +
        '.font-literal{font-size:34rpx;width:34rpx;--font-size:34rpx;content:"font-size:34rpx"}' +
        '.font-complex{font-size:calc(34rpx + 1px)}',
    };
    const controller = startTaroDomReplayPoc(options);
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    controller.stop();
    const css = findNode(snapshot, (node) => node.tagName === 'style')?.childNodes?.[0]
      ?.textContent;
    expect(css).toContain('.compiled-header{position:fixed;top:10.4px;background:#d20a10}');
    expect(css).toContain(
      'html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.4}',
    );
    expect(css).toContain(
      '.font-literal{font-size:17px;width:17.68px;--font-size:17.68px;content:"font-size:34rpx"}',
    );
    expect(css).toContain('.font-complex{font-size:calc(17.68px + 1px)}');
    expect(css).toMatch(
      /\[data-taro-node="button"\]\{[^}]*display:block[^}]*width:100%;width:-webkit-fill-available;width:stretch/,
    );
    expect(css).toMatch(/\[data-taro-node="button"\]\[size="mini"\]\{[^}]*width:auto/);
    expect(css).toMatch(
      /\[data-taro-node="button"\]\{[^}]*font-family:serif[^}]*font-size:18px[^}]*line-height:2\.55555556/,
    );
    expect(css).toContain('[data-taro-node="button"]::after');
    expect(css).toContain('[data-taro-node="button"][type="primary"]');
    expect(css).toContain('[data-taro-node="button"][type="warn"]');
    expect(css).toContain('[data-taro-node="button"][type="warn"]{color:#fff;background:#e64340}');
    expect(css).toContain(
      '[data-taro-node="button"][plain][type="warn"]{color:#e64340;border-color:#e64340}',
    );
    expect(css).toContain('[data-taro-node="button"][disabled]');
    expect(css).toMatch(/\[data-taro-node="input"\]\{[^}]*min-height:1\.4rem/);
    expect(css).toMatch(/\[data-taro-node="input"\]\{[^}]*font-size:12px/);
    expect(css).toMatch(/\[data-taro-node="textarea"\]\{[^}]*box-sizing:border-box/);
    expect(css).toContain('[data-taro-node="scroll-view"][scrolly="true"]');
    controller.stop();
  });

  it('converts rpx for inline snapshots, added children and subsequent style mutations', () => {
    const observer = observerHarness();
    const root = element('view', 'root', {}, [], 'padding:20rpx;width:750rpx');
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      width: 390,
    });
    const initial = fullSnapshotNode(controller.getCapture().events);
    expect(
      findNode(initial, (node) => node.attributes?.['data-taro-node'] === 'view')?.attributes?.[
        'style'
      ],
    ).toBe('padding:10.4px;width:390px');
    root.styleText = 'margin-left:-10rpx;padding:.5rpx';
    const child = element('view', 'added', {}, [], 'height:100rpx');
    root.childNodes?.push(child);
    child.parentNode = root;
    observer.current()?.emit([
      { type: 'attributes', target: root, attributeName: 'style' },
      { type: 'childList', target: root, addedNodes: [child] },
    ]);
    const data = mutationData(controller.getCapture().events[2] as TaroReplayPocEvent);
    controller.stop();
    expect(data.attributes).toEqual([
      expect.objectContaining({ attributes: { style: 'margin-left:-5.2px;padding:0.26px' } }),
    ]);
    expect(data.adds[0]?.node.attributes?.['style']).toBe('height:52px');
    controller.stop();
  });

  it('normalizes className snapshots and mutations to the playback class attribute', () => {
    const observer = observerHarness();
    const root = element('view', 'root', { className: 'compiled-header' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    const replayRoot = findNode(
      fullSnapshotNode(controller.getCapture().events),
      (node) => node.attributes?.['data-taro-node'] === 'view',
    );
    expect(replayRoot?.attributes?.['class']).toBe('compiled-header');
    expect(replayRoot?.attributes).not.toHaveProperty('className');
    root.props['className'] = 'compiled-header active';
    observer.current()?.emit([{ type: 'attributes', target: root, attributeName: 'className' }]);
    expect(
      mutationData(controller.getCapture().events[2] as TaroReplayPocEvent).attributes,
    ).toEqual([expect.objectContaining({ attributes: { class: 'compiled-header active' } })]);
    controller.stop();
  });

  it('uses the default viewport for rpx and leaves CSS strings and URLs intact', () => {
    const observer = observerHarness();
    const options = {
      blockAllMedia: false,
      root: element('view', 'root', {}, [], 'padding:20rpx;background:url("/20rpx.png")'),
      MutationObserver: observer.MutationObserver,
      stylesheet:
        '.fixture{padding:20rpx;content:"20rpx";background:url(/20rpx.png)} .quoted{background:url(\'/assets/foo)width=20rpx.png\')}',
    };
    const controller = startTaroDomReplayPoc(options);
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    controller.stop();
    expect(
      findNode(snapshot, (node) => node.tagName === 'style')?.childNodes?.[0]?.textContent,
    ).toContain('.fixture{padding:10px;content:"20rpx";background:url(/20rpx.png)}');
    expect(
      findNode(snapshot, (node) => node.tagName === 'style')?.childNodes?.[0]?.textContent,
    ).toContain(".quoted{background:url('/assets/foo)width=20rpx.png')}");
    expect(
      findNode(snapshot, (node) => node.attributes?.['data-taro-node'] === 'view')?.attributes?.[
        'style'
      ],
    ).toBe('padding:10px;background:url("/20rpx.png")');
    controller.stop();
  });

  it('rejects a missing mounted root', () => {
    const observer = observerHarness();
    expect(() =>
      startTaroDomReplayPoc({
        blockAllMedia: false,
        root: null as unknown as TaroReplayNodeLike,
        MutationObserver: observer.MutationObserver,
      }),
    ).toThrow('A mounted Taro root node is required');
  });

  it('records a masked FullSnapshot and monotonic text mutations, then disconnects', () => {
    const observer = observerHarness();
    const text = textNode('zero', 'text-1');
    const root = element('view', 'root-1', {}, [text]);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      now: () => 1_000,
    });

    const initial = controller.getCapture();
    expect(initial.href).toBe('https://miniapp.local/replay-poc');
    expect(initial.replayId).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect(initial.events.map((event) => event.type)).toEqual([4, 2]);
    expect(initial.events.map((event) => event.timestamp)).toEqual([1_000, 1_001]);
    expect(
      findNode(fullSnapshotNode(initial.events), (node) => node.textContent === '****'),
    ).toBeDefined();
    expect(observer.current()?.observe).toHaveBeenCalledWith(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    text.textContent = 'one';
    observer.current()?.emit([{ type: 'characterData', target: text }]);

    const capture = controller.stop('manual');
    expect(capture.events[2]?.timestamp).toBe(1_002);
    expect(mutationData(capture.events[2] as TaroReplayPocEvent).texts).toEqual([
      expect.objectContaining({ value: '***' }),
    ]);
    expect(capture.stats.mutationCount).toBe(1);
    expect(capture.stopReason).toBe('manual');
    expect(observer.current()?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('records Sentry breadcrumbs and network summaries as Replay custom events', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1'),
      MutationObserver: observer.MutationObserver,
      now: () => 4_000,
    });

    expect(
      controller.addBreadcrumb({
        timestamp: 4,
        category: 'user.interaction',
        message: 'Increment counter',
        data: { action: 'increment', page: 'pages/ReplayPoc/index' },
      }),
    ).toBe(true);
    expect(
      controller.addBreadcrumb({
        timestamp: 4.1,
        category: 'xhr',
        data: {
          url: 'http://127.0.0.1:4318/health',
          method: 'GET',
          status_code: 200,
          duration: 25,
          request_size: 12,
          response_size: 16,
        },
      }),
    ).toBe(true);

    const capture = controller.getCapture();
    expect(capture.events[2]).toEqual(
      expect.objectContaining({
        type: 5,
        data: {
          tag: 'breadcrumb',
          payload: expect.objectContaining({
            category: 'user.interaction',
            message: 'Increment counter',
          }),
        },
      }),
    );
    expect(capture.events[3]).toEqual(
      expect.objectContaining({
        type: 5,
        data: {
          tag: 'performanceSpan',
          payload: expect.objectContaining({
            op: 'resource.xhr',
            description: 'http://127.0.0.1:4318/health',
            data: expect.objectContaining({ method: 'GET', statusCode: 200 }),
          }),
        },
      }),
    );
    expect(capture.stats.breadcrumbCount).toBe(1);
    expect(capture.stats.networkCount).toBe(1);

    controller.stop();
    expect(controller.addBreadcrumb({ category: 'user.interaction' })).toBe(false);
  });

  it('keeps a recent network summary when identical input mutations exceed the event limit', () => {
    const observer = observerHarness();
    const input = element('input', 'input-1', { value: '123' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1', {}, [input]),
      MutationObserver: observer.MutationObserver,
      now: () => 4_000,
      rollingWindowMs: 30_000,
      maxEvents: 500,
    });

    controller.addBreadcrumb({
      timestamp: 4.1,
      category: 'xhr',
      data: {
        url: 'http://api.example.test/upgrade/service_status.json',
        method: 'GET',
        status_code: 200,
        duration: 101,
      },
    });
    for (let index = 0; index < 500; index++) {
      observer.current()?.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);
    }

    const capture = controller.getCapture();
    controller.stop();
    expect(
      capture.events.some((event) => event.type === 5 && event.data['tag'] === 'performanceSpan'),
    ).toBe(true);
    expect(capture.events).toHaveLength(3);
    expect(capture.stats.networkCount).toBe(1);
  });

  it('includes caller-provided Sentry metadata in the capture', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1'),
      MutationObserver: observer.MutationObserver,
      metadata: {
        environment: 'develop',
        release: 'host-app-test',
        sdk: { name: 'sentry.javascript.miniapp', version: '1.13.1' },
        user: { id: 'replay-poc-user' },
        tags: { framework: 'taro', 'miniapp.platform': 'wechat' },
        contexts: { miniapp: { route: 'pages/ReplayPoc/index' } },
      },
      now: () => 5_000,
    });

    expect(controller.getCapture().metadata).toEqual({
      environment: 'develop',
      release: 'host-app-test',
      sdk: { name: 'sentry.javascript.miniapp', version: '1.13.1' },
      user: { id: 'replay-poc-user' },
      tags: { framework: 'taro', 'miniapp.platform': 'wechat' },
      contexts: { miniapp: { route: 'pages/ReplayPoc/index' } },
    });
    controller.stop();
  });

  it('records style and child mutations while masking initial and changed input values', () => {
    const observer = observerHarness();
    const input = element('input', 'input-1', { value: 'secret' });
    const root = element('view', 'root-1', {}, [input], 'color:red');
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      now: () => 2_000,
    });

    const initialInput = findNode(
      fullSnapshotNode(controller.getCapture().events),
      (node) => node.tagName === 'input',
    );
    expect(initialInput?.attributes?.['value']).toBe('******');

    root.styleText = 'color:blue';
    input.props['value'] = 'changed';
    const added = textNode('new child', 'text-new');
    added.parentNode = root;
    root.childNodes?.push(added);
    observer.current()?.emit([
      { type: 'attributes', target: root, attributeName: 'style' },
      { type: 'attributes', target: input, attributeName: 'value' },
      { type: 'childList', target: root, addedNodes: [added], removedNodes: [] },
    ]);

    const data = mutationData(controller.getCapture().events[2] as TaroReplayPocEvent);
    expect(data.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { style: 'color:blue' } }),
        expect.objectContaining({ attributes: { value: '*******' } }),
      ]),
    );
    expect(data.adds[0]?.node.textContent).toBe('*** *****');
    controller.stop();
  });

  it.each([
    { password: true },
    { password: 'true' },
    { type: 'password' },
    { type: 'PASSWORD' },
    { 'data-sentry-mask': true, password: false },
    { 'data-sentry-mask': 'true' },
    { 'data-sentry-mask': '' },
  ])('always masks password/marked input snapshots and mutations: %j', (props) => {
    const observer = observerHarness();
    const input = element('input', 'password-input', { ...props, value: 'test-secret' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: input,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
      now: () => 2_025,
    });
    expect(
      findNode(fullSnapshotNode(controller.getCapture().events), (node) => node.tagName === 'input')
        ?.attributes?.['value'],
    ).toBe('***********');

    input.props['value'] = 'new-secret';
    observer.current()?.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);
    expect(
      mutationData(controller.getCapture().events[2] as TaroReplayPocEvent).attributes,
    ).toEqual([expect.objectContaining({ attributes: { value: '**********' } })]);
    expect(JSON.stringify(controller.getCapture().events)).not.toContain('test-secret');
    expect(JSON.stringify(controller.getCapture().events)).not.toContain('new-secret');
    controller.stop();
  });

  it('keeps ordinary text and input values visible when global masking is disabled', () => {
    const observer = observerHarness();
    const text = textNode('visible label', 'visible-text');
    const input = element('input', 'visible-input', {
      value: 'visible input',
      password: false,
      type: 'text',
      'data-sentry-mask': false,
    });
    const root = element('view', 'visible-root', {}, [text, input]);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
      now: () => 2_050,
    });
    const initial = fullSnapshotNode(controller.getCapture().events);
    expect(findNode(initial, (node) => node.type === 3 && node.id >= 10)?.textContent).toBe(
      'visible label',
    );
    expect(findNode(initial, (node) => node.tagName === 'input')?.attributes?.['value']).toBe(
      'visible input',
    );
    text.textContent = 'changed label';
    input.props['value'] = 'changed input';
    observer.current()?.emit([
      { type: 'characterData', target: text },
      { type: 'attributes', target: input, attributeName: 'value' },
    ]);
    const mutation = mutationData(controller.getCapture().events[2] as TaroReplayPocEvent);
    expect(mutation.texts).toEqual([expect.objectContaining({ value: 'changed label' })]);
    expect(mutation.attributes).toEqual([
      expect.objectContaining({ attributes: { value: 'changed input' } }),
    ]);
    controller.stop();
  });

  it.each([
    { name: 'password', enabled: true, revealed: false },
    { name: 'type', enabled: 'password', revealed: 'text' },
    { name: 'data-sentry-mask', enabled: true, revealed: false },
  ])('updates existing values and keeps revealed password fields masked: $name', (attribute) => {
    const observer = observerHarness();
    const input = element('input', 'toggle-input', {
      value: 'public',
      [attribute.name]: attribute.revealed,
    });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: input,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
      now: () => 2_075,
    });
    input.props[attribute.name] = attribute.enabled;
    observer
      .current()
      ?.emit([{ type: 'attributes', target: input, attributeName: attribute.name }]);
    expect(
      mutationData(controller.getCapture().events[2] as TaroReplayPocEvent).attributes,
    ).toEqual([
      expect.objectContaining({ attributes: expect.objectContaining({ value: '******' }) }),
    ]);

    input.props[attribute.name] = attribute.revealed;
    input.props['value'] = 'hidden-secret';
    observer.current()?.emit([
      { type: 'attributes', target: input, attributeName: attribute.name },
      { type: 'attributes', target: input, attributeName: 'value' },
    ]);
    const changed = mutationData(
      controller
        .getCapture()
        .events.filter((event) => event.data['source'] === 0)
        .at(-1) as TaroReplayPocEvent,
    );
    expect(changed.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ value: '*************' }),
        }),
      ]),
    );
    expect(JSON.stringify(controller.getCapture().events)).not.toContain('hidden-secret');
    controller.stop();
  });

  it('records a newly inserted subtree once as an incremental mutation', () => {
    const observer = observerHarness();
    const root = element('view', 'root-1');
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      now: () => 2_100,
    });
    const added = element('view', 'child-1', {}, [textNode('new child', 'text-new')]);
    added.parentNode = root;
    root.childNodes?.push(added);

    observer
      .current()
      ?.emit([{ type: 'childList', target: root, addedNodes: [added], removedNodes: [] }]);

    const events = controller.getCapture().events;
    expect(mutationData(events[2] as TaroReplayPocEvent).adds).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([4, 2, 3]);
    expect(JSON.stringify(events[2])).toContain('new child');
    controller.stop();
  });

  it('allows privacy-safe text opt-out and strips URL secrets from captures', () => {
    const observer = observerHarness();
    const image = element('image', 'image-1', {
      src: 'https://user:password@example.com/avatar.png?token=secret#profile',
      'data-access-token': 'private-token',
    });
    const root = element('view', 'root-1', {}, [textNode('public text', 'text-1'), image]);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      href: 'https://miniapp.local/pages/home?openid=secret#state',
      maskAllText: false,
      now: () => 2_250,
    });

    controller.addBreadcrumb({
      category: 'fetch',
      data: { url: 'https://api.example.com/users?access_token=secret#result' },
    });

    const capture = controller.getCapture();
    const snapshot = fullSnapshotNode(capture.events);
    expect(capture.href).toBe('https://miniapp.local/pages/home');
    expect(findNode(snapshot, (node) => node.textContent === 'public text')).toBeDefined();
    expect(findNode(snapshot, (node) => node.tagName === 'img')?.attributes?.['src']).toBe(
      'https://[filtered]:[filtered]@example.com/avatar.png',
    );
    expect(
      findNode(snapshot, (node) => node.tagName === 'img')?.attributes?.['data-access-token'],
    ).toBe('[Filtered]');
    expect(capture.events[2]?.data).toEqual({
      tag: 'performanceSpan',
      payload: expect.objectContaining({ description: 'https://api.example.com/users' }),
    });
    controller.stop();
  });

  it('accounts for replay event limits in UTF-8 bytes', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1', {}, [textNode('你好🚀', 'text-1')]),
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      now: () => 2_400,
    });

    const capture = controller.getCapture();
    const actualBytes = capture.events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      0,
    );
    expect(capture.stats.approximateBytes).toBe(actualBytes);
    controller.stop();
  });

  it('removes data URL payloads and counts two-byte UTF-8 characters', () => {
    const observer = observerHarness();
    const imageWithMime = element('image', 'image-mime', {
      src: 'data:image/png;base64,private',
    });
    const imageWithoutMime = element('image', 'image-default', { src: 'data:,private' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1', {}, [
        textNode('é', 'text-1'),
        imageWithMime,
        imageWithoutMime,
      ]),
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      now: () => 2_450,
    });

    const capture = controller.getCapture();
    const snapshot = fullSnapshotNode(capture.events);
    expect(
      findNode(snapshot, (node) => node.attributes?.['src'] === 'data:image/png'),
    ).toBeDefined();
    expect(
      findNode(snapshot, (node) => node.attributes?.['src'] === 'data:text/plain'),
    ).toBeDefined();
    expect(capture.stats.approximateBytes).toBe(
      capture.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    );
    controller.stop();
  });

  it('serializes primitive attributes and missing Taro node fields conservatively', () => {
    const observer = observerHarness();
    const unknownNode: TaroReplayNodeLike = {
      nodeType: 1,
      sid: 'unknown-1',
    };
    const commentNode: TaroReplayNodeLike = {
      nodeType: 8,
      nodeName: 'comment',
      sid: 'comment-1',
      textContent: null,
    };
    const tagOnlyNode: TaroReplayNodeLike = {
      nodeType: 1,
      tagName: 'button',
      sid: 'button-1',
      attributes: [
        null,
        { name: '', value: 'ignored' },
        { name: 'onTap', value: 'ignored' },
        { name: 'enabled', value: true },
        { name: 'count', value: 2 },
        { name: 'nullable', value: null },
        { name: 'missing', value: undefined },
        { name: 'disabled', value: false },
        { name: 'href', value: null },
      ] as unknown as NonNullable<TaroReplayNodeLike['attributes']>,
      childNodes: [unknownNode, commentNode],
    };
    const input = element('input', 'input-1', { value: null });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1', {}, [tagOnlyNode, input]),
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      metadata: { environment: 'test' },
      now: () => 2_475,
    });

    const capture = controller.getCapture();
    const snapshot = fullSnapshotNode(capture.events);
    const button = findNode(snapshot, (node) => node.tagName === 'button');
    expect(button?.attributes).toEqual(
      expect.objectContaining({
        enabled: true,
        count: 2,
        nullable: null,
        missing: null,
        disabled: null,
        href: null,
      }),
    );
    expect(button?.attributes).not.toHaveProperty('onTap');
    expect(
      findNode(snapshot, (node) => node.attributes?.['data-taro-unsupported'] === 'unknown'),
    ).toBeDefined();
    expect(findNode(snapshot, (node) => node.type === 5)?.textContent).toBe('');
    expect(findNode(snapshot, (node) => node.tagName === 'input')?.attributes?.['value']).toBe('');
    expect(capture.metadata).toEqual({ environment: 'test' });
    controller.stop();

    const unmaskedInputController = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('input', 'input-unmasked', { value: 'public' }),
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
      now: () => 2_476,
    });
    expect(
      findNode(
        fullSnapshotNode(unmaskedInputController.getCapture().events),
        (node) => node.tagName === 'input',
      )?.attributes?.['value'],
    ).toBe('public');
    unmaskedInputController.stop();
  });

  it('stops when a breadcrumb would exceed the event limit', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1'),
      MutationObserver: observer.MutationObserver,
      maxEvents: 3,
      now: () => 7_000,
    });

    expect(
      controller.addBreadcrumb({
        category: 'navigation',
        timestamp: 10_000_000_001,
      }),
    ).toBe(true);
    expect(controller.getCapture().events[2]?.timestamp).toBe(10_000_000_001);
    expect(controller.addBreadcrumb({ category: 'navigation' })).toBe(false);
    expect(controller.getCapture()).toEqual(
      expect.objectContaining({
        stopReason: 'limit',
        stats: expect.objectContaining({ breadcrumbCount: 1 }),
      }),
    );
    expect(observer.current()?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rolls a bounded error buffer while preserving the playable checkpoint', () => {
    const observer = observerHarness();
    let now = 1_000;
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1'),
      MutationObserver: observer.MutationObserver,
      maxEvents: 4,
      rollingWindowMs: 30,
      now: () => now,
    });

    for (let index = 0; index < 5; index++) {
      now += 10;
      expect(controller.addBreadcrumb({ category: 'ui', message: String(index) })).toBe(true);
    }

    const capture = controller.getCapture();
    expect(capture.stopReason).toBeNull();
    expect(capture.events).toHaveLength(4);
    expect(capture.events.slice(0, 2).map((event) => event.type)).toEqual([4, 2]);
    expect(capture.events.slice(2).map((event) => event.data)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ message: '3' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ message: '4' }) }),
    ]);
    expect(capture.stats.approximateBytes).toBe(
      capture.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    );
    controller.stop();
  });

  it('handles empty, removal-only, addition-only and missing-attribute mutations', () => {
    const observer = observerHarness();
    const removed = textNode('remove', 'removed-1');
    const sibling = textNode('sibling', 'sibling-1');
    const root = element('view', 'root-1', {}, [removed, sibling]);
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      now: () => 7_500,
    });
    const observerInstance = observer.current();
    const snapshot = fullSnapshotNode(controller.getCapture().events);
    const removedId = findNode(snapshot, (node) => node.textContent === 'remove')?.id;
    const siblingId = findNode(snapshot, (node) => node.textContent === 'sibling')?.id;

    observerInstance?.emit([{ type: 'childList', target: root }]);
    expect(controller.getCapture().events).toHaveLength(2);

    root.childNodes = [sibling];
    observerInstance?.emit([{ type: 'childList', target: root, removedNodes: [removed] }]);
    expect(mutationData(controller.getCapture().events[2] as TaroReplayPocEvent).removes).toEqual([
      { parentId: expect.any(Number), id: removedId },
    ]);

    const added = textNode('added', 'added-1');
    added.parentNode = root;
    root.childNodes = [added, sibling];
    observerInstance?.emit([
      { type: 'childList', target: root, addedNodes: [added], nextSibling: sibling },
    ]);
    expect(mutationData(controller.getCapture().events[3] as TaroReplayPocEvent).adds).toEqual([
      expect.objectContaining({ nextId: siblingId }),
    ]);

    const nodeWithoutAttributeMethods: TaroReplayNodeLike = {
      nodeType: 1,
      nodeName: 'view',
      sid: 'bare-1',
    };
    observerInstance?.emit([
      { type: 'attributes', target: nodeWithoutAttributeMethods, attributeName: 'title' },
    ]);
    expect(
      mutationData(controller.getCapture().events[4] as TaroReplayPocEvent).attributes,
    ).toEqual([expect.objectContaining({ attributes: { title: null } })]);

    observerInstance?.emit([{ type: 'attributes', target: root, attributeName: 'style' }]);
    expect(
      mutationData(controller.getCapture().events[5] as TaroReplayPocEvent).attributes,
    ).toEqual([expect.objectContaining({ attributes: { style: null } })]);

    const emptyText: TaroReplayNodeLike = {
      nodeType: 3,
      nodeName: '#text',
      sid: 'empty-text-1',
      textContent: null,
    };
    observerInstance?.emit([{ type: 'characterData', target: emptyText }]);
    expect(mutationData(controller.getCapture().events[6] as TaroReplayPocEvent).texts).toEqual([
      expect.objectContaining({ value: '' }),
    ]);

    const stopped = controller.stop();
    observerInstance?.emit([{ type: 'characterData', target: emptyText }]);
    expect(controller.stop()).toEqual(stopped);
    expect(observerInstance?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('automatically stops when the duration expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(8_000);
    try {
      const observer = observerHarness();
      const onStop = jest.fn();
      const controller = startTaroDomReplayPoc({
        blockAllMedia: false,
        root: element('view', 'root-1'),
        MutationObserver: observer.MutationObserver,
        maxDurationMs: 25,
        onStop,
      });

      expect(controller.getCapture().stopReason).toBeNull();
      jest.advanceTimersByTime(25);
      expect(controller.getCapture()).toEqual(
        expect.objectContaining({ endedAt: 8_025, stopReason: 'duration' }),
      );
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(observer.current()?.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses object ids for sid-less nodes and records attribute and child removal fallbacks', () => {
    const observer = observerHarness();
    const removed = textNode('remove me', 'removed-1');
    const root = element('custom-widget', '', { title: 'temporary' }, [removed]);
    delete root.sid;
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
      now: () => 2_500,
    });

    const initial = controller.getCapture();
    const placeholder = findNode(
      fullSnapshotNode(initial.events),
      (node) => node.attributes?.['data-taro-unsupported'] === 'custom-widget',
    );
    expect(placeholder?.tagName).toBe('div');
    expect(initial.warnings).toContain(
      'unsupported Taro node rendered as placeholder: custom-widget',
    );

    delete root.props['title'];
    root.childNodes = [];
    observer.current()?.emit([
      { type: 'attributes', target: root, attributeName: 'title' },
      { type: 'childList', target: root, addedNodes: [], removedNodes: [removed] },
    ]);

    const data = mutationData(controller.getCapture().events[2] as TaroReplayPocEvent);
    expect(data.attributes).toEqual([
      expect.objectContaining({
        id: placeholder?.id,
        attributes: { title: null },
      }),
    ]);
    expect(data.removes).toEqual([expect.objectContaining({ parentId: placeholder?.id })]);
    controller.stop();
  });

  it('does not start an observer after an initial event limit stop', () => {
    let constructorCount = 0;
    const onStop = jest.fn();

    class CountingObserver implements TaroReplayMutationObserverLike {
      constructor(_callback: (records: TaroReplayMutationRecordLike[]) => void) {
        constructorCount++;
      }
      observe() {}
      disconnect() {}
    }

    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('view', 'root-1'),
      MutationObserver: CountingObserver,
      maxEvents: 1,
      now: () => 3_000,
      onStop,
    });

    const capture = controller.getCapture();
    expect(capture.events).toHaveLength(1);
    expect(capture.stopReason).toBe('limit');
    expect(constructorCount).toBe(0);
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'limit' }));
  });
});
