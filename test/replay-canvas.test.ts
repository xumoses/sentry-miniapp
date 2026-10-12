import { afterEach, expect, it, jest } from '@jest/globals';
import { createCheckpointRebaser } from '../src/rebase';
import {
  startTaroDomReplayPoc,
  type StartTaroDomReplayPocOptions,
  type TaroReplayMutationRecordLike,
  type TaroReplayNodeLike,
  type TaroReplayPocCapture,
  type TaroReplayScrollEventLike,
} from '../src/replay-poc';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
const JPEG =
  'data:image/jpeg;base64,/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==';
const WEBP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
// A valid PNG ancillary tEXt chunk grows a tiny fixture without changing its pixels.
function pngWithText(length: number): string {
  const png = Buffer.from(PNG.split(',')[1]!, 'base64');
  const text = Buffer.from(`Note\0${'x'.repeat(length)}`);
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length);
  chunk.write('tEXt', 4);
  text.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return `data:image/png;base64,${Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString('base64')}`;
}
interface Node extends TaroReplayNodeLike {
  props: Record<string, unknown>;
}
interface SnapshotNode {
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
}
let nextSid = 0;
function node(name = 'view', props: Record<string, unknown> = {}, children: Node[] = []): Node {
  const result: Node = {
    nodeType: 1,
    nodeName: name,
    sid: String(++nextSid),
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
const controllers: ReturnType<typeof startTaroDomReplayPoc>[] = [];
function mount(root: Node, options: Partial<StartTaroDomReplayPocOptions> = {}) {
  let onMutations = (_records: TaroReplayMutationRecordLike[]) => {};
  const listeners = new Map<string, (event: TaroReplayScrollEventLike) => void>();
  root.addEventListener = (name, fn) => {
    listeners.set(name, fn);
  };
  root.removeEventListener = (name) => {
    listeners.delete(name);
  };
  class Observer {
    constructor(callback: typeof onMutations) {
      onMutations = callback;
    }
    observe() {}
    disconnect() {}
  }
  const controller = startTaroDomReplayPoc({ root, MutationObserver: Observer, ...options });
  controllers.push(controller);
  return {
    controller,
    mutate: (records: TaroReplayMutationRecordLike[]) => onMutations(records),
    emit: (name: string, event: TaroReplayScrollEventLike) => listeners.get(name)?.(event),
  };
}
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.stop());
});
function nodes(capture: TaroReplayPocCapture): SnapshotNode[] {
  const snapshot = capture.events.filter((event) => event.type === 2).at(-1)!;
  const result: SnapshotNode[] = [];
  const visit = (current: SnapshotNode) => {
    result.push(current);
    current.childNodes?.forEach(visit);
  };
  visit(snapshot.data['node'] as SnapshotNode);
  return result;
}

it('keeps a stable image inside an opted-in canvas before its first frame and records only a src increment', () => {
  const canvas = node('canvas', {
    'data-sentry-canvas': true,
    style: 'position:absolute;width:200px;height:100px',
  });
  const { controller } = mount(node('view', {}, [canvas]), { recordCanvas: true });
  const initial = controller.getCapture();
  const wrapper = nodes(initial).find((item) => item.attributes?.['data-taro-node'] === 'canvas')!;
  expect(wrapper.tagName).toBe('div');
  expect(wrapper.attributes?.['style']).toBe('position:absolute;width:200px;height:100px');
  const image = wrapper.childNodes![0]!;
  expect(image.tagName).toBe('img');
  expect(image.attributes?.['src']).toBeUndefined();
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(true);
  const captured = controller.getCapture();
  expect(captured.events).toHaveLength(initial.events.length + 1);
  expect(captured.events.at(-1)).toMatchObject({
    type: 3,
    data: {
      source: 0,
      adds: [],
      removes: [],
      texts: [],
      attributes: [{ id: image.id, attributes: { src: PNG } }],
    },
  });
});

