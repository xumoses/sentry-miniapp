import { describe, expect, it, jest } from '@jest/globals';
import {
  startTaroDomReplayPoc,
  type TaroReplayMutationObserverLike,
  type TaroReplayMutationRecordLike,
  type TaroReplayNodeLike,
  type TaroReplayPocEvent,
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
  it('rejects a missing mounted root', () => {
    const observer = observerHarness();
    expect(() =>
      startTaroDomReplayPoc({
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

  it('includes caller-provided Sentry metadata in the capture', () => {
    const observer = observerHarness();
    const controller = startTaroDomReplayPoc({
      root: element('view', 'root-1'),
      MutationObserver: observer.MutationObserver,
      metadata: {
        environment: 'develop',
        release: 'derivative-manager-test',
        sdk: { name: 'sentry.javascript.miniapp', version: '1.13.1' },
        user: { id: 'replay-poc-user' },
        tags: { framework: 'taro', 'miniapp.platform': 'wechat' },
        contexts: { miniapp: { route: 'pages/ReplayPoc/index' } },
      },
      now: () => 5_000,
    });

    expect(controller.getCapture().metadata).toEqual({
      environment: 'develop',
      release: 'derivative-manager-test',
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

  it('allows privacy-safe text opt-out and strips URL secrets from captures', () => {
    const observer = observerHarness();
    const image = element('image', 'image-1', {
      src: 'https://user:password@example.com/avatar.png?token=secret#profile',
      'data-access-token': 'private-token',
    });
    const root = element('view', 'root-1', {}, [textNode('public text', 'text-1'), image]);
    const controller = startTaroDomReplayPoc({
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
        href: '',
      }),
    );
    expect(button?.attributes).not.toHaveProperty('onTap');
    expect(
      findNode(
        snapshot,
        (node) => node.attributes?.['data-taro-unsupported'] === 'unknown',
      ),
    ).toBeDefined();
    expect(findNode(snapshot, (node) => node.type === 5)?.textContent).toBe('');
    expect(findNode(snapshot, (node) => node.tagName === 'input')?.attributes?.['value']).toBe('');
    expect(capture.metadata).toEqual({ environment: 'test' });
    controller.stop();

    const unmaskedInputController = startTaroDomReplayPoc({
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

  it('handles empty, removal-only, addition-only and missing-attribute mutations', () => {
    const observer = observerHarness();
    const removed = textNode('remove', 'removed-1');
    const sibling = textNode('sibling', 'sibling-1');
    const root = element('view', 'root-1', {}, [removed, sibling]);
    const controller = startTaroDomReplayPoc({
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

    observerInstance?.emit([{ type: 'childList', target: root, removedNodes: [removed] }]);
    expect(mutationData(controller.getCapture().events[2] as TaroReplayPocEvent).removes).toEqual([
      { parentId: expect.any(Number), id: removedId },
    ]);

    const added = textNode('added', 'added-1');
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
