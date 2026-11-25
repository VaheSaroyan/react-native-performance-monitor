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
  // The app reports the rate it was actually driven at, which an adaptive
  // display changes during a run; the commonest reading is the one most frames
  // were judged against.
  const refreshHz = commonest(samples, 'uiRefreshHz');
  const displayMaxHz = commonest(samples, 'uiDisplayMaxHz');
  const heldBelowDisplay =
    !!refreshHz && !!displayMaxHz && Math.round(displayMaxHz) > Math.round(refreshHz);
  const displayMs = refreshHz && refreshHz > 20 ? 1000 / refreshHz : thresholds.frameBudgetMs;
  /*
   * A panel's refresh rate is not the rate the app is allowed to reach. iOS
   * holds an app to 60fps on a ProMotion display unless it opts out, and the
   * frame counter divides missed refreshes by every refresh the panel offered
   * — so an app that never drops a frame still reports 50% jank there.
   *
   * The typical frame says what rate the app is really keeping: how many
   * display refreshes it spans is the cadence, 1 at the panel's own rate and
   * 2 for 60fps on a 120Hz screen. Hold the app to that, because a steady
   * cadence is what a person reads as smooth.
   */
  const cadence = (() => {
    const typical = m['frameP50Ms']?.p50;
    return typical && typical > 0 ? Math.max(1, Math.round(typical / displayMs)) : 1;
  })();
  const frameBudgetMs = displayMs * cadence;
  const effectiveHz = 1000 / frameBudgetMs;
  const rate = `${Math.round(effectiveHz)}fps`;
  const onDisplay = refreshHz ? ` on a ${Math.round(refreshHz)}Hz display` : '';
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
        `A stall over ${Math.round(frameBudgetMs)}ms drops at least one frame at this app's ${rate} cadence` +
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
  const p99 = m['frameP99Ms'];

  /*
   * The cadence is only worth crediting when the app is actually keeping it.
   * A tight distribution — a 95th-percentile frame barely longer than the
   * typical one — is an app pacing itself. A wide one means the typical frame
   * says nothing about the rest, and rounding it to a whole number of
   * refreshes would invent a cadence out of noise.
   *
   * It also has to be a cadence something could plausibly be pacing to: a
   * real reported refresh rate, and a small multiple of it. A frame that
   * spans 297 refreshes is not a 0.2fps cadence, it is a broken recording.
   */
  const cadenceHolds =
    cadence > 1 && cadence <= 4 && !!refreshHz && !!p95 && p95.p50 <= frameBudgetMs * 1.25;
  const budgetMs = cadenceHolds ? frameBudgetMs : displayMs;

  /*
   * Where the cadence holds, re-express the reported figure as a share of the
   * frames the app could have drawn at it. Each good frame is expected to skip
   * (cadence - 1) refreshes, so scaling by the cadence and subtracting those
   * inverts the native counter exactly: a steady 60fps on a 120Hz panel lands
   * on zero. Where it does not hold, the raw figure stands.
   */
  const jankPct = jank
    ? cadenceHolds
      ? Math.max(0, cadence * jank.p50 - (cadence - 1) * 100)
      : jank.p50
    : undefined;

  const frameTimes = p95
    ? ` Frame time p95 ${round(p95.p50)}ms, p99 ${round(p99?.p50 ?? 0)}ms.`
    : '';
  const against = cadenceHolds
    ? `the ${round(budgetMs)}ms this app normally takes — its own ${rate} cadence${onDisplay}`
    : `the ${round(budgetMs)}ms budget${onDisplay}`;

  const numbers = {
    jankPercent: round(jankPct ?? 0, 1),
    frameP95Ms: p95 ? round(p95.p50) : 0,
    frameBudgetMs: round(budgetMs),
    effectiveHz: Math.round(effectiveHz),
    ...(cadenceHolds && jank ? { reportedJankPercent: round(jank.p50, 1) } : {}),
    ...(refreshHz ? { refreshHz: Math.round(refreshHz) } : {}),
  };

  const belowDisplayRateAdvice = summary.meta.device.platform === 'ios'
    ? 'iOS caps an app at 60fps on a ProMotion iPhone unless it opts out. Set ' +
      '`CADisableMinimumFrameDurationOnPhone` to `true` in `Info.plist` — under ' +
      '`ios.infoPlist` in `app.config.ts` or `app.json` on Expo, since a prebuild overwrites ' +
      'the file. iPad Pro needs no key. The app has to be rebuilt and reinstalled for it to ' +
      'take effect, and a simulator always reports 60Hz, so only a physical device can confirm ' +
      'it. Move animations to the native driver or Reanimated first: at 120Hz the budget ' +
      'halves to 8.3ms, so anything already near the limit will start dropping frames.'
    : 'The system chose this rate. An app can ask for a higher one with `Surface.setFrameRate` ' +
      'or `preferredDisplayModeId`, but check animations are off the JS thread first — the ' +
      'budget shrinks in proportion.';

  const UI_FIX =
    'Frames are being dropped on the native UI thread, which JS-side fixes will not help. ' +
    'Look for deep view hierarchies, overlapping translucent views, large uncached images ' +
    '(size them to their display dimensions), shadows on Android (`elevation` is cheaper), and ' +
    '`overflow: hidden` with border radius on scrolling content.';

  // 58 rather than 60: a display reports 60.000003Hz and frames jitter either
  // side of the budget, so an app holding 60fps measures a shade under it.
  const SMOOTH_HZ = 58;

  if (jankPct !== undefined && jankPct >= thresholds.jankPercent) {
    out.push({
      kind: 'ui-jank',
      severity: jankPct >= thresholds.jankPercent * 3 ? 'critical' : 'high',
      title: 'UI thread is missing its frame budget',
      subject: worstScreen(summary, samples, 'jankPercent', 'high'),
      evidence: `${round(jankPct, 1)}% of frames missed ${against}.${frameTimes}`,
      suggestion: UI_FIX,
      data: numbers,
    });
  } else if (cadenceHolds && effectiveHz < SMOOTH_HZ) {
    /*
     * Steady, and that is the problem: the app is pacing itself to a slow
     * cadence and hitting it every time. Nothing in the jank figure can show
     * this, because by its own measure the app is not dropping anything.
     */
    out.push({
      kind: 'ui-jank',
      severity: effectiveHz < 30 ? 'critical' : 'high',
      title: `UI thread is locked to ${rate}`,
      subject: worstScreen(summary, samples, 'jankPercent', 'high'),
      evidence:
        `Every frame takes ${round(budgetMs)}ms — a steady ${rate}${onDisplay}, held so ` +
        `consistently that the dropped-frame count stays near zero. Motion at this rate reads ` +
        `as choppy however even it is.${frameTimes}`,
      suggestion: UI_FIX,
      data: numbers,
    });
  } else if (cadenceHolds && refreshHz) {
    /*
     * Smooth, then — just not as smooth as the hardware allows. Worth one
     * quiet line, since the raw counter calls this 50% jank and a reader who
     * saw that number deserves to know where it went.
     */
    out.push({
      kind: 'ui-below-display-rate',
      severity: 'low',
      title: `Rendering at ${rate} on a ${Math.round(refreshHz)}Hz display`,
      evidence:
        `Typical frame ${round(budgetMs)}ms — one for every ${cadence} refreshes the display ` +
        `offers, and ${round(jankPct ?? 0, 1)}% of them miss it. The app is steady, just not fast. ` +
        `The device itself reports ${round(jank?.p50 ?? 0, 1)}% jank, because it counts against ` +
        `the panel's ${round(displayMs)}ms rather than the app's.${frameTimes}`,
      suggestion: belowDisplayRateAdvice,
      data: numbers,
    });
  } else if (heldBelowDisplay && refreshHz && displayMaxHz) {
    out.push({
      kind: 'ui-below-display-rate',
      severity: 'low',
      title: `Display driven at ${Math.round(refreshHz)}Hz of a possible ${Math.round(displayMaxHz)}Hz`,
      evidence:
        `The system gave this app ${round(displayMs)}ms per frame for most of the recording, although ` +
        `the display can refresh every ${round(1000 / displayMaxHz)}ms. Frames were judged against the ` +
        `time they were given, so this is a ceiling the app is held to, not frames it dropped.${frameTimes}`,
      suggestion: belowDisplayRateAdvice,
      data: { ...numbers, displayMaxHz: Math.round(displayMaxHz) },
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

/** The value a metric took most often across the samples that reported it. */
function commonest(samples: Sample[], key: 'uiRefreshHz' | 'uiDisplayMaxHz'): number | undefined {
  const counts = new Map<number, number>();
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value === 'number') counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}