it('adds a new Canvas image as a flat synthetic child without exposing its native descendants', () => {
  const root = node('view');
  const h = mount(root, { recordCanvas: true });
  const canvas = node('view', { 'data-sentry-canvas': true }, [
    node('input', { value: 'native-descendant-secret' }),
  ]);
  canvas.parentNode = root;
  root.childNodes = [canvas];
  h.mutate([{ type: 'childList', target: root, addedNodes: [canvas] }]);
  const capture = h.controller.getCapture();
  const adds = capture.events.at(-1)!.data['adds'] as Array<{
    parentId: number;
    nextId: number | null;
    node: SnapshotNode;
  }>;
  expect(adds).toHaveLength(2);
  expect(adds[0]!.node.childNodes).toEqual([]);
  expect(adds[1]!).toMatchObject({
    parentId: adds[0]!.node.id,
    nextId: null,
    node: { tagName: 'img', childNodes: [] },
  });
  expect(JSON.stringify(capture)).not.toContain('native-descendant-secret');
  expect(h.controller.recordCanvas(canvas, () => PNG)).toBe(true);
  expect(h.controller.getCapture().events.at(-1)!.data['attributes']).toEqual([
    { id: adds[1]!.node.id, attributes: { src: PNG } },
  ]);
  expect(capture.events.filter((event) => event.type === 2)).toHaveLength(1);
});

