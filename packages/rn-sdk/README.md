# @rnperf/sdk

In-app performance probe for React Native. Streams JS-thread metrics to the
[rnperf](../../README.md) daemon, which analyses them and exposes the results over MCP.

```bash
npm install @rnperf/sdk
cd ios && pod install        # iOS; Android autolinks on the next build
```

```ts
// index.js, before AppRegistry.registerComponent
import { startPerfMonitor } from '@rnperf/sdk';

startPerfMonitor();
```

No-op in release builds unless `enableInRelease: true`. Everything it does is wrapped in
try/catch — if the daemon is not running, or an internal React API has moved, the app
behaves exactly as if the SDK were not installed.

## What it reports

- **UI FPS and jank** — real frame cadence from the UI thread, measured in-process on both platforms.
- **JS FPS** — animation frames the JS thread actually serviced.
- **JS stalls** — how late a fixed-period timer fires, i.e. the longest synchronous block.
- **JS heap** — Hermes allocator stats, or `performance.memory` elsewhere.
- **Component renders** — count, self-time and *wasted* renders (props unchanged from the
  previous commit), read from React's own commit data.
- **Bridge calls** — legacy bridge traffic, via MessageQueue's spy hook.
- **Memory** — physical footprint on iOS; Java and native heap on Android.
- **TTI, screens, marks, measures, crashes.**

## UI-thread frames

The package ships a small native module, `RNPerfFrameMonitor`, on both platforms:

| | Mechanism | Also reports |
|---|---|---|
| **iOS** | `CADisplayLink` on the main run loop, in `NSRunLoopCommonModes` | physical footprint |
| **Android** | `Choreographer` frame callback, reposted each frame | Java heap, native heap |

Autolinking finds it. On iOS run `pod install`; on Android just rebuild.

**Why it exists.** On iOS this is the only way to get the number at all — a simulator exposes no
Core Animation frame stats and a physical device needs an Instruments GUI trace. On Android the
daemon already reads richer per-frame data over `adb`, so the module is for the case `adb`
cannot reach: a device on Wi-Fi, a tester's phone, or CI where only the app reports back.
**When both are available the device-side values win**, since `dumpsys` sees the whole render
pipeline and the app can only see its own main thread.

Both implementations work the same way:

- **Frames accumulate natively and JavaScript drains them once per interval.** A bridge event per
  frame would itself cause the jank this is measuring.
- **Jank is judged against the display's real budget** — 8.3ms on ProMotion, 11.1ms on a 90Hz
  panel — read from `UIScreen.maximumFramesPerSecond` and `Display.getRefreshRate()`. The rate is
  reported alongside as `uiRefreshHz`.
- **A frame counts as dropped when the interval exceeds 1.5x the budget**, so ordinary vsync
  jitter is not reported as jank.
- **Measurement pauses in the background**, so a backgrounded app does not report a multi-second
  stall that never happened.
- **The buffer is capped at 600 intervals.** If JavaScript is blocked longer than that it is not
  draining anyway; frames past the cap still count towards FPS so a stalled app does not look idle.

Caveats:

- **Expo Go cannot load it.** Run `npx expo prebuild` and use a development build; everything else
  in the SDK still works in Expo Go.
- **iOS and Android `jankPercent` are not comparable to `adb gfxinfo`'s.** Both modules count
  refreshes actually missed; `gfxinfo` counts frames whose total latency exceeded budget. Compare
  `uiFps` across platforms instead.
- **Android reports Java and native heap, not PSS.** `Debug.getMemoryInfo()` takes well over a
  frame to return and would cause the jank the module exists to measure; the daemon reads PSS over
  `adb` instead.
- **Reposting a frame callback keeps requesting vsync**, which costs a little power — the same
  approach React Native's own FPS monitor uses, and only while the monitor is running.

Turn it off with `startPerfMonitor({ trackUiFrames: false })`.

## Options

