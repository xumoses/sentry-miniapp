import { describe, expect, it, jest } from '@jest/globals';
import {
  startTaroDomReplayPoc,
  type TaroReplayNodeLike,
  type TaroReplayScrollEventLike,
  type TaroReplayMutationRecordLike,
} from '../src/replay-poc';

interface FixtureNode extends TaroReplayNodeLike {
  props: Record<string, unknown>;
}
interface SnapshotNode {
  id: number;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
}
function element(
  name: string,
  props: Record<string, unknown> = {},
  children: FixtureNode[] = [],
): FixtureNode {
  const node: FixtureNode = {
    nodeType: 1,
    nodeName: name,
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
    child.parentNode = node;
  });
  return node;
}
function harness() {
  let emit: (records: TaroReplayMutationRecordLike[]) => void = () => undefined;
  class Observer {
    constructor(callback: typeof emit) {
      emit = callback;
    }
    observe() {}
    disconnect() {}
  }
  return {
    MutationObserver: Observer,
    emit: (records: TaroReplayMutationRecordLike[]) => emit(records),
  };
}
function find(
  node: SnapshotNode,
  predicate: (node: SnapshotNode) => boolean,
): SnapshotNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}
function marked(node: SnapshotNode, marker: string) {
  return find(node, (current) => current.attributes?.['data-fixture'] === marker);
}
function snapshot(controller: ReturnType<typeof startTaroDomReplayPoc>): SnapshotNode {
  return controller
    .getCapture()
    .events.filter((event) => event.type === 2)
    .at(-1)?.data['node'] as SnapshotNode;
}
function body(node: SnapshotNode) {
  return node.childNodes?.[0]?.childNodes?.[1];
}
const imageData = 'data:image/png;base64,aGVsbG8=';

