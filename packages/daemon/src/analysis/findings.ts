import type { Finding, PerfEvent, Sample, SessionSummary, Severity } from '@rnperf/protocol';
import { round } from '../util/stats.js';
import { aggregateRenders } from './summarize.js';

export interface Thresholds {
  jsFpsLow: number;
  jsFpsCritical: number;
  stallMs: number;
  stallCriticalMs: number;
  jankPercent: number;
  frameBudgetMs: number;
  memGrowthMbPerMin: number;
  memGrowthFit: number;
  /** Shortest window that can support a leak verdict. */
  memGrowthMinMs: number;
  /** Total rise required, so sub-noise "leaks" with a tidy fit are ignored. */
  memGrowthMinMB: number;
  cpuPercent: number;
  ttiMs: number;
  rendersPerSecond: number;
  renderMsAvg: number;
  bridgeCallsPerSecond: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  jsFpsLow: 45,
  jsFpsCritical: 30,
  stallMs: 100,
  stallCriticalMs: 350,
  jankPercent: 10,
  frameBudgetMs: 16.67,
  memGrowthMbPerMin: 2,
  memGrowthFit: 0.75,
  memGrowthMinMs: 45_000,
  memGrowthMinMB: 5,
  cpuPercent: 85,
  ttiMs: 2000,
  rendersPerSecond: 15,
  renderMsAvg: 8,
  bridgeCallsPerSecond: 400,
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * React Native's own components show up in the commit tree like any other, but
 * "View re-renders constantly" is not something anyone can act on — the fix
 * always belongs to the app component that renders them. They stay in the
 * component table as context and are kept out of findings.
 */
const FRAMEWORK_COMPONENTS = new Set([
  'View', 'Text', 'Image', 'ImageBackground', 'ScrollView', 'FlatList', 'SectionList',
  'VirtualizedList', 'VirtualizedListContextProvider', 'CellRenderer', 'TextInput',
  'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback',
  'TouchableNativeFeedback', 'SafeAreaView', 'KeyboardAvoidingView', 'Modal',
  'ActivityIndicator', 'Switch', 'RefreshControl', 'StatusBar', 'Animated',
  'AnimatedComponent', 'RCTView', 'RCTText', 'RCTScrollView', 'AppContainer',
  'RootComponent', 'Context.Provider', 'Context.Consumer', 'Suspense', 'Fragment',
  'StrictMode', 'Profiler', 'ThemeProvider', 'NavigationContainer', 'Screen',
  'ScreenStack', 'ScreenContainer', 'GestureHandlerRootView',
]);

function isAppComponent(name: string): boolean {
  if (FRAMEWORK_COMPONENTS.has(name)) return false;
  // Internal wrappers React Native and libraries generate.
  if (/^(RCT|RN|Animated|Internal|Base|Styled)[A-Z]/.test(name)) return false;
  if (/(Provider|Consumer|Context)$/.test(name)) return false;
  return true;
}

/**
 * Turns a finished (or in-flight) session into a ranked list of concrete
 * problems. Each finding carries the numbers that produced it and a
 * remediation specific enough for a coding agent to act on.
 */
export function deriveFindings(
  summary: SessionSummary,
  samples: Sample[],
  events: PerfEvent[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const out: Finding[] = [];
  const m = summary.metrics;
  // A ProMotion display has an 8.3ms budget, not 16.7ms. When the app reports
  // its refresh rate, hold it to the budget it actually has.
  const refreshHz = samples.find((s) => typeof s.uiRefreshHz === 'number')?.uiRefreshHz;
  const frameBudgetMs = refreshHz && refreshHz > 20 ? 1000 / refreshHz : thresholds.frameBudgetMs;
  const durationMin = Math.max(summary.durationMs / 60_000, 1 / 60);
  const durationSec = Math.max(summary.durationMs / 1000, 1);

  /* ---------------------------------------------------------- JS thread */

  const jsFps = m['jsFps'];
  if (jsFps && jsFps.samples >= 5 && jsFps.p05 < thresholds.jsFpsLow) {
    const critical = jsFps.p05 < thresholds.jsFpsCritical;
    out.push({
      kind: 'js-fps-low',
      severity: critical ? 'critical' : 'high',
      title: 'JS thread is dropping frames',
      subject: worstScreen(summary, samples, 'jsFps', 'low'),
      evidence:
        `JS FPS p05 ${round(jsFps.p05, 1)}, median ${round(jsFps.p50, 1)}, worst ${round(jsFps.min, 1)} ` +
        `over ${jsFps.samples} samples.`,
      suggestion:
        'The JS thread cannot keep up, so touch handling and JS-driven animation will stutter. ' +
        'Move animations to the native driver (`useNativeDriver: true`, or Reanimated worklets), ' +
        'push heavy transforms out of render into `useMemo`, and check for synchronous work in ' +
        '`onScroll`/`onChangeText` handlers. Confirm Hermes is enabled — the interpreter difference is large.',
      data: { p05: round(jsFps.p05, 1), p50: round(jsFps.p50, 1), min: round(jsFps.min, 1) },
    });
  }

  const stall = m['jsStallMaxMs'];
  if (stall && stall.max >= thresholds.stallMs) {
    out.push({
      kind: 'js-thread-stall',
      severity: stall.max >= thresholds.stallCriticalMs ? 'critical' : 'high',
      title: 'JS event loop blocked',
      subject: worstScreen(summary, samples, 'jsStallMaxMs', 'high'),
      evidence:
        `Longest JS stall ${round(stall.max)}ms (p95 ${round(stall.p95)}ms). ` +
        `A stall over ${Math.round(frameBudgetMs)}ms means at least one dropped frame` +
        `${refreshHz ? ` on this ${Math.round(refreshHz)}Hz display` : ''}.`,
      suggestion:
        'Something is running a long synchronous block on the JS thread. Usual causes: JSON.parse of a ' +
        'large payload, a big `.map`/`.filter` chain over a list, synchronous AsyncStorage/MMKV reads, or ' +
        'date formatting in a render loop. Move the work behind `InteractionManager.runAfterInteractions`, ' +
        'chunk it, or hand it to a native module or worklet.',
      data: { maxMs: round(stall.max), p95Ms: round(stall.p95) },
    });
  }

  /* ------------------------------------------------------------ UI jank */

  const jank = m['jankPercent'];
  const p95 = m['frameP95Ms'];
  if (jank && jank.p50 >= thresholds.jankPercent) {
    out.push({
      kind: 'ui-jank',
      severity: jank.p50 >= thresholds.jankPercent * 3 ? 'critical' : 'high',
      title: 'UI thread is missing its frame budget',
      subject: worstScreen(summary, samples, 'jankPercent', 'high'),
      evidence:
        `${round(jank.p50, 1)}% of frames exceeded the ${round(frameBudgetMs)}ms budget` +
        `${refreshHz ? ` of a ${Math.round(refreshHz)}Hz display` : ''}` +
        (p95 ? `; frame time p95 ${round(p95.p50)}ms, p99 ${round(m['frameP99Ms']?.p50 ?? 0)}ms.` : '.'),
      suggestion:
        'Frames are being dropped on the native UI thread, which JS-side fixes will not help. ' +
        'Look for deep view hierarchies, overlapping translucent views, large uncached images ' +
        '(size them to their display dimensions), shadows on Android (`elevation` is cheaper), and ' +
        '`overflow: hidden` with border radius on scrolling content.',
      data: {
        jankPercent: round(jank.p50, 1),
        frameP95Ms: p95 ? round(p95.p50) : 0,
        frameBudgetMs: round(frameBudgetMs),
        ...(refreshHz ? { refreshHz: Math.round(refreshHz) } : {}),
      },
    });
  }

  /* ------------------------------------------------------------- memory */

  // Any app allocates while it warms up, so a short window produces a textbook
  // straight line and an R² of 1 that means nothing. A leak verdict needs a
  // window long enough for startup allocation to have settled, a rise big
  // enough to matter, and a fit tight enough to rule out ordinary churn.
  const longEnoughForLeaks = summary.durationMs >= thresholds.memGrowthMinMs;

  for (const key of ['rssMB', 'pssMB', 'jsHeapMB', 'javaHeapMB', 'nativeHeapMB'] as const) {
    const stat = m[key];
    if (!longEnoughForLeaks || !stat || stat.samples < 20) continue;
    if (stat.slopePerMin < thresholds.memGrowthMbPerMin || stat.fit < thresholds.memGrowthFit) continue;
    if (stat.max - stat.min < thresholds.memGrowthMinMB) continue;
    // Only extrapolate as far ahead as the evidence reaches back; projecting
    // ten minutes from a one-minute window invents a number.
    const projectMin = Math.min(10, durationMin);
    const projected = stat.max + stat.slopePerMin * projectMin;
    // A couple of minutes is enough to be confident; less than that, the
    // trend is real but calling it critical overstates the evidence.
    const confident = summary.durationMs >= thresholds.memGrowthMinMs * 2.5;
    out.push({
      kind: 'memory-growth',
      severity: confident && stat.slopePerMin > thresholds.memGrowthMbPerMin * 5 ? 'critical' : 'high',
      title: `${LABEL[key]} is growing steadily`,
      subject: key,
      evidence:
        `${LABEL[key]} rose from ${round(stat.min, 1)}MB to ${round(stat.max, 1)}MB — ` +
        `${round(stat.slopePerMin, 2)}MB/min with R²=${round(stat.fit, 2)} over ${durationMin.toFixed(1)} min. ` +
        `At this rate it reaches ~${round(projected, 0)}MB after ${round(projectMin, 1)} more minutes.`,
      suggestion:
        key === 'jsHeapMB'
          ? 'A steady JS heap climb usually means retained listeners or timers. Check that every ' +
            '`addEventListener`, `addListener`, `setInterval`, navigation listener and subscription is ' +
            'torn down in the `useEffect` cleanup, and that closures in long-lived caches are not holding ' +
            'component props. An unbounded in-memory cache or a growing Redux slice will look identical.'
          : 'Native memory is not being released. Common causes: images kept at full resolution in a list, ' +
            'an unbounded image cache, retained native views from a map/webview/video component that is ' +
            'never unmounted, or an Animated value subscription that survives its component.',
      data: {
        metric: key,
        startMB: round(stat.min, 1),
        endMB: round(stat.max, 1),
        slopeMbPerMin: round(stat.slopePerMin, 2),
        fit: round(stat.fit, 2),
      },
    });
  }

  /* ---------------------------------------------------------------- CPU */

  const cpu = m['cpuPercent'];
  if (cpu && cpu.p95 >= thresholds.cpuPercent) {
    const jsThreadHeavy = samples.some((s) => (s.threadCpu?.['JS'] ?? 0) > 70);
    out.push({
      kind: 'high-cpu',
      severity: cpu.p95 >= 150 ? 'high' : 'medium',
      title: 'Sustained high CPU',
      subject: jsThreadHeavy ? 'JS thread' : undefined,
      evidence:
        `CPU p95 ${round(cpu.p95, 1)}% of one core (mean ${round(cpu.mean, 1)}%)` +
        (jsThreadHeavy ? ', with the JS thread above 70% at times.' : '.'),
      suggestion: jsThreadHeavy
        ? 'The JS thread is the bottleneck. Profile with the Hermes sampling profiler ' +
          '(`Perf Monitor` → `Record JS sampled profile`) and look for a hot render path or a polling timer.'
        : 'Check for a timer or animation that never settles, and for a `setInterval` left running after ' +
          'navigation. On Android, confirm you are measuring a release-ish build — dev bundles run much hotter.',
      data: { p95: round(cpu.p95, 1), mean: round(cpu.mean, 1) },
    });
  }

  /* ------------------------------------------------------------ startup */

  const tti = events.filter((e): e is Extract<PerfEvent, { type: 'tti' }> => e.type === 'tti');
  const worstTti = tti.sort((a, b) => b.durationMs - a.durationMs)[0];
  if (worstTti && worstTti.durationMs > thresholds.ttiMs) {
    out.push({
      kind: 'slow-startup',
      severity: worstTti.durationMs > thresholds.ttiMs * 2 ? 'high' : 'medium',
      title: 'Slow time to interactive',
      subject: worstTti.screen,
      evidence: `TTI ${round(worstTti.durationMs)}ms${worstTti.screen ? ` on ${worstTti.screen}` : ''}.`,
      suggestion:
        'Defer work that does not block first paint: lazy-require heavy modules at the point of use rather ' +
        'than at module scope, move analytics/SDK init behind `InteractionManager`, and check for a blocking ' +
        'network call before first render. `npx react-native-bundle-visualizer` will show which modules are ' +
        'pulled into the initial bundle.',
      data: { ttiMs: round(worstTti.durationMs) },
    });
  }

  /* -------------------------------------------------------- re-renders */

  const components = aggregateRenders(samples);
  const counts = components.map((c) => c.count).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)]! : 0;

