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

  it('records a FullSnapshot and monotonic text mutations, then disconnects', () => {
    const observer = observerHarness();
    const text = textNode('zero', 'text-1');
    const root = element('view', 'root-1', {}, [text]);
    const controller = startTaroDomReplayPoc({
      root,
      MutationObserver: observer.MutationObserver,
      now: () => 1_000,
    });

    const initial = controller.getCapture();
    expect(initial.events.map((event) => event.type)).toEqual([4, 2]);
    expect(initial.events.map((event) => event.timestamp)).toEqual([1_000, 1_001]);
    expect(
      findNode(fullSnapshotNode(initial.events), (node) => node.textContent === 'zero'),
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
      expect.objectContaining({ value: 'one' }),
    ]);
    expect(capture.stats.mutationCount).toBe(1);
    expect(capture.stopReason).toBe('manual');
    expect(observer.current()?.disconnect).toHaveBeenCalledTimes(1);
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
    expect(data.adds[0]?.node.textContent).toBe('new child');
    controller.stop();
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