it.each(['mask', 'block', 'ignore'])(
  'never reads %s-protected pixels and never restores a frame after protection is lifted',
  (marker) => {
    const canvas = node('view', { 'data-sentry-canvas': true });
    const root = node('view', {}, [canvas]);
    const h = mount(root, { recordCanvas: true });
    expect(h.controller.recordCanvas(canvas, () => PNG)).toBe(true);
    root.props[`data-sentry-${marker}`] = true;
    h.mutate([{ type: 'attributes', target: root, attributeName: `data-sentry-${marker}` }]);
    const read = jest.fn(() => PNG);
    expect(h.controller.recordCanvas(canvas, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(nodes(h.controller.getCapture()))).not.toContain(PNG);
    delete root.props[`data-sentry-${marker}`];
    h.mutate([{ type: 'attributes', target: root, attributeName: `data-sentry-${marker}` }]);
    expect(JSON.stringify(nodes(h.controller.getCapture()))).not.toContain(PNG);
  },
);

it('requires both explicit opt-ins, current root membership and a serialized node before reading', () => {
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const root = node('view', {}, [canvas]);
  const read = jest.fn(() => PNG);
  const disabled = mount(root).controller;
  expect(disabled.recordCanvas(canvas, read)).toBe(false);
  disabled.stop();
  const h = mount(root, { recordCanvas: true });
  const foreign = node('canvas', { 'data-sentry-canvas': true });
  const added = node('canvas', { 'data-sentry-canvas': true });
  added.parentNode = root;
  root.childNodes!.push(added);
  expect(h.controller.recordCanvas(foreign, read)).toBe(false);
  expect(h.controller.recordCanvas(added, read)).toBe(false);
  root.childNodes = [];
  expect(h.controller.recordCanvas(canvas, read)).toBe(false);
  h.controller.stop();
  expect(h.controller.recordCanvas(canvas, read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it('suppresses original marked descendants while retaining normal sibling mutations and events', () => {
  const hidden = node('input', { value: 'hidden-value' });
  const canvas = node('view', { 'data-sentry-canvas': true }, [hidden]);
  const sibling = node('view');
  const h = mount(node('view', {}, [canvas, sibling]), {
    recordCanvas: true,
    maskInputValues: false,
  });
  const before = h.controller.getCapture().events;
  hidden.props['value'] = 'hidden-update';
  h.mutate([{ type: 'attributes', target: hidden, attributeName: 'value' }]);
  const nested = node('view');
  nested.parentNode = canvas;
  canvas.childNodes!.push(nested);
  h.mutate([{ type: 'childList', target: canvas, addedNodes: [nested] }]);
  h.emit('input', { target: hidden, detail: { value: 'hidden-native-input' } });
  expect(h.controller.getCapture().events).toEqual(before);
  sibling.props['class'] = 'updated';
  h.mutate([{ type: 'attributes', target: sibling, attributeName: 'class' }]);
  expect(JSON.stringify(h.controller.getCapture())).toContain('updated');
  expect(JSON.stringify(h.controller.getCapture())).not.toContain('hidden-');
});

it('limits attempted reads to one per second, rejects invalid data and preserves the last valid frame', () => {
  let now = 1000;
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const { controller } = mount(node('view', {}, [canvas]), { recordCanvas: true, now: () => now });
  const failed = jest.fn(() => {
    throw new Error('read failure');
  });
  expect(controller.recordCanvas(canvas, failed)).toBe(false);
  const read = jest.fn(() => PNG);
  expect(controller.recordCanvas(canvas, read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  now += 1000;
  expect(controller.recordCanvas(canvas, read)).toBe(true);
  const before = controller.getCapture().events.length;
  now += 1000;
  expect(controller.recordCanvas(canvas, read)).toBe(false);
  expect(controller.getCapture().events).toHaveLength(before);
  for (const value of [
    undefined,
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,c2VjcmV0',
    'data:image/png;base64,%%%%',
    PNG + 'A',
    'data:image/png;base64,' + 'A'.repeat(128 * 1024),
  ]) {
    now += 1000;
    expect(controller.recordCanvas(canvas, () => value)).toBe(false);
  }
  controller.recordViewport({ width: 700, height: 500 });
  expect(
    nodes(controller.getCapture()).find((item) => item.tagName === 'img')?.attributes?.['src'],
  ).toBe(PNG);
});

it('refuses frames without stopping an otherwise valid recording when segment byte or event budgets are full', () => {
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const root = node('view', {}, [canvas]);
  const initial = mount(root, { recordCanvas: true }).controller.getCapture();
  const limitedBytes = mount(root, {
    recordCanvas: true,
    maxBytes: initial.stats.approximateBytes + 50,
  }).controller;
  expect(limitedBytes.recordCanvas(canvas, () => PNG)).toBe(false);
  expect(limitedBytes.getCapture().stopReason).toBeNull();
  expect(limitedBytes.getCapture().events).toHaveLength(2);
  const limitedEvents = mount(root, { recordCanvas: true, maxEvents: 2 }).controller;
  expect(limitedEvents.recordCanvas(canvas, () => PNG)).toBe(false);
  expect(limitedEvents.getCapture().stopReason).toBeNull();
});

it('caps total retained canvas frames across nodes and keeps the last accepted image', () => {
  let now = 1000;
  const canvases = [
    node('canvas', { 'data-sentry-canvas': true }),
    node('view', { 'data-sentry-canvas': true }),
  ];
  const { controller } = mount(node('view', {}, canvases), {
    recordCanvas: true,
    maxBytes: 100_000,
    now: () => now,
  });
  const frame = pngWithText(12_000);
  expect(controller.recordCanvas(canvases[0]!, () => frame)).toBe(true);
  controller.takeSegment();
  expect(controller.recordCanvas(canvases[1]!, () => frame)).toBe(false);
  now += 1000;
  expect(controller.recordCanvas(canvases[0]!, () => pngWithText(20_000))).toBe(false);
  expect(controller.getCapture().stopReason).toBeNull();
  controller.recordViewport({ width: 700, height: 500 });
  const images = nodes(controller.getCapture()).filter((item) => item.tagName === 'img');
  expect(images[0]?.attributes?.['src']).toBe(frame);
  expect(images[1]?.attributes?.['src']).toBeUndefined();
});

it('preflights a future checkpoint after draining without observing pending virtual DOM mutations', () => {
  let now = 1000;
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const sibling = node('view', { title: 'before' });
  const h = mount(node('view', {}, [canvas, sibling]), {
    recordCanvas: true,
    maskAllText: false,
    maskAttributes: [],
    maxBytes: 100_000,
    stylesheet: `/*${'x'.repeat(82_000)}*/`,
    now: () => now,
  });
  const initial = h.controller.getCapture();
  expect(initial.stopReason).toBeNull();
  const frame = pngWithText(1000);
  expect(h.controller.recordCanvas(canvas, () => frame)).toBe(true);
  h.controller.takeSegment();
  sibling.props['title'] = 'after';
  now += 1000;
  expect(h.controller.recordCanvas(canvas, () => pngWithText(14_000))).toBe(false);
  expect(h.controller.getCapture().stopReason).toBeNull();
  h.mutate([{ type: 'attributes', target: sibling, attributeName: 'title' }]);
  expect(JSON.stringify(h.controller.getCapture().events)).toContain('after');
  h.controller.takeSegment();
  h.controller.recordViewport({ width: 600, height: 500 });
  expect(h.controller.getCapture().stopReason).toBeNull();
  expect(
    nodes(h.controller.getCapture()).find((item) => item.tagName === 'img')?.attributes?.['src'],
  ).toBe(frame);
});

it('retains frames across session segments and rolling rebases using ordinary image mutations', () => {
  let now = 1000;
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const root = node('view', {}, [canvas]);
  const controller = mount(root, { recordCanvas: true, now: () => now }).controller;
  const first = controller.takeSegment();
  const image = nodes(first).find((item) => item.tagName === 'img')!;
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(true);
  const second = controller.takeSegment();
  expect(second.events).toHaveLength(1);
  const rebaser = createCheckpointRebaser(first.events.find((event) => event.type === 2)!);
  second.events.forEach((event) => rebaser.apply(event));
  expect(
    nodes({ ...first, events: [rebaser.getSnapshot()] }).find((item) => item.id === image.id)
      ?.attributes?.['src'],
  ).toBe(PNG);
  controller.stop();
  const rolling = mount(root, {
    recordCanvas: true,
    rollingWindowMs: 1000,
    now: () => now,
  }).controller;
  expect(rolling.recordCanvas(canvas, () => PNG)).toBe(true);
  now += 2000;
  rolling.addBreadcrumb({ category: 'test' });
  const buffered = rolling.takeSegment();
  expect(nodes(buffered).find((item) => item.tagName === 'img')?.attributes?.['src']).toBe(PNG);
  expect(rolling.getCapture().events).toEqual(buffered.events);
});

it('clears frames on removal or marker revocation but retains them across layout-only class changes', () => {
  const canvas = node('view', { 'data-sentry-canvas': true });
  const root = node('view', {}, [canvas]);
  const h = mount(root, { recordCanvas: true });
  expect(h.controller.recordCanvas(canvas, () => PNG)).toBe(true);
  const initialId = nodes(h.controller.getCapture()).find((item) => item.tagName === 'img')!.id;
  root.props['class'] = 'wide';
  h.mutate([{ type: 'attributes', target: root, attributeName: 'class' }]);
  h.controller.recordViewport({ width: 600, height: 500 });
  expect(
    nodes(h.controller.getCapture()).find((item) => item.tagName === 'img')?.attributes?.['src'],
  ).toBe(PNG);
  root.childNodes = [];
  h.mutate([{ type: 'childList', target: root, removedNodes: [canvas] }]);
  root.childNodes = [canvas];
  h.mutate([{ type: 'childList', target: root, addedNodes: [canvas] }]);
  const added = h.controller.getCapture().events.at(-1)!.data['adds'] as Array<{
    node: SnapshotNode;
  }>;
  const replacement = added.find((item) => item.node.tagName === 'img')!.node;
  expect(replacement.id).not.toBe(initialId);
  expect(replacement.attributes?.['src']).toBeUndefined();
  expect(h.controller.recordCanvas(canvas, () => PNG)).toBe(true);
  delete canvas.props['data-sentry-canvas'];
  h.mutate([{ type: 'attributes', target: canvas, attributeName: 'data-sentry-canvas' }]);
  canvas.props['data-sentry-canvas'] = true;
  h.mutate([{ type: 'attributes', target: canvas, attributeName: 'data-sentry-canvas' }]);
  expect(
    nodes(h.controller.getCapture()).find((item) => item.tagName === 'img')?.attributes?.['src'],
  ).toBeUndefined();
});

it('retains accepted Canvas pixels and image IDs when promoting an error buffer', () => {
  let now = 1000;
  const canvas = node('view', { 'data-sentry-canvas': true });
  const { controller } = mount(node('view', {}, [canvas]), {
    recordCanvas: true,
    rollingWindowMs: 30000,
    now: () => now,
  });
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(true);
  const prepared = controller.getCapture();
  const imageId = nodes(prepared).find((item) => item.tagName === 'img')!.id;
  expect(controller.promoteToSession(30000)).toBe(true);
  now += 1000;
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(false);
  now += 1000;
  expect(controller.recordCanvas(canvas, () => JPEG)).toBe(true);
  const next = controller.takeSegment();
  expect(next.events).toHaveLength(1);
  expect(next.events[0]!.data['attributes']).toEqual([{ id: imageId, attributes: { src: JPEG } }]);
  expect(JSON.stringify(prepared)).toContain(PNG);
  expect(JSON.stringify(prepared)).not.toContain(JPEG);
});

it('drains a full session before appending a permitted Canvas frame', () => {
  const canvas = node('view', { 'data-sentry-canvas': true });
  const segments: TaroReplayPocCapture[] = [];
  const { controller } = mount(node('view', {}, [canvas]), {
    recordCanvas: true,
    maxEvents: 2,
    onBufferFull: () => segments.push(controller.takeSegment()),
  });
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(true);
  expect(segments).toHaveLength(1);
  expect(segments[0]!.events.map((event) => event.type)).toEqual([4, 2]);
  expect(controller.getCapture().stopReason).toBeNull();
  expect(controller.getCapture().events).toHaveLength(1);
  expect(JSON.stringify(controller.getCapture())).toContain(PNG);
});

it.each([PNG, JPEG, WEBP])(
  'accepts a real raster fixture under its correct MIME type: %#',
  (frame) => {
    const canvas = node('canvas', { 'data-sentry-canvas': true });
    const { controller } = mount(node('view', {}, [canvas]), { recordCanvas: true });
    expect(controller.recordCanvas(canvas, () => frame)).toBe(true);
    expect(controller.getCapture().events.at(-1)?.data['attributes']).toEqual([
      {
        id: nodes(controller.getCapture()).find((item) => item.tagName === 'img')!.id,
        attributes: { src: frame },
      },
    ]);
  },
);

it('rejects inherited permission, unsupported containers and mismatched raster signatures', () => {
  const ordinary = node('canvas');
  const wrongKind = node('text', { 'data-sentry-canvas': true });
  const root = node('view', { 'data-sentry-canvas': true }, [ordinary, wrongKind]);
  const { controller } = mount(root, { recordCanvas: true });
  const read = jest.fn(() => PNG);
  expect(controller.recordCanvas(ordinary, read)).toBe(false);
  expect(controller.recordCanvas(wrongKind, read)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(controller.recordCanvas(root, () => PNG.replace('image/png', 'image/jpeg'))).toBe(false);
});

it('rechecks lifecycle and privacy after readFrame and isolates exceptions in event observers', () => {
  let now = 1000;
  const canvas = node('canvas', { 'data-sentry-canvas': true });
  const root = node('view', {}, [canvas]);
  const { controller } = mount(root, {
    recordCanvas: true,
    now: () => now,
    onEvent(event) {
      if (event.type === 3) throw new Error('observer failure');
    },
  });
  expect(
    controller.recordCanvas(canvas, () => {
      root.props['data-sentry-mask'] = true;
      return PNG;
    }),
  ).toBe(false);
  delete root.props['data-sentry-mask'];
  now += 1000;
  expect(controller.recordCanvas(canvas, () => PNG)).toBe(true);
  now += 1000;
  expect(
    controller.recordCanvas(canvas, () => {
      controller.stop();
      return JPEG;
    }),
  ).toBe(false);
  expect(JSON.stringify(controller.getCapture())).not.toContain(JPEG);
});