```ts
startPerfMonitor({
  host: 'auto',          // 'auto' derives it from the Metro bundle URL
  port: 8139,
  intervalMs: 1000,
  trackRenders: true,
  trackBridge: true,
  trackUiFrames: true,   // native frame module; no-op where it is absent
  enableInRelease: false,
  bundleId: 'com.example.app',
  onStatus: (s) => console.log('[rnperf]', s),
});
```

## API

| Export | Purpose |
|---|---|
| `startPerfMonitor(options?)` | Begin reporting |
| `stopPerfMonitor()` | Stop and disconnect |
| `setScreen(name)` | Attribute following metrics to a screen |
| `createNavigationTracker(getRouteName)` | Drop-in for React Navigation's `onStateChange` |
| `mark(name)` / `measure(name, startMark?)` | Custom timings |
| `reportTTI(screen?, durationMs?)` | Time to interactive |
| `trackInteraction(name, durationMs)` | Custom interaction timing |
| `isPerfMonitorConnected()` | Connection state, for a debug overlay |

## Troubleshooting

**iOS build fails in `fmt` with "call to consteval function ... is not a constant expression".**
This is a React Native issue, not this package: RN 0.81 pins fmt 11.0.2, whose consteval
format-string checks Xcode 27's clang rejects. It happens with or without this SDK installed.
Force fmt's detection to the no-consteval branch from your Podfile:

```ruby
post_install do |installer|
  react_native_post_install(installer, config[:reactNativePath], :mac_catalyst_enabled => false)

  fmt_base = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
  if File.exist?(fmt_base)
    text = File.read(fmt_base)
    patched = text.gsub('#  define FMT_USE_CONSTEVAL 1', '#  define FMT_USE_CONSTEVAL 0')
    File.write(fmt_base, patched) if patched != text
  end
end
```

**Nothing connects from a physical iPhone.** Two things iOS requires that a simulator does not:

1. **Local network permission.** Reaching a daemon on your Mac's LAN address counts as local
   network access. Add to `ios/<App>/Info.plist`, or iOS denies it silently with no prompt:

   ```xml
   <key>NSLocalNetworkUsageDescription</key>
   <string>Connects to the rnperf daemon on your development machine to report performance metrics.</string>
   ```

   The first connection then prompts; tap **Allow**. If you declined once, re-enable it under
   Settings → Privacy & Security → Local Network.

2. **An explicit host.** A device cannot reach `localhost`, and with an embedded bundle there is no
   Metro URL to infer from, so pass your Mac's LAN address:
   `startPerfMonitor({ host: '192.168.1.21' })`.

**The app crashes instantly on iOS 26 or newer**, in
`__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Not this SDK: iOS 26 traps apps
that never adopt the UIScene lifecycle, and the React Native 0.81 template still creates its window
in `didFinishLaunchingWithOptions`. Move that into a `UIWindowSceneDelegate` and declare it in
`UIApplicationSceneManifest`.

**`nativeModule=MISSING` on iOS.** Run `cd ios && pod install` and rebuild; autolinking only
picks the pod up at install time.

**`nativeModule=MISSING` on Android.** Check `npx react-native config` reports a non-null
`dependencies['@rnperf/sdk'].platforms.android`, then rebuild.

## Caveats

- Render tracking requires a **development build**: React only populates timing data in its
  profiling build.
- Under the new architecture most native calls are synchronous JSI and never cross the
  bridge, so `bridgeCalls` reads zero there — that means "nothing on the bridge", not
  "nothing happening".
- UI-thread frame data needs the native module and therefore a rebuild (plus `pod install` on
  iOS). Without it the SDK still reports everything JS-side; `uiFps` is simply absent.
- The Android module requires React Native 0.71 or newer, where the `react-android` Maven
  artifact is published. The JavaScript half works from 0.70.
- `startPerfMonitor()` must run **after** React is imported, so it can attach to React's
  commit hook.
