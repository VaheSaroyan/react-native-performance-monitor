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

/** Set by React on a fiber whose component function (or class render) actually ran. */
const PERFORMED_WORK = 0b1;

interface Fiber {
  tag: number;
  flags?: number;
  effectTag?: number;
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
 * A commit only touches part of the tree. React clones the fibers on the path
 * to each update and reuses everything else untouched, so a fiber whose child
 * pointer is the same object as its alternate's has an untouched subtree below
 * it: nothing there ran in this commit. Skipping those subtrees is what makes
 * walking the tree on every commit affordable, and it is also what keeps the
 * counts honest — a reused fiber still carries the `actualDuration` and flags
 * of the last commit it took part in, so reading them again would count one
 * render once per later commit, forever.
 *
 * Among the fibers that were touched, only those with the PerformedWork flag
 * ran their component; the rest were cloned on the way down and bailed out.
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
    // Each entry carries whether an ancestor is a navigation screen that is
    // mounted but not focused, so work done for a screen nobody is looking at
    // can be told apart from work for the one on display.
    const stack: Array<[Fiber, boolean]> = [[root, false]];
    while (stack.length) {
      const [fiber, inheritedOffScreen] = stack.pop()!;
      const offScreen = inheritedOffScreen || isBlurredScreen(fiber);

      if (TRACKED_TAGS.has(fiber.tag) && didRender(fiber)) {
        const name = displayName(fiber);
        if (name) this.record(name, fiber, fiber.actualDuration ?? 0, offScreen);
      }

      // Children that are the very objects the previous tree had were reused
      // wholesale: nothing below this fiber took part in the commit.
      const alternate = fiber.alternate;
      if (alternate && alternate.child === fiber.child) continue;

      for (let child = fiber.child; child; child = child.sibling) stack.push([child, offScreen]);
    }
  }

  private record(name: string, fiber: Fiber, duration: number, offScreen: boolean): void {
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
    // No alternate means this fiber has never been committed before: the
    // component is appearing, not updating. Opening a screen mounts thousands
    // of components once each, and that is not the same thing as a component
    // that keeps re-rendering.
    if (!fiber.alternate) entry.mounts = (entry.mounts ?? 0) + 1;
    else if (offScreen) entry.offScreen = (entry.offScreen ?? 0) + 1;
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
        ...(stat.mounts ? { mounts: stat.mounts } : {}),
        ...(stat.offScreen ? { offScreen: stat.offScreen } : {}),
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

/**
 * Leaving a screen re-renders parts of it once, as focus state propagates. That
 * is the transition itself, not background work, so a screen only counts as
 * off screen once it has been blurred for this long.
 */
const BLUR_SETTLE_MS = 1000;

const screenFocus = new Map<string, { blurred: boolean; since: number }>();

/**
 * React Navigation renders each screen through a component that receives its
 * `route` and a `navigation` object, and keeps blurred screens mounted. That
 * pair of props is what identifies a screen here; `isFocused()` is read at
 * commit time, which is exactly when the question is being asked.
 */
function isBlurredScreen(fiber: Fiber): boolean {
  const props = fiber.memoizedProps;
  if (!props || typeof props !== 'object' || !props.route) return false;
  const navigation = props.navigation;
  if (!navigation || typeof navigation.isFocused !== 'function') return false;
  const key = props.route.key;
  if (typeof key !== 'string') return false;

  let blurred: boolean;
  try {
    blurred = navigation.isFocused() === false;
  } catch {
    return false;
  }

  const now = Date.now();
  const known = screenFocus.get(key);
  if (!known || known.blurred !== blurred) {
    // Bounded by the number of screens ever mounted, which stays small; clear
    // it anyway if an app churns through dynamic routes.
    if (screenFocus.size > 500) screenFocus.clear();
    screenFocus.set(key, { blurred, since: now });
    return false;
  }
  return blurred && now - known.since >= BLUR_SETTLE_MS;
}

function didRender(fiber: Fiber): boolean {
  return (((fiber.flags ?? fiber.effectTag ?? 0) as number) & PERFORMED_WORK) !== 0;
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