  for (const comp of components) {
    // Findings must point at code the reader owns.
    if (!isAppComponent(comp.name)) continue;
    const perSecond = comp.count / durationSec;
    const avgMs = comp.count ? comp.totalMs / comp.count : 0;

    if (perSecond >= thresholds.rendersPerSecond) {
      const looksLikeListRow = median > 0 && comp.count > median * 8 && avgMs < 2;
      out.push({
        kind: looksLikeListRow ? 'large-list-unvirtualised' : 'render-storm',
        severity: perSecond >= thresholds.rendersPerSecond * 3 ? 'high' : 'medium',
        title: looksLikeListRow
          ? `${comp.name} renders like an unwindowed list row`
          : `${comp.name} re-renders constantly`,
        subject: comp.name,
        evidence:
          `${comp.count} renders in ${durationSec.toFixed(0)}s (${round(perSecond, 1)}/s), ` +
          `${round(comp.totalMs)}ms total, ${round(avgMs, 2)}ms average` +
          (comp.wasted ? `, ${comp.wasted} with unchanged props.` : '.'),
        suggestion: looksLikeListRow
          ? `${comp.name} is rendering far more often than anything else while staying individually cheap, ` +
            'which is what a long un-virtualised list looks like. Replace `.map()` over the data (or a plain ' +
            '`ScrollView`) with `FlashList`, and give it a stable `keyExtractor`. If it is already a ' +
            '`FlatList`, set `windowSize`, `maxToRenderPerBatch` and `removeClippedSubviews`.'
          : `Wrap ${comp.name} in \`React.memo\` and stabilise what the parent passes it: inline arrow props ` +
            '(`onPress={() => …}`) and object/array literals create a new identity every parent render, which ' +
            'defeats memoisation. Use `useCallback`/`useMemo` for those, and select narrowly from context or ' +
            'the store rather than consuming a whole object.',
        data: {
          component: comp.name,
          renders: comp.count,
          rendersPerSecond: round(perSecond, 1),
          totalMs: round(comp.totalMs),
          avgMs: round(avgMs, 2),
          ...(comp.wasted ? { wastedRenders: comp.wasted } : {}),
        },
      });
    } else if (avgMs >= thresholds.renderMsAvg && comp.count >= 3) {
      out.push({
        kind: 'expensive-render',
        severity: avgMs >= thresholds.renderMsAvg * 3 ? 'high' : 'medium',
        title: `${comp.name} is slow to render`,
        subject: comp.name,
        evidence: `${round(avgMs, 2)}ms average render, worst ${round(comp.maxMs, 2)}ms, over ${comp.count} renders.`,
        suggestion:
          `A single ${comp.name} render costs more than a frame. Move derived values into \`useMemo\`, split ` +
          'the component so state changes re-render only the part that needs it, and check for expensive work ' +
          'in the render body (sorting, date formatting, regex, `JSON.parse`). If it renders a long subtree, ' +
          'memoise the children.',
        data: { component: comp.name, avgMs: round(avgMs, 2), maxMs: round(comp.maxMs, 2), renders: comp.count },
      });
    }
  }

