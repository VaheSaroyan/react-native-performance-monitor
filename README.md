# React Native Performance Monitor

A macOS app that measures a React Native app on a real device, simulator or emulator,
turns the numbers into ranked findings with concrete fixes, and exposes all of it
over **MCP** so Claude Code (or any coding agent) can read the analysis and apply the fixes.

```
┌──────────────┐   ws/http    ┌─────────────────┐   stdio/MCP   ┌─────────────┐
│ Desktop app  │◄────────────►│                 │◄─────────────►│ Claude Code │
│ (Electron)   │              │  rnperf daemon  │               │   / agent   │
└──────────────┘              │                 │               └─────────────┘
                              │  collectors +   │
┌──────────────┐   ws ingest  │  analysis       │     adb       ┌─────────────┐
│ @rnperf/sdk  │─────────────►│                 │◄─────────────►│  devices    │
│ (in the app) │              └─────────────────┘  simctl/ps    │             │
└──────────────┘                                   devicectl    └─────────────┘
```

## What it measures

| Source | Metrics | Needs |
|---|---|---|
| **Android** (`adb`) | CPU (incl. per-thread: JS, native modules, render), PSS/RSS, Java heap, native heap, graphics memory, real per-frame timings (p50/p95/p99, jank %), logcat | nothing in the app |
| **iOS simulator** | CPU, resident memory, os_log stream | nothing in the app |
| **iOS device** (`devicectl` + `xctrace`) | CPU, physical footprint | Xcode, paired device |
| **In-app SDK** (`@rnperf/sdk`) | JS FPS, JS event-loop stalls, JS heap (Hermes), bridge traffic, **per-component render counts, render cost and wasted renders**, TTI, screens, crashes | one import |
| **Native frame module** (ships with the SDK) | **UI-thread FPS, frame intervals p50/p95/p99, jank % at the display's real refresh rate**; physical footprint (iOS), Java + native heap (Android) | a rebuild |

The two halves merge into a single timeline, so a memory climb from `adb` sits on the
same chart as the component that was re-rendering while it happened.

