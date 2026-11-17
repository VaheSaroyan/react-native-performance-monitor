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

Three pieces, each one line. Take the ones you need — none of them requires a checkout.

| | Install | What it gives you |
|---|---|---|
| **Desktop app** | [Download the DMG](https://github.com/VaheSaroyan/react-native-performance-monitor/releases/latest) | Devices, recordings, charts, ranked findings |
| **MCP server** | `claude mcp add rnperf -- npx -y @rnperf/mcp-server` | The same analysis, to a coding agent |
| **In-app SDK** | `npm install @rnperf/sdk` | Attribution: which component, which screen, which file |

The DMG is signed and notarised, so it opens on a double-click. The MCP server needs Node 20.11
and nothing else — the daemon and every dependency are bundled into the published package.
Measuring Android needs `adb`; iOS needs Xcode's command line tools.

## Use it

### Desktop app

Open it from Applications. Pick a device in the sidebar, choose the app, press **Start
recording**, exercise the screen you care about, then stop. The Findings tab ranks what it found.

### From source

Only needed to change the monitor itself; everything above is already built.

```bash
git clone https://github.com/VaheSaroyan/react-native-performance-monitor.git
cd react-native-performance-monitor
npm install && npm run build
npm run desktop
```

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
claude mcp add rnperf -- npx -y @rnperf/mcp-server
claude mcp list     # rnperf: ... ✓ Connected
```

Run that from the React Native project you want profiled: the registration is stored per
directory, and the agent's working directory is what component names resolve against.
`--scope project` writes it to that repo's `.mcp.json` instead, for the whole team.

For a client that takes a config file rather than a command:

```json
{ "mcpServers": { "rnperf": { "command": "npx", "args": ["-y", "@rnperf/mcp-server"] } } }
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
(`source=Unnotarized Developer ID`). Notarising is what turns the handover into "double-click it"
instead of "first, open a terminal". Three credentials, all from the account that issued the
certificate:

```bash
export CSC_NAME="Your Name (TEAMID)"
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID=TEAMID                              # the brackets after your certificate's name
npm -w @rnperf/desktop run package:notarized
```

`package:notarized` passes `-c.mac.notarize=true`, the same flag CI passes, so a hand-cut build and
a tagged one produce the same artifact. The plain `package` script leaves it off, because enabling
it without credentials fails the build rather than skipping quietly. electron-builder uploads,
waits for Apple — several minutes, no output — and **staples** the ticket to the `.app`, which is
what lets it open on a machine that is offline.

electron-builder stops there: it notarises the app and then builds the DMG *around* it, so the disk
image people actually download would come out unsigned and unstapled. The `afterAllArtifactBuild`
hook in `apps/desktop/build/notarize-dmg.cjs` signs, submits and staples the DMG as well, and skips
itself when no credentials are present.

Verify before sending, on the DMG rather than the app inside it:

```bash
xcrun stapler validate "apps/desktop/release/RN-Performance-Monitor-0.1.0-arm64.dmg"
spctl -a -vvv -t install "apps/desktop/release/RN-Performance-Monitor-0.1.0-arm64.dmg"
```

`source=Notarized Developer ID` means anyone can open it. The build machine itself can't tell you
— it opens either way — so test on another Mac, or fake the flag with
`xattr -w com.apple.quarantine "0081;00000000;Safari;" <dmg>`.

Until a build is notarised, a recipient can clear the quarantine flag themselves:

```bash
xattr -dr com.apple.quarantine "/Applications/RN Performance Monitor.app"
```

### The MCP server

It is on npm, so there is nothing to send:

```bash
claude mcp add rnperf -- npx -y @rnperf/mcp-server
```

The published package is the esbuild bundle — the daemon and every dependency inlined into one
~1MB file, no dependency tree, Node the only requirement. The same bundle is attached to every
release as `rnperf-mcp.mjs`, and `npm -w @rnperf/mcp-server run bundle` rebuilds it from a
checkout, for a machine that cannot reach the registry or to try an unreleased change.

It starts its own daemon when the desktop app is not running, so the agent workflow works on its
own. No signing or notarisation applies — a `.mjs` file run by Node is not a macOS application,
and neither is an npm package. The DMG is the only artifact that needs notarising.

### The SDK

This one goes into another codebase, so it has to resolve on every machine that installs that
project — including CI. It is on npm, so that is one line:

```bash
npm install @rnperf/sdk
```

A local path resolves only on the machine that wrote it, and **npm cannot install a subdirectory
of a git repository** — a plain git dependency pointing at this monorepo installs the repo root,
not the SDK. To put an unreleased change in front of CI, `npm pack -w @rnperf/sdk` and commit or
host the tarball. The package has a `prepare` script, so it also builds itself if it is ever
installed straight from a git URL.

## Adding the SDK to your app

```bash
npm install @rnperf/sdk
cd ios && pod install      # picks up the RNPerfSDK native module
```

To try a change to the SDK before it is released, install the tarball or the path instead — both
carry the same native code:

```bash
npm pack -w @rnperf/sdk                 # → rnperf-sdk-0.1.0.tgz
npm install /path/to/rnperf-sdk-0.1.0.tgz

# Or straight from a path, for a repo you control
npm install file:/path/to/react-native-performance-monitor/packages/rn-sdk
```

```ts
// index.js — before registering the root component
import { startPerfMonitor } from '@rnperf/sdk';

startPerfMonitor();   // host is derived from the Metro bundle URL
```

It is a **no-op in release builds** unless you pass `enableInRelease: true` — see
[Profiling a release build](#profiling-a-release-build).

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

### Profiling a release build

A dev bundle runs hot enough that its numbers are their own story. To measure what you actually
ship, on a device you are holding:

```ts
startPerfMonitor({ enableInRelease: true, host: '192.168.1.5' });
```

`host` is **not optional here.** Auto-discovery reads Metro's address out of the bundle URL, and a
release bundle loads from `assets://` or `file://` — there is no address in it. Pass your Mac's LAN
address; the daemon already listens on every interface.

| Metric | In a release build |
|---|---|
| UI-thread frames, jank, refresh rate | Identical — `CADisplayLink` and `Choreographer` are not gated on build type |
| JS fps, stalls, JS heap, bridge calls | Work, and are the numbers worth quoting |
| Memory footprint, screens, TTI, marks, crashes | Work |
| **Component renders** | **Absent** |
| Host-side CPU | Needs a cable and a development- or ad-hoc-signed build |

Renders go for two independent reasons: React's commit hook, `__REACT_DEVTOOLS_GLOBAL_HOOK__`, is
not installed in a release bundle, and React ships its production renderer, which records no
timings to read even if it were. So `render-storm`, `expensive-render` and
`large-list-unvirtualised` all disappear — on a typical session, most of the findings, and exactly
the ones that name a file and line. Frame, stall and memory findings remain, and they are the ones
a user would have felt. Profile in dev to locate a cause; re-record in release to confirm the fix
on the build you ship.

This is a release-*configuration* build on your own device, not field monitoring. A TestFlight or
App Store build on someone else's phone cannot reach a daemon on your desk, and there is no hosted
collector behind any of this. The SDK logs a missing host even in release, where it is otherwise
silent — look for `[rnperf]` in the device log — and the session records `runtime.dev: false`, so a
recording made this way is labelled for what it is.

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
- **Render tracking needs a dev build** — React only records timings in its profiling build, and a
  release bundle installs no commit hook for it to report through. Frames, stalls and memory are
  unaffected.
- **A release build cannot find the daemon by itself** — an embedded bundle has no Metro URL, so
  `host` must be passed explicitly.
- Dev bundles run much hotter than release. Compare like for like; to measure the real thing, see
  [Profiling a release build](#profiling-a-release-build).
- **It profiles devices you hold, not users in the field.** Everything reports to a daemon on your
  machine over the LAN.

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
| `NPM_TOKEN` | The release still carries the SDK tarball and the MCP bundle, but neither package is published to npm. Must be an npm **automation** token — any other kind is gated behind 2FA and stops on `EOTP` |

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
