import { afterEach, describe, expect, it } from '@jest/globals';
import {
  startTaroDomReplayPoc,
  type TaroReplayMutationRecordLike,
  type TaroReplayNodeLike,
} from '../src/replay-poc';

interface Node extends TaroReplayNodeLike {
  props: Record<string, unknown>;
}
const canary = 'synthetic-private-input-1047';
const editedCanary = 'synthetic-private-edit-1047';
function node(name: string, props: Record<string, unknown>, children: Node[] = []): Node {
  const result: Node = {
    nodeType: 1,
    nodeName: name,
    sid: 'reused-id',
    props,
    childNodes: children,
    get attributes() {
      return Object.entries(this.props).map(([name, value]) => ({ name, value }));
    },
    getAttribute(name) {
      return this.props[name] ?? '';
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
const active: ReturnType<typeof startTaroDomReplayPoc>[] = [];
afterEach(() => {
  active.splice(0).forEach((controller) => controller.stop());
});
function start(options: Parameters<typeof startTaroDomReplayPoc>[0]) {
  const controller = startTaroDomReplayPoc(options);
  active.push(controller);
  return controller;
}
function noCanary(controller: ReturnType<typeof startTaroDomReplayPoc>) {
  const serialized = JSON.stringify(controller.getCapture());
  // Boolean assertions keep synthetic password strings out of failure output.
  expect(serialized.includes(canary)).toBe(false);
  expect(serialized.includes(editedCanary)).toBe(false);
}
describe('Replay sensitive input lifetime', () => {
  it.each([
    { name: 'password', hidden: true, revealed: false },
    { name: 'type', hidden: 'password', revealed: 'text' },
    { name: 'data-sentry-mask', hidden: true, revealed: false },
  ])('keeps $name input masked after recorder restart, edits and rolling rebasing', (attribute) => {
    const observer = harness();
    let now = 1000;
    const input = node('input', { [attribute.name]: attribute.hidden, value: canary });
    const options = {
      root: input,
      MutationObserver: observer.MutationObserver,
      maskAllText: false,
      maskInputValues: false,
      rollingWindowMs: 30000,
      maxDurationMs: 300000,
      now: () => now,
    };
    const first = start(options);
    input.props[attribute.name] = attribute.revealed;
    observer.emit([{ type: 'attributes', target: input, attributeName: attribute.name }]);
    noCanary(first);
    first.stop();
    const restarted = start(options);
    noCanary(restarted);
    input.props['value'] = editedCanary;
    observer.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);
    noCanary(restarted);
    now = 130000;
    restarted.addBreadcrumb({ category: 'test', message: 'advance local fixture clock' });
    noCanary(restarted);
    expect(restarted.getCapture().events.map((event) => event.type)).toEqual([4, 2, 5]);
    restarted.stop();
  });
  it('masks descendant inputs and replacement nodes beneath a permanent sensitive ancestor', () => {
    const observer = harness();
    const input = node('input', { value: canary, type: 'text' });
    const root = node('view', { 'data-sentry-mask': true }, [input]);
    const options = {
      root,
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
      maskAllText: false,
    };
    const first = start(options);
    noCanary(first);
    root.props['data-sentry-mask'] = false;
    input.props['value'] = editedCanary;
    observer.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);
    noCanary(first);
    first.stop();
    const second = start(options);
    noCanary(second);
    second.stop();
    root.props['data-sentry-mask'] = true;
    const replacement = node('input', { value: canary, type: 'text' });
    replacement.parentNode = root;
    root.childNodes = [replacement];
    const third = start(options);
    noCanary(third);
    third.stop();
  });
  it('checkpoints descendant values when only an ancestor mask attribute changes', () => {
    const observer = harness();
    const input = node('input', { value: 'public', type: 'text' });
    const root = node('view', {}, [input]);
    const controller = start({
      root,
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
      maskAllText: false,
    });
    root.props['data-sentry-mask'] = true;
    input.props['value'] = canary;
    observer.emit([{ type: 'attributes', target: root, attributeName: 'data-sentry-mask' }]);
    noCanary(controller);
    const latest = controller.getCapture().events.at(-1);
    expect(JSON.stringify(latest).includes('*'.repeat(canary.length))).toBe(true);
  });
  it('does not mark an unrelated replacement input sensitive merely because its sid is reused', () => {
    const observer = harness();
    const secret = node('input', { password: true, value: canary });
    const first = start({
      root: secret,
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
    });
    noCanary(first);
    first.stop();
    const ordinary = node('input', { value: 'ordinary visible value', type: 'text' });
    const second = start({
      root: ordinary,
      MutationObserver: observer.MutationObserver,
      maskInputValues: false,
    });
    expect(JSON.stringify(second.getCapture()).includes('ordinary visible value')).toBe(true);
    second.stop();
  });
});
