/**
 * Runtime probes. Every one of these degrades to "no data" rather than
 * throwing: the SDK runs inside someone else's app and must never be the
 * reason it crashes.
 */

import { getBatchedBridge } from './rn.js';

declare const global: Record<string, any>;

/* --------------------------------------------------------------- JS FPS */

/**
 * Counts animation frames the JS thread actually serviced. React Native drives
 * `requestAnimationFrame` from the JS thread, so a shortfall here is a direct
 * measure of JS thread saturation — the thing that makes touch handling feel
 * sticky even when the UI thread is fine.
 */
export class FpsProbe {
  private frames = 0;
  private windowStart = now();
  private running = false;
  private rafId: number | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.windowStart = now();
    this.frames = 0;
    const loop = () => {
      if (!this.running) return;
      this.frames += 1;
      this.rafId = safeRaf(loop);
    };
    this.rafId = safeRaf(loop);
  }

  /** Frames per second since the last read, then resets the window. */
  read(): number | undefined {
    const elapsed = now() - this.windowStart;
    if (elapsed < 100) return undefined;
    const fps = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.windowStart = now();
    // A backgrounded app stops producing frames entirely; reporting 0 would
    // look like a catastrophic stall rather than an idle app.
    return Math.min(fps, 120);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof global.cancelAnimationFrame === 'function') {
      try { global.cancelAnimationFrame(this.rafId); } catch { /* ignore */ }
    }
    this.rafId = null;
  }
}

/* ------------------------------------------------------------- JS stalls */

/**
 * Measures how late a fixed-period timer actually fires. Drift is time the JS
 * thread spent inside one synchronous block, which is what users experience as
 * a freeze. FPS alone cannot distinguish "steadily slow" from "fine, then a
 * 400ms lockup" — this can.
 */
export class StallProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expected = 0;
  private maxStall = 0;
  private stallCount = 0;
  private readonly periodMs: number;
  private readonly thresholdMs: number;

  constructor(periodMs = 50, thresholdMs = 100) {
    this.periodMs = periodMs;
    this.thresholdMs = thresholdMs;
  }

  start(): void {
    if (this.timer) return;
    this.expected = now() + this.periodMs;
    this.timer = setInterval(() => {
      const current = now();
      const drift = current - this.expected;
      this.expected = current + this.periodMs;
      if (drift > this.thresholdMs) {
        this.stallCount += 1;
        if (drift > this.maxStall) this.maxStall = drift;
      }
    }, this.periodMs);
  }

  read(): { jsStallMaxMs: number; jsStallCount: number } {
    const result = { jsStallMaxMs: this.maxStall, jsStallCount: this.stallCount };
    this.maxStall = 0;
    this.stallCount = 0;
    return result;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/* --------------------------------------------------------------- JS heap */

/** Hermes exposes allocator stats; JSC and V8 expose `performance.memory`. */
export function readJsHeap(): { jsHeapMB?: number; jsHeapTotalMB?: number } {
  const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

  try {
    const hermes = global.HermesInternal;
    if (hermes && typeof hermes.getInstrumentedStats === 'function') {
      const stats = hermes.getInstrumentedStats();
      const used = stats.js_allocatedBytes ?? stats.js_heapSize;
      const total = stats.js_heapSize ?? stats.js_totalAllocatedBytes;
      if (typeof used === 'number') {
        return {
          jsHeapMB: toMb(used),
          jsHeapTotalMB: typeof total === 'number' ? toMb(total) : undefined,
        };
      }
    }
  } catch { /* fall through */ }

  try {
    const mem = global.performance?.memory;
    if (mem && typeof mem.usedJSHeapSize === 'number') {
      return { jsHeapMB: toMb(mem.usedJSHeapSize), jsHeapTotalMB: toMb(mem.totalJSHeapSize ?? 0) };
    }
  } catch { /* fall through */ }

  return {};
}

export function isHermes(): boolean {
  return Boolean(global.HermesInternal);
}

/* --------------------------------------------------------------- bridge */

/**
 * Counts calls crossing the legacy bridge by installing MessageQueue's spy
 * hook on the live bridge instance. Under the new architecture most calls are
 * synchronous JSI and never appear here, so a zero reading means "nothing on
 * the bridge", not "nothing happening".
 */
export class BridgeProbe {
  private calls = 0;
  private installed = false;

  start(): boolean {
    if (this.installed) return true;
    try {
      const bridge = getBatchedBridge();
      if (bridge) {
        // MessageQueue checks `this.__spy` on every call it dispatches.
        bridge.__spy = () => { this.calls += 1; };
        this.installed = true;
      }
    } catch { /* bridge spying unavailable */ }
    return this.installed;
  }

  read(): number | undefined {
    if (!this.installed) return undefined;
    const value = this.calls;
    this.calls = 0;
    return value;
  }

  stop(): void {
    try {
      const bridge = getBatchedBridge();
      if (bridge) bridge.__spy = null;
    } catch { /* ignore */ }
    this.installed = false;
  }
}

/* --------------------------------------------------------------- helpers */

export function now(): number {
  if (typeof global.nativePerformanceNow === 'function') return global.nativePerformanceNow();
  if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
  return Date.now();
}

function safeRaf(fn: () => void): number | null {
  try {
    if (typeof global.requestAnimationFrame === 'function') return global.requestAnimationFrame(fn);
  } catch { /* ignore */ }
  // Without rAF there is no frame signal at all; a timer would measure the
  // timer, not the frame loop, so report nothing instead of something wrong.
  return null;
}

/**
 * Metro resolves `require` at build time, so these deep imports have to go
 * through an indirect lookup to stay optional — the SDK must not hard-fail in
 * an app that has tree-shaken or renamed an internal module.
 */