**Documentation:** <https://vahesaroyan.github.io/react-native-performance-monitor/>
· **Download:** [latest release](https://github.com/VaheSaroyan/react-native-performance-monitor/releases/latest)

## Install

```bash
npm install
npm run build
```

## Use it

### Desktop app

```bash
npm run desktop
```

Pick a device in the sidebar, choose the app, press **Start recording**, exercise the
screen you care about, then stop. The Findings tab ranks what it found.

### Build a release

```bash
npm run build                       # all packages
npm -w @rnperf/desktop run package  # → apps/desktop/release/*.dmg
```

The main process is bundled with esbuild before packaging, so the daemon and its dependencies
end up inside the app and nothing is resolved at runtime — npm workspaces hoist those packages
to the repo root as symlinks, which electron-builder cannot follow into an app bundle.

electron-builder signs with whatever Developer ID it finds in the keychain, so a build on a machine
that has one is signed; set `CSC_IDENTITY_AUTO_DISCOVERY=false` for a deliberately unsigned build.
Notarisation is off (`notarize: false` in `build.mac`) and has to be turned on explicitly — see
[Giving it to other developers](#giving-it-to-other-developers), or let CI do it.

Use `npm -w @rnperf/desktop run package:dir` for an unpacked `.app` while iterating — it skips
building the DMG.

### Terminal

```bash
node packages/daemon/dist/cli.js devices
node packages/daemon/dist/cli.js record emulator-5554 --app com.example.app --seconds 30
```

### From Claude Code

```bash
claude mcp add rnperf -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

Then just ask:

> Profile the checkout screen on the emulator and fix whatever is making it janky.

Claude will call `list_devices` → `start_session` → (you drive the app) → `stop_session`,
read the findings, open the files they point at, and make the edits. Ask it to verify and
it will record a second session and call `diff_sessions`.

The MCP server starts its own daemon if the desktop app is not running, so it works standalone.

## Giving it to other developers

Three separate artifacts, with three different answers.

### The desktop app

```bash
export CSC_NAME="Your Name (TEAMID)"     # the common name only, no "Developer ID Application:" prefix
npm -w @rnperf/desktop run package
```

The app is signed with a Developer ID and the hardened runtime, with entitlements in
`apps/desktop/build/entitlements.mac.plist` — Electron's JIT needs `allow-jit` and
`allow-unsigned-executable-memory`, and the daemon shells out to `adb` and `xcrun`, which needs
`disable-library-validation`.

Signing alone is not enough for another Mac: Gatekeeper rejects a signed-but-unnotarised app
(`source=Unnotarized Developer ID`). To notarise, set `notarize: true` in `build.mac` and supply
credentials:

```bash
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID=TEAMID
npm -w @rnperf/desktop run package
```

Until then, a recipient can clear the quarantine flag themselves:

```bash
xattr -dr com.apple.quarantine "/Applications/RN Performance Monitor.app"
```

### The MCP server

```bash
npm -w @rnperf/mcp-server run bundle     # → packages/mcp-server/bundle/rnperf-mcp.mjs
```

That is a single self-contained file — the daemon and every dependency are inside it. Send it to
a teammate and they need nothing but Node:

```bash
claude mcp add rnperf -- node /path/to/rnperf-mcp.mjs
```

It starts its own daemon when the desktop app is not running, so the agent workflow works on its
own.

### The SDK

This one goes into another codebase, so it has to resolve on every machine that installs that
project — including CI. A local path will not do that. In increasing order of effort:

**npm cannot install a subdirectory of a git repository**, so a plain git dependency pointing at
this monorepo installs the repo root, not the SDK. That leaves three workable routes:

| Approach | Works in CI | Setup |
|---|---|---|
| Commit the tarball into the consuming repo | yes | none, but a binary blob in git |
| Private registry — Azure Artifacts, GitHub Packages, npm org | yes | registry auth on every machine and in CI |
| Split `packages/rn-sdk` into its own repo | yes | a second repo to keep in step |

`npm pack -w @rnperf/sdk` produces the tarball for the first option. The package has a `prepare`
script, so it also builds itself correctly if it is ever installed straight from a git URL.

## Adding the SDK to your app

You do **not** need to publish anything to npm. Pick whichever fits:

```bash
# A tarball — what the package would contain if published
npm pack -w @rnperf/sdk                 # → rnperf-sdk-0.1.0.tgz
npm install /path/to/rnperf-sdk-0.1.0.tgz

# Or straight from a path, for a repo you control
npm install file:/path/to/react-native-performance-monitor/packages/rn-sdk
```

Publish only when other people or CI machines need to install it without the source checkout.
If you do, scope it to your org and mark it private, since this ships native code for both
platforms.


```bash
npm install @rnperf/sdk    # or: npm install /path/to/packages/rn-sdk
cd ios && pod install      # picks up the RNPerfSDK native module
```

```ts
// index.js — before registering the root component
import { startPerfMonitor } from '@rnperf/sdk';

startPerfMonitor();   // host is derived from the Metro bundle URL
```

It is a **no-op in release builds** unless you pass `enableInRelease: true`.

Optional, for better attribution:

```ts
import { setScreen, reportTTI, createNavigationTracker } from '@rnperf/sdk';

// React Navigation
<NavigationContainer onStateChange={createNavigationTracker(() => navigationRef.getCurrentRoute()?.name)}>

// or manually
setScreen('Checkout');
reportTTI('Checkout', Date.now() - startedAt);
```

On a **physical device**, the SDK finds the daemon through Metro's address automatically.
If you are not using Metro, pass it explicitly: `startPerfMonitor({ host: '192.168.1.5' })`.

### UI-thread frames

The SDK ships a native frame module for both platforms — `CADisplayLink` on iOS, `Choreographer`
on Android. Autolinking finds it; iOS needs `pod install`, Android just a rebuild. **Expo Go
cannot load it**, so use a development build (`npx expo prebuild`); the rest of the SDK works in
Expo Go either way.

On iOS this is the only way to get UI FPS at all. On Android it covers the case `adb` cannot
reach — a device on Wi-Fi, a tester's phone, CI — and **device-side values win when a cable is
attached**, since `dumpsys` sees the whole render pipeline.

Frames are counted natively and drained once per reporting interval, because a bridge event per
frame would cause the jank it is meant to measure. Jank is judged against the display's actual
budget — **8.3ms on ProMotion, 11.1ms at 90Hz** — not a hardcoded 16.7ms.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_devices` | Every device and what each can measure |
| `list_apps` / `launch_app` | Find and start the app under test |
| `start_session` / `stop_session` | Record a window of activity |
| `get_findings` | **Ranked problems with evidence, source files and fixes** |
| `get_session_summary` | p50/p95/min/max and per-minute trend for every metric |
| `get_metrics` | Raw samples, for pinpointing a spike |
| `diff_sessions` | Before/after comparison — did the fix work? |
| `get_logs` | Logs, crashes, screen changes, TTI marks |
| `locate_component` | Resolve a component name to file and line |
| `set_project_root` | Point the daemon at your RN project |

## What it looks for

| Finding | Fires when | Points at |
|---|---|---|
| `js-fps-low` | JS FPS p05 below 45 | the worst screen |
| `js-thread-stall` | A synchronous block over 100ms | the worst screen |
| `ui-jank` | Over 10% of frames miss the refresh budget (8.3ms on ProMotion) | — |
| `memory-growth` | A steady climb: >2MB/min, R² > 0.75, >5MB total, over a window of at least 45s | which pool |
| `render-storm` | A component re-rendering >15×/s | the component + file |
| `large-list-unvirtualised` | Many cheap renders of one component | the component + file |
| `expensive-render` | A single render over 8ms on average | the component + file |
| `high-cpu` | CPU p95 above 85% of a core | the JS thread, if it is the cause |
| `slow-startup` | TTI over 2s | the screen |
| `bridge-chatter` | Over 400 bridge calls/s | — |

Memory growth is judged by the **fit** of the trend, not just the slope — a GC sawtooth is not
reported as a leak, a steady climb is. It also needs a window of at least 45 seconds and a rise
of at least 5MB: every app allocates while it warms up, and a ten-second window produces a
textbook straight line that means nothing. The projection in the evidence never extrapolates
further ahead than the recording reaches back.

## Notes and limits

- **Android frame timings** need HWUI profiling, which the daemon enables automatically.
  The property only applies to processes started afterwards, so **restart the app** once to
  get p95/p99 frame times instead of aggregates.
- **iOS UI-thread frames come from the in-app native module**, not from the host — nothing
  outside the app can read them. The module needs a rebuild (and `pod install` on iOS), and will
  not load in Expo Go.
- **`gfxinfo` jank and in-app jank are not the same measure.** Android's `gfxinfo` counts frames
  whose total latency exceeded the budget; both native modules count refreshes actually missed.
  Compare `uiFps` when crossing sources or platforms.
- **The Android native module needs React Native 0.71+**; the JavaScript half works from 0.70.
- **Physical iOS devices** are sampled by `xctrace` in ~10s windows, so device-side CPU and
  memory lag. The SDK is the better source on real hardware — and with the native module it
  reports physical footprint every second, so `xctrace` is only needed for CPU.
- **Simulator memory is host memory** and runs higher than the same build on a device. Use it
  for trends, not absolute budgets.
- **Render tracking needs a dev build** — React only records timings in its profiling build.
- Dev bundles run much hotter than release. Compare like for like.

## Releasing

Three workflows in `.github/workflows/`:

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | pushes and pull requests | Typechecks, builds every package, speaks MCP to the bundled server over stdio, checks the SDK tarball still carries its native modules, and packages an unsigned `.app` on macOS |
| `release.yml` | a `v*` tag, or by hand | Builds, signs, notarises and publishes the DMG, the MCP bundle, the SDK tarball and `SHA256SUMS.txt` to a GitHub Release |
| `docs.yml` | pushes that touch `docs/` | Publishes the documentation site to GitHub Pages |

```bash
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push origin main --tags
```

The release job refuses to run when the tag and `apps/desktop/package.json` disagree —
electron-builder names the DMG from the package version, so a mismatch would ship an asset whose
filename contradicts the release it is attached to. Running the workflow by hand (rather than by
tag) builds everything and publishes nothing, which is how to rehearse it.

Every credential is optional and each missing group degrades one step instead of failing the run:

| Secret | Effect when absent |
|---|---|
| `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD` | The DMG is built unsigned, and the release notes say so |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Signed but not notarised — recipients must clear the quarantine flag |
| `NPM_TOKEN` | `@rnperf/sdk` is attached to the release as a tarball but not published to npm |

The certificate is `base64 -i certificate.p12`, exported from Keychain Access with its private key.
Notarisation, when enabled, is verified with `xcrun stapler validate` before the release is created:
a build Gatekeeper would refuse fails the job rather than being published.

## Layout

```
packages/protocol      shared wire types
packages/daemon        collectors, session engine, analysis, HTTP/WS API, CLI
packages/rn-sdk        @rnperf/sdk — the in-app probe (incl. ios/ + android/ native modules)
packages/mcp-server    MCP bridge for Claude Code
apps/desktop           Electron + React UI
```

Sessions are stored as JSONL under `~/.rnperf/sessions/<id>/`.
