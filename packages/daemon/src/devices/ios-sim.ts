import type { AppInfo, DeviceInfo } from '@rnperf/protocol';
import { XCRUN, run } from '../util/exec.js';

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

function runtimeToVersion(runtimeId: string): string | undefined {
  // "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "iOS 26.5"
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtimeId);
  if (!m) return undefined;
  return `${m[1]} ${m[2]!.replace(/-/g, '.')}`;
}

/**
 * Booted simulators only — a shut-down simulator has no process to measure,
 * and listing dozens of them buries the useful ones.
 */
export async function listIosSimulators(): Promise<DeviceInfo[]> {
  const r = await run(XCRUN, ['simctl', 'list', 'devices', 'booted', '--json'], { timeoutMs: 15_000 });
  if (!r.ok) return [];
  let parsed: { devices?: Record<string, SimctlDevice[]> };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }

  const out: DeviceInfo[] = [];
  for (const [runtimeId, devices] of Object.entries(parsed.devices ?? {})) {
    const osVersion = runtimeToVersion(runtimeId);
    if (osVersion && !/^(iOS|tvOS|watchOS|xrOS)/.test(osVersion)) continue;
    for (const d of devices) {
      if (d.state !== 'Booted') continue;
      out.push({
        id: d.udid,
        name: d.name,
        platform: 'ios',
        kind: 'simulator',
        osVersion,
        model: d.name,
        state: 'online',
        source: 'ios-sim-host',
        capabilities: {
          // Simulator apps are ordinary macOS processes, so host `ps` works.
          nativeMemory: true,
          cpu: true,
          // No Core Animation frame stats are exposed off-device.
          uiFrames: false,
          listApps: true,
          logs: true,
          notes: {
            uiFrames:
              'Not readable from outside the app. Install @rnperf/sdk — its RNPerfSDK native module measures UI FPS and jank in-process with CADisplayLink.',
            nativeMemory:
              'Simulator memory is host memory and runs higher than the same build on a device — use it for trends, not absolute budgets.',
          },
        },
      });
    }
  }
  return out;
}

type PlistApp = {
  CFBundleIdentifier?: string;
  CFBundleDisplayName?: string;
  CFBundleName?: string;
  ApplicationType?: string;
};

/** Apps installed in a simulator, via `simctl listapps` (an old-style plist). */
export async function listIosSimApps(udid: string): Promise<AppInfo[]> {
  const r = await run(XCRUN, ['simctl', 'listapps', udid], { timeoutMs: 20_000 });
  if (!r.ok || !r.stdout.trim()) return [];

  const json = await plistToJson(r.stdout);
  if (!json) return [];

  const pids = await simulatorAppPids(udid);
  return Object.values(json)
    .filter((a) => a.ApplicationType === 'User' && a.CFBundleIdentifier)
    .map((a) => {
      const bundleId = a.CFBundleIdentifier!;
      return {
        bundleId,
        name: a.CFBundleDisplayName ?? a.CFBundleName,
        pid: pids.get(bundleId),
        running: pids.has(bundleId),
      };
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || a.bundleId.localeCompare(b.bundleId));
}

/** `plutil` only reads a file or stdin; `run` has no stdin, so go via a temp file. */
async function plistToJson(plist: string): Promise<Record<string, PlistApp> | null> {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'rnperf-'));
  const file = join(dir, 'apps.plist');
  try {
    await writeFile(file, plist, 'utf8');
    const conv = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 10_000 });
    return conv.ok ? (JSON.parse(conv.stdout) as Record<string, PlistApp>) : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Map bundle id → **host** pid for apps running in a simulator.
 * `launchctl list` inside the simulator reports host pids for
 * `UIKitApplication:<bundle id>[...]` jobs, which is what makes host-side
 * `ps` sampling possible at all.
 */
export async function simulatorAppPids(udid: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await run(XCRUN, ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 15_000 });
  if (!r.ok) return out;
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+|-)\s+(-?\d+)\s+UIKitApplication:([^[\s]+)/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.set(m[3]!, pid);
  }
  return out;
}

export async function iosSimLaunchApp(udid: string, bundleId: string): Promise<boolean> {
  const r = await run(XCRUN, ['simctl', 'launch', udid, bundleId], { timeoutMs: 20_000 });
  return r.ok;
}
