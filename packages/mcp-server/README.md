# @rnperf/mcp-server

MCP server for [rnperf](https://vahesaroyan.github.io/react-native-performance-monitor/), a
React Native performance monitor. It gives a coding agent the devices, the recordings, the
metrics and — the point of the thing — **ranked findings that name a component, a file and a
line**, so the agent can open the file and fix the cause rather than guess at it.

```bash
claude mcp add rnperf -- npx -y @rnperf/mcp-server
```

Then ask for what you want:

> Profile the checkout screen on the emulator and fix whatever is making it janky.

Claude calls `list_devices`, then `start_session`, waits while you drive the app, calls
`stop_session`, reads the findings, opens the files they point at and makes the edits. Ask it
to verify and it records a second session and calls `diff_sessions`.

Run it from the React Native project you want profiled, not from somewhere else: the
registration is stored per directory, and the agent's working directory is what component names
resolve against. `--scope project` writes it to that repo's `.mcp.json` for the whole team.

## What you need

**Node 20.11 or newer, and nothing else.** The daemon and every dependency are bundled into the
published file, so an install pulls one ~1MB artifact and no dependency tree. The server starts
its own daemon when the desktop app is not running, so the agent workflow stands alone — though
measuring iOS needs Xcode's command line tools, and Android needs `adb`.

## Tools

| Tool | Purpose |
|---|---|
| `list_devices` | Every device, and what each one can measure |
| `list_apps` / `launch_app` | Find and start the app under test |
| `start_session` / `stop_session` | Record a window of activity |
| `get_findings` | **Ranked problems with evidence, source files and fixes** |
| `get_session_summary` | p50, p95, min, max and a per-minute trend for every metric |
| `get_metrics` | Raw samples, for pinpointing one spike |
| `diff_sessions` | Before and after — did the fix work? |
| `get_logs` | Logs, crashes, screen changes, TTI marks |
| `locate_component` | Resolve a component name to a file and line |
| `set_project_root` | Point the daemon at your RN project |

> **Set a real project root.** Component lookup ripgreps it. Point it at a home directory and
> every findings request hangs, which is why `/`, `$HOME` and one-level-deep paths are rejected
> outright.

## Richer findings

Host-side collection alone gives you CPU, memory and frame timings. Add
[`@rnperf/sdk`](https://www.npmjs.com/package/@rnperf/sdk) to the app and findings gain
attribution — which component re-rendered, how often, how wastefully, and in which file:

```bash
npm install @rnperf/sdk
```

Component render data needs a dev build; React records no timings in its production renderer.
Frames, stalls and memory are measured either way.

## Other clients

Any MCP client over stdio works. The command is `npx -y @rnperf/mcp-server`; for a config file:

```json
{
  "mcpServers": {
    "rnperf": {
      "command": "npx",
      "args": ["-y", "@rnperf/mcp-server"]
    }
  }
}
```

Full documentation: https://vahesaroyan.github.io/react-native-performance-monitor/