  /* ------------------------------------------------------------- bridge */

  const bridge = m['bridgeCalls'];
  if (bridge && bridge.p50 >= thresholds.bridgeCallsPerSecond) {
    out.push({
      kind: 'bridge-chatter',
      severity: 'medium',
      title: 'High native bridge traffic',
      evidence: `${round(bridge.p50)} native calls/s (peak ${round(bridge.max)}).`,
      suggestion:
        'Chatty bridge traffic serialises on every call. Batch native calls, avoid per-frame ' +
        '`measure()`/`setNativeProps`, and move gesture-driven animation into Reanimated worklets so it ' +
        'never crosses the bridge.',
      data: { callsPerSecond: round(bridge.p50), peak: round(bridge.max) },
    });
  }

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title),
  );
}

const LABEL: Record<string, string> = {
  rssMB: 'Resident memory',
  pssMB: 'Proportional memory',
  jsHeapMB: 'JS heap',
  javaHeapMB: 'Java heap',
  nativeHeapMB: 'Native heap',
};

/** Which screen was active while a metric was at its worst. */
function worstScreen(
  summary: SessionSummary,
  samples: Sample[],
  key: 'jsFps' | 'jsStallMaxMs' | 'jankPercent',
  direction: 'low' | 'high',
): string | undefined {
  if (summary.screens.length === 0) return undefined;
  let bestScreen: string | undefined;
  let bestValue = direction === 'low' ? Infinity : -Infinity;

  for (const span of summary.screens) {
    const within = samples.filter(
      (s) => s.dt >= span.enteredAt && s.dt <= span.enteredAt + span.durationMs,
    );
    const values = within.map((s) => s[key]).filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const agg = direction === 'low' ? Math.min(...values) : Math.max(...values);
    if (direction === 'low' ? agg < bestValue : agg > bestValue) {
      bestValue = agg;
      bestScreen = span.name;
    }
  }
  return bestScreen;
}
