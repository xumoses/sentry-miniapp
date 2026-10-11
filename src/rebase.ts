/** Pure rrweb checkpoint folding; shared algorithm in the recorder and adapter. */
interface ReplayEventLike {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}
interface ReplayNode {
  id: number;
  type?: number;
  childNodes?: ReplayNode[];
  attributes?: Record<string, unknown>;
  textContent?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function serializedNode(value: unknown): value is ReplayNode {
  return record(value) && typeof value['id'] === 'number';
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}

/** Clones lazily once and folds the DOM, input and scroll increments recorded by the SDK. */
export function createCheckpointRebaser<TEvent extends ReplayEventLike>(
  initial: TEvent,
): {
  apply(event: TEvent): void;
  getSnapshot(): TEvent;
} {
  let snapshot = initial;
  let root: ReplayNode | undefined;
  const nodes = new Map<number, ReplayNode>();
  const index = (): void => {
    nodes.clear();
    const visit = (node: ReplayNode): void => {
      nodes.set(node.id, node);
      for (const child of node.childNodes ?? []) visit(child);
    };
    if (root) visit(root);
  };
  const initialize = (): boolean => {
    if (root) return true;
    if (!serializedNode(initial.data['node'])) return false;
    snapshot = JSON.parse(JSON.stringify(initial)) as TEvent;
    root = snapshot.data['node'] as ReplayNode;
    index();
    return true;
  };
  const setAttribute = (node: ReplayNode, name: string, value: unknown): void => {
    const attributes = node.attributes ?? (node.attributes = {});
    if (value === null) delete attributes[name];
    else
      Object.defineProperty(attributes, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
  };
  return {
    apply(event): void {
      if (event.type !== 3 || ![0, 3, 5].includes(event.data['source'] as number) || !initialize())
        return;
      let changed = false;
      if (event.data['source'] === 3) {
        if (root?.type === 0 && event.data['id'] === root.id) {
          const offset = record(snapshot.data['initialOffset'])
            ? snapshot.data['initialOffset']
            : {};
          snapshot.data['initialOffset'] = offset;
          for (const [coordinate, name] of [
            ['x', 'left'],
            ['y', 'top'],
          ]) {
            const value = event.data[coordinate!];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              offset[name!] = value;
              changed = true;
            }
          }
        }
        const target = nodes.get(event.data['id'] as number);
        if (target && target.type !== 0)
          for (const [coordinate, name] of [
            ['x', 'rr_scrollLeft'],
            ['y', 'rr_scrollTop'],
          ]) {
            const value = event.data[coordinate!];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              setAttribute(target, name!, value);
              changed = true;
            }
          }
      } else if (event.data['source'] === 5) {
        const target = nodes.get(event.data['id'] as number);
        if (target && typeof event.data['text'] === 'string') {
          setAttribute(target, 'value', event.data['text']);
          changed = true;
        }
        if (target && typeof event.data['isChecked'] === 'boolean') {
          setAttribute(target, 'checked', event.data['isChecked'] ? true : null);
          changed = true;
        }
      } else {
        for (const remove of rows(event.data['removes'])) {
          const parent = nodes.get(remove['parentId'] as number);
          if (!parent?.childNodes) continue;
          const previous = parent.childNodes.length;
          parent.childNodes = parent.childNodes.filter((child) => child.id !== remove['id']);
          if (parent.childNodes.length !== previous) {
            changed = true;
            index();
          }
        }
        for (const add of rows(event.data['adds'])) {
          const parent = nodes.get(add['parentId'] as number);
          if (!parent || !serializedNode(add['node'])) continue;
          const added = JSON.parse(JSON.stringify(add['node'])) as ReplayNode;
          for (const node of nodes.values())
            if (node.childNodes?.some((child) => child.id === added.id))
              node.childNodes = node.childNodes.filter((child) => child.id !== added.id);
          const children = parent.childNodes ?? (parent.childNodes = []);
          const next = children.findIndex((child) => child.id === add['nextId']);
          children.splice(next < 0 ? children.length : next, 0, added);
          changed = true;
          index();
        }
        for (const text of rows(event.data['texts'])) {
          const target = nodes.get(text['id'] as number);
          if (target && typeof text['value'] === 'string') {
            target.textContent = text['value'];
            changed = true;
          }
        }
        for (const attributes of rows(event.data['attributes'])) {
          const target = nodes.get(attributes['id'] as number);
          if (target && record(attributes['attributes']))
            for (const [name, value] of Object.entries(attributes['attributes'])) {
              setAttribute(target, name, value);
              changed = true;
            }
        }
      }
      if (changed) snapshot.timestamp = Math.max(snapshot.timestamp, event.timestamp);
    },
    getSnapshot: () => snapshot,
  };
}
