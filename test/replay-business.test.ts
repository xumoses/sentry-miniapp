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
      blockAllMedia: false,
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
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    const portal = element('root-portal', { 'data-fixture': 'portal' });
    const wrapper = element('view', { 'data-fixture': 'wrapper' }, [portal]);
    root.childNodes?.push(wrapper);
    wrapper.parentNode = root;
    observer.emit([{ type: 'childList', target: root, addedNodes: [wrapper] }]);
    expect(body(snapshot(controller))?.childNodes).toContainEqual(
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
      blockAllMedia: false,
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

  it('preserves explicitly audited base64 SVGs in snapshots and source mutations', () => {
    const observer = harness();
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
    const charsetSvg = 'data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+';
    const image = element('image', { 'data-fixture': 'svg', src: '/assets/icon.svg' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [image]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: { '/assets/icon.svg': svg, [charsetSvg]: charsetSvg },
    });
    expect(marked(snapshot(controller), 'svg')?.attributes?.['src']).toBe(svg);
    image.props['src'] = charsetSvg;
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    expect(controller.getCapture().events.at(-1)?.data['attributes']).toEqual([
      { id: marked(snapshot(controller), 'svg')?.id, attributes: { src: charsetSvg } },
    ]);
    controller.stop();
  });

  it('preserves audited percent-encoded SVGs with and without a UTF-8 charset', () => {
    const observer = harness();
    const payload = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M0 0h1v1z"/></svg>',
    );
    const svg = `data:image/svg+xml,${payload}`;
    const charsetSvg = `data:image/svg+xml;charset=utf-8,${payload}`;
    const image = element('image', { 'data-fixture': 'svg', src: svg });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [image]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: { [svg]: svg, '/assets/icon.svg': charsetSvg },
    });
    const initial = marked(snapshot(controller), 'svg');
    image.props['src'] = '/assets/icon.svg';
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    const mutation = controller.getCapture().events.at(-1)?.data['attributes'];
    controller.stop();
    expect(initial?.attributes?.['src']).toBe(svg);
    expect(mutation).toEqual([{ id: initial?.id, attributes: { src: charsetSvg } }]);
  });

  it('keeps unlisted runtime SVG payloads private across snapshots and mutations', () => {
    const observer = harness();
    const canary = 'synthetic-private-svg-4471';
    const privateXml = `<svg xmlns="http://www.w3.org/2000/svg"><text>${canary}</text></svg>`;
    const runtimeBase64 = `data:image/svg+xml;base64,${Buffer.from(privateXml).toString('base64')}`;
    const runtimePercent = `data:image/svg+xml,${encodeURIComponent(privateXml)}`;
    const trusted = 'data:image/svg+xml;base64,PHN2Zy8+';
    const image = element('image', { 'data-fixture': 'image', src: runtimeBase64 });
    const view = element('view', { 'data-fixture': 'view', src: trusted });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [image, view]),
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
      staticImageSources: { '/assets/icon.svg': trusted, [trusted]: trusted },
    });
    const initial = snapshot(controller);
    image.props['src'] = '/assets/icon.svg';
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    image.props['src'] = runtimePercent;
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    const mutation = controller.getCapture().events.at(-1)?.data['attributes'];
    image.props['src'] = `${trusted}#${canary}`;
    observer.emit([{ type: 'attributes', target: image, attributeName: 'src' }]);
    const captured = JSON.stringify(controller.getCapture());
    controller.stop();
    expect(marked(initial, 'image')?.attributes?.['src']).toBe('data:image/svg+xml');
    expect(marked(initial, 'view')?.attributes?.['src']).toBe('data:image/svg+xml');
    expect(mutation).toEqual([
      { id: marked(initial, 'image')?.id, attributes: { src: 'data:image/svg+xml' } },
    ]);
    expect(captured.includes(canary)).toBe(false);
    expect(captured.includes(runtimeBase64)).toBe(false);
    expect(captured.includes(runtimePercent)).toBe(false);
  });

  it.each([
    ['mixed-case', 'Data:'],
    ['uppercase', 'DATA:'],
    ['leading-space', ' data:'],
    ['leading-tab', '\tdata:'],
    ['leading-newline', '\ndata:'],
    ['leading-null', '\u0000data:'],
    ['leading-C0', '\u001fdata:'],
    ['scheme-tab', 'da\tta:'],
    ['scheme-newline', 'da\nta:'],
    ['scheme-carriage-return', 'da\rta:'],
  ])('filters unlisted SVG payloads accepted as browser data URLs: %s', (_name, scheme) => {
    const observer = harness();
    const canary = 'synthetic-private-mixed-case-svg-4472';
    const xml = `<svg><text>${canary}</text></svg>`;
    const percent = `${scheme}image/svg+xml,${encodeURIComponent(xml)}`;
    const base64 = `${scheme}image/svg+xml;base64,${Buffer.from(xml).toString('base64')}`;
    expect(new URL(percent).protocol).toBe('data:');
    expect(new URL(base64).protocol).toBe('data:');
    const trusted = 'data:image/svg+xml;base64,PHN2Zy8+';
    const dynamic = element('image', { 'data-fixture': 'dynamic', src: percent });
    const mutable = element('image', { 'data-fixture': 'mutable', src: '/assets/icon.svg' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [dynamic, mutable]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: { '/assets/icon.svg': trusted },
    });
    const initial = snapshot(controller);
    mutable.props['src'] = base64;
    observer.emit([{ type: 'attributes', target: mutable, attributeName: 'src' }]);
    const mutation = controller.getCapture().events.at(-1)?.data['attributes'];
    const captured = JSON.stringify(controller.getCapture());
    controller.stop();
    expect(marked(initial, 'dynamic')?.attributes?.['src']).toBe('data:image/svg+xml');
    expect(mutation).toEqual([
      { id: marked(initial, 'mutable')?.id, attributes: { src: 'data:image/svg+xml' } },
    ]);
    expect(captured.includes(canary)).toBe(false);
    expect(captured.includes(percent)).toBe(false);
    expect(captured.includes(base64)).toBe(false);
  });

  it('keeps whitelist keys exact while normalizing browser-ignored URL characters', () => {
    const observer = harness();
    const trusted = 'data:image/svg+xml;base64,PHN2Zy8+';
    const ordinary = ' \thttps://example.test/static/icon\n.svg';
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [
        element('image', { 'data-fixture': 'exact', src: trusted }),
        element('image', { 'data-fixture': 'variant', src: `\t${trusted}` }),
        element('image', { 'data-fixture': 'ordinary', src: ordinary }),
      ]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: { [trusted]: trusted },
    });
    const initial = snapshot(controller);
    controller.stop();
    expect(marked(initial, 'exact')?.attributes?.['src']).toBe(trusted);
    expect(marked(initial, 'variant')?.attributes?.['src']).toBe('data:image/svg+xml');
    expect(marked(initial, 'ordinary')?.attributes?.['src']).toBe(
      'https://example.test/static/icon.svg',
    );
  });

  it.each([
    ['invalid-percent', 'data:image/svg+xml,%3Csvg%ZZ'],
    ['invalid-utf8', 'data:image/svg+xml,%FF'],
    ['raw-xml', 'data:image/svg+xml,<svg/>'],
    ['empty-base64', 'data:image/svg+xml;base64,'],
    ['invalid-base64-padding', 'data:image/svg+xml;base64,PHN2Zy8+==='],
    ['incomplete-base64', 'data:image/svg+xml;base64,PHN2Zz4'],
    ['unsupported-mime', 'data:text/html;base64,PHN2Zy8+'],
    ['oversized-base64', 'data:image/svg+xml;base64,' + 'A'.repeat(128 * 1024)],
    ['oversized-percent', 'data:image/svg+xml,' + '%20'.repeat(44 * 1024)],
  ])('filters invalid or oversized trusted SVG encoding: %s', (_name, value) => {
    const observer = harness();
    const image = element('image', { 'data-fixture': 'image', src: '/assets/icon.svg' });
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root: element('root', {}, [image]),
      MutationObserver: observer.MutationObserver,
      staticImageSources: { '/assets/icon.svg': value },
    });
    const recorded = marked(snapshot(controller), 'image')?.attributes?.['src'];
    controller.stop();
    expect(recorded).toBe('/assets/icon.svg');
  });

  it('counts SVGs used by the DOM rather than the source map, including repeated sources', () => {
    const xml = `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(70000)}--></svg>`;
    const svg = `data:image/svg+xml;base64,${Buffer.from(xml).toString('base64')}`;
    const staticImageSources = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`/unused/asset-${index}.svg`, svg]),
    );
    staticImageSources['/assets/icon.svg'] = svg;
    expect(Buffer.byteLength(JSON.stringify(staticImageSources))).toBeGreaterThan(512 * 1024);
    const record = (count: number) => {
      const observer = harness();
      const controller = startTaroDomReplayPoc({
        blockAllMedia: false,
        root: element(
          'root',
          {},
          Array.from({ length: count }, () => element('image', { src: '/assets/icon.svg' })),
        ),
        MutationObserver: observer.MutationObserver,
        staticImageSources,
        maxBytes: 512 * 1024,
      });
      return controller.stop();
    };
    const sparse = record(1);
    expect(sparse.events.map((event) => event.type)).toEqual([4, 2]);
    expect(JSON.stringify(sparse.events).includes('/unused/asset-')).toBe(false);
    const repeated = record(2);
    expect(JSON.stringify(repeated.events).split(svg)).toHaveLength(3);
    const oversized = record(6);
    expect(oversized.stopReason).toBe('limit');
    expect(oversized.events.map((event) => event.type)).toEqual([4]);
    expect(oversized.stats.approximateBytes).toBeLessThanOrEqual(512 * 1024);
  });

  it('rejects oversized and malformed trusted image entries without weakening URL privacy', () => {
    const observer = harness();
    const sources = {
      '/svg': 'data:image/svg+xml;base64,invalid?',
      '/large': 'data:image/png;base64,' + 'a'.repeat(128 * 1024),
      '/invalid': 'data:image/png;base64,not base64',
      '/prototype': imageData,
    };
    const images = Object.keys(sources).map((src) =>
      element('image', { 'data-fixture': src, src }),
    );
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
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
      blockAllMedia: false,
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
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
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
    const restarted = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
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
      blockAllMedia: false,
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
    const sizing = startTaroDomReplayPoc({
      blockAllMedia: false,
      root,
      MutationObserver: observer.MutationObserver,
    });
    const maxBytes = sizing.stop().stats.approximateBytes + 64;
    const controller = startTaroDomReplayPoc({
      blockAllMedia: false,
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
