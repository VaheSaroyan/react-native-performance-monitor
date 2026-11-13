import type { ComponentRenderStat } from './types.js';

declare const global: Record<string, any>;

/* React fiber tags we care about — everything else is a host view or internal. */
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const MEMO_COMPONENT = 14;
const SIMPLE_MEMO_COMPONENT = 15;

const TRACKED_TAGS = new Set([
  FUNCTION_COMPONENT, CLASS_COMPONENT, FORWARD_REF, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT,
]);

interface Fiber {
  tag: number;
  type: any;
  elementType: any;
  child: Fiber | null;
  sibling: Fiber | null;
  actualDuration?: number;
  memoizedProps?: any;
  alternate?: Fiber | null;
}

/**
 * Attributes render work to components by reading React's own commit data.
 *
 * React populates `actualDuration` on every fiber in a profiling build, which
 * development bundles are. A fiber whose `actualDuration` is zero did not
 * re-render, and because the value is inclusive of children, a zero also means
 * nothing below it re-rendered — so whole subtrees can be skipped. That prune
 * is what makes walking the tree on every commit affordable.
 */
export class RenderTracker {
  private stats = new Map<string, ComponentRenderStat>();
  private installed = false;
  private previousHandler?: (rendererId: number, root: any, priority?: unknown) => void;
  private hook?: any;

  install(): boolean {
    if (this.installed) return true;
    const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) {
      // React has not been loaded yet, or DevTools support was stripped. The
      // caller decides whether to warn; render data is simply unavailable.
      return false;
    }
    this.hook = hook;
    this.previousHandler = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = (rendererId: number, root: any, priority?: unknown) => {
      try {
        this.walk(root?.current ?? null);
      } catch {
        // Never let instrumentation break a commit.
      }
      try {
        this.previousHandler?.call(hook, rendererId, root, priority);
      } catch { /* the other listener's problem */ }
    };
    this.installed = true;
    return true;
  }

  private walk(root: Fiber | null): void {
    if (!root) return;
    // Iterative traversal: a deep React Native tree can blow a recursive stack.
    const stack: Fiber[] = [root];
    while (stack.length) {
      const fiber = stack.pop()!;
      const duration = fiber.actualDuration ?? 0;

      // Inclusive of children, so zero prunes the whole subtree.
      if (duration <= 0) continue;

      if (TRACKED_TAGS.has(fiber.tag)) {
        const name = displayName(fiber);
        if (name) this.record(name, fiber, duration);
      }

      for (let child = fiber.child; child; child = child.sibling) stack.push(child);
    }
  }

  private record(name: string, fiber: Fiber, duration: number): void {
    // Self time: a parent's duration includes its children's, and charging the
    // same milliseconds to every ancestor would make the root look like the
    // hotspot in every single app.
    let childDuration = 0;
    for (let child = fiber.child; child; child = child.sibling) {
      childDuration += child.actualDuration ?? 0;
    }
    const selfMs = Math.max(0, duration - childDuration);

    const existing = this.stats.get(name);
    const entry: ComponentRenderStat = existing ?? { count: 0, totalMs: 0, maxMs: 0, wasted: 0 };
    entry.count += 1;
    entry.totalMs += selfMs;
    if (selfMs > entry.maxMs) entry.maxMs = selfMs;

    // A render whose props are shallow-equal to the previous commit's did no
    // useful work — the signature of a missing React.memo or a callback prop
    // that gets a new identity on every parent render.
    const props = fiber.memoizedProps;
    const previousProps = fiber.alternate?.memoizedProps;
    if (props && previousProps && typeof props === 'object' && shallowEqual(previousProps, props)) {
      entry.wasted = (entry.wasted ?? 0) + 1;
    }

    this.stats.set(name, entry);
  }

  /** Returns everything accumulated since the last read, then resets. */
  read(): Record<string, ComponentRenderStat> | undefined {
    if (this.stats.size === 0) return undefined;
    const out: Record<string, ComponentRenderStat> = {};
    for (const [name, stat] of this.stats) {
      out[name] = {
        count: stat.count,
        totalMs: Math.round(stat.totalMs * 100) / 100,
        maxMs: Math.round(stat.maxMs * 100) / 100,
        ...(stat.wasted ? { wasted: stat.wasted } : {}),
      };
    }
    this.stats.clear();
    return out;
  }

  uninstall(): void {
    if (!this.installed || !this.hook) return;
    this.hook.onCommitFiberRoot = this.previousHandler;
    this.installed = false;
    this.stats.clear();
  }
}

function displayName(fiber: Fiber): string | null {
  const type = fiber.elementType ?? fiber.type;
  if (!type) return null;

  // memo()/forwardRef() wrap the real component one or two levels down.
  const candidates = [type, type.type, type.render, type.type?.type, type.type?.render];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const name = candidate.displayName ?? candidate.name;
    if (typeof name === 'string' && name.length > 0 && name !== 'Unknown') {
      // Strip the wrappers HOCs add, so `Memo(ProductCard)` reports as ProductCard.
      return name.replace(/^(Memo|ForwardRef|Anonymous)\(?/, '').replace(/\)$/, '') || null;
    }
  }
  return null;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (key === 'children') continue; // a new element object every render by design
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}