describe('Taro business component replay semantics', () => {
  it('lifts enabled RootPortals out of clipping ancestors and keeps disabled ones in place', () => {
    const observer = harness();
    const enabled = element('root-portal', { 'data-fixture': 'enabled' }, [
      element('view', { className: 'nut-overlay' }),
    ]);
    const disabled = element('root-portal', { 'data-fixture': 'disabled', enable: false });
    const clipped = element('view', { 'data-fixture': 'clipped', style: 'overflow:hidden' }, [
      enabled,
      disabled,
    ]);
    const controller = startTaroDomReplayPoc({
      root: element('root', {}, [clipped]),
      MutationObserver: observer.MutationObserver,
    });
    const initial = snapshot(controller);
    expect(body(initial)?.childNodes).toContain(marked(initial, 'enabled'));
    expect(marked(initial, 'clipped')?.childNodes).toEqual([marked(initial, 'disabled')]);
    expect(controller.getCapture().warnings).not.toContain(
      'unsupported Taro node rendered as placeholder: root-portal',
    );
    const stableId = marked(initial, 'enabled')?.id;
    enabled.props['enable'] = false;
    observer.emit([{ type: 'attributes', target: enabled, attributeName: 'enable' }]);
    const next = snapshot(controller);
    expect(marked(next, 'enabled')?.id).toBe(stableId);
    expect(marked(next, 'clipped')?.childNodes).toContain(marked(next, 'enabled'));
    controller.stop();
  });

  it('checkpoints inserted or removed Portal subtrees without orphaning detached nodes', () => {
    const observer = harness();
    const root = element('root');
    const controller = startTaroDomReplayPoc({ root, MutationObserver: observer.MutationObserver });
    const portal = element('root-portal', { 'data-fixture': 'portal' });
    const wrapper = element('view', { 'data-fixture': 'wrapper' }, [portal]);
    root.childNodes?.push(wrapper);
    wrapper.parentNode = root;
    observer.emit([{ type: 'childList', target: root, addedNodes: [wrapper] }]);
    expect(body(snapshot(controller))?.childNodes).toContain(
      marked(snapshot(controller), 'portal'),
    );
    root.childNodes = [];
    observer.emit([{ type: 'childList', target: root, removedNodes: [wrapper] }]);
    expect(marked(snapshot(controller), 'portal')).toBeUndefined();
    expect(controller.getCapture().events.map((event) => event.type)).toEqual([4, 2, 2, 2]);
    controller.stop();
  });

  it('embeds only explicitly audited raster sources, including source mutations', () => {
    const observer = harness();
    const image = element('image', { 'data-fixture': 'image', src: '/assets/logo.png' });
    const dynamic = element('image', {
      'data-fixture': 'dynamic',
      src: 'data:image/png;base64,cHJpdmF0ZQ==',
    });
    const controller = startTaroDomReplayPoc({
      root: element('root', {}, [image, dynamic]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: {
        '/assets/logo.png': imageData,
        '/assets/icon.png': 'data:image/png;base64,d29ybGQ=',
      },
    });
    expect(marked(snapshot(controller), 'image')?.attributes?.['src']).toBe(imageData);
    expect(marked(snapshot(controller), 'dynamic')?.attributes?.['src']).toBe('data:image/png');
    image.props['src'] = '/assets/icon.png';
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    expect(controller.getCapture().events.at(-1)?.data['attributes']).toEqual([
      {
        id: marked(snapshot(controller), 'image')?.id,
        attributes: { src: 'data:image/png;base64,d29ybGQ=' },
      },
    ]);
    image.props['src'] = 'data:image/png;base64,cHJpdmF0ZQ==';
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    expect(controller.getCapture().events.at(-1)?.data['attributes']).toEqual([
      { id: marked(snapshot(controller), 'image')?.id, attributes: { src: 'data:image/png' } },
    ]);
    controller.stop();
  });

  it('rejects SVG, oversized and malformed trusted image entries without weakening URL privacy', () => {
    const observer = harness();
    const sources = {
      '/svg': 'data:image/svg+xml;base64,PHN2Zz4=',
      '/large': 'data:image/png;base64,' + 'a'.repeat(128 * 1024),
      '/invalid': 'data:image/png;base64,not base64',
      '/prototype': imageData,
    };
    const images = Object.keys(sources).map((src) =>
      element('image', { 'data-fixture': src, src }),
    );
    const controller = startTaroDomReplayPoc({
      root: element('root', {}, images),
      MutationObserver: observer.MutationObserver,
      staticImageSources: Object.assign(Object.create({ '/prototype': imageData }), {
        '/svg': sources['/svg'],
        '/large': sources['/large'],
        '/invalid': sources['/invalid'],
      }),
    });
    for (const src of Object.keys(sources))
      expect(marked(snapshot(controller), src)?.attributes?.['src']).toBe(src);
    controller.stop();
  });

  it('keeps every picker row and independently positions multi-column selected indices', () => {
    const observer = harness();
    const column = (name: string) =>
      element(
        'picker-view-column',
        { 'data-fixture': name },
        [0, 1, 2].map((index) => element('view', { 'data-fixture': name + index })),
      );
    const picker = element('picker-view', { value: [1, 99], indicatorStyle: 'height:36rpx;' }, [
      column('left'),
      column('right'),
    ]);
    const controller = startTaroDomReplayPoc({
      root: element('root', {}, [picker]),
      MutationObserver: observer.MutationObserver,
      width: 375,
    });
    const tree = snapshot(controller);
    expect(marked(tree, 'left')?.childNodes).toHaveLength(3);
    expect(marked(tree, 'left')?.attributes?.['style']).toContain(
      '--taro-replay-picker-selected:1',
    );
    expect(marked(tree, 'right')?.attributes?.['style']).toContain(
      '--taro-replay-picker-selected:2',
    );
    expect(marked(tree, 'left2')?.attributes?.['style']).toContain('--taro-replay-picker-row:2');
    expect(marked(tree, 'left2')?.attributes?.['data-taro-picker-row']).toBe(true);
    expect(
      find(tree, (node) => node.attributes?.['data-taro-node'] === 'picker-view')?.attributes?.[
        'style'
      ],
    ).toContain('--taro-replay-picker-item-height:18px');
    picker.props['value'] = [0, 1];
    observer.emit([{ type: 'attributes', target: picker, attributeName: 'value' }]);
    expect(marked(snapshot(controller), 'left')?.attributes?.['style']).toContain(
      '--taro-replay-picker-selected:0',
    );
    expect(marked(snapshot(controller), 'right')?.attributes?.['style']).toContain(
      '--taro-replay-picker-selected:1',
    );
    controller.stop();
  });

  it('records native picker change events while preserving handlers, restart state and teardown', () => {
    const observer = harness();
    const listeners = new Set<(event: TaroReplayScrollEventLike) => void>();
    const application = jest.fn();
    listeners.add(application);
    const column = element('picker-view-column', { 'data-fixture': 'column' }, [
      element('view'),
      element('view'),
    ]);
    const picker = Object.assign(element('picker-view', { defaultValue: [0] }, [column]), {
      addEventListener: jest.fn(
        (name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
          if (name === 'change') listeners.add(listener);
        },
      ),
      removeEventListener: jest.fn(
        (name: string, listener: (event: TaroReplayScrollEventLike) => void) => {
          if (name === 'change') listeners.delete(listener);
        },
      ),
    });
    const root = element('root', {}, [picker]);
    const controller = startTaroDomReplayPoc({ root, MutationObserver: observer.MutationObserver });
    const event = { detail: { value: [1] } };
    listeners.forEach((listener) => listener(event));
    expect(application).toHaveBeenCalledWith(event);
    expect(controller.getCapture().events.at(-1)?.data['attributes']).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({ style: '--taro-replay-picker-selected:1' }),
      }),
    ]);
    const count = controller.getCapture().events.length;
    listeners.forEach((listener) => listener(event));
    expect(controller.getCapture().events).toHaveLength(count);
    controller.stop();
    expect(listeners).toEqual(new Set([application]));
    const restarted = startTaroDomReplayPoc({ root, MutationObserver: observer.MutationObserver });
    expect(marked(snapshot(restarted), 'column')?.attributes?.['style']).toContain(
      '--taro-replay-picker-selected:1',
    );
    root.childNodes = [];
    observer.emit([{ type: 'childList', target: root, removedNodes: [picker] }]);
    expect(listeners).toEqual(new Set([application]));
    restarted.stop();
  });
  it('folds expired input and removed rows into the SDK rolling baseline before later activity', () => {
    const observer = harness();
    let now = 1000;
    const input = element('input', { 'data-fixture': 'input', value: '' });
    const rows = Array.from({ length: 12 }, () => element('view'));
    const list = element('view', { 'data-fixture': 'list' }, rows);
    const controller = startTaroDomReplayPoc({
      root: element('root', {}, [input, list]),
      MutationObserver: observer.MutationObserver,
      rollingWindowMs: 30000,
      maxDurationMs: 300000,
      maskInputValues: false,
      now: () => now,
    });
    now = 6000;
    input.props['value'] = '700';
    list.childNodes = rows.slice(0, 1);
    observer.emit([
      { type: 'attributes', target: input, attributeName: 'value' },
      { type: 'childList', target: list, removedNodes: rows.slice(1) },
    ]);
    now = 130000;
    controller.addBreadcrumb({ category: 'ui', message: 'later activity' });
    const capture = controller.getCapture();
    expect(marked(snapshot(controller), 'input')?.attributes?.['value']).toBe('700');
    expect(marked(snapshot(controller), 'list')?.childNodes).toHaveLength(1);
    expect(capture.events.map((event) => event.type)).toEqual([4, 2, 5]);
    expect(capture.events[0]?.timestamp).toBe((capture.events[1]?.timestamp ?? 0) - 1);
    expect(capture.stats.approximateBytes).toBe(
      capture.events.reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    );
    controller.stop();
  });
  it('keeps the previous compliant events and stats when rebasing cannot fit the byte cap', () => {
    const observer = harness();
    const input = element('input', { value: '' });
    const root = element('root', {}, [input]);
    const sizing = startTaroDomReplayPoc({ root, MutationObserver: observer.MutationObserver });
    const maxBytes = sizing.stop().stats.approximateBytes + 64;
    const controller = startTaroDomReplayPoc({
      root,
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
      rollingWindowMs: 30000,
      maxBytes,
    });
    const previous = controller.getCapture();
    input.props['value'] = 'x'.repeat(1024);
    observer.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);
    const capture = controller.getCapture();
    expect(capture.stopReason).toBe('limit');
    expect(capture.events).toEqual(previous.events);
    expect(capture.stats.eventCount).toBe(capture.events.length);
    expect(capture.stats.approximateBytes).toBe(previous.stats.approximateBytes);
    expect(capture.stats).toEqual(previous.stats);
    expect(capture.stats.approximateBytes).toBeLessThanOrEqual(maxBytes);
  });
});
