import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppInfo, DeviceInfo } from '@rnperf/protocol';
import { XCRUN, run } from '../util/exec.js';

interface DevicectlDevice {
  deviceProperties?: { name?: string; osVersionNumber?: string };
  hardwareProperties?: { udid?: string; platform?: string; productType?: string; deviceType?: string; marketingName?: string };
  connectionProperties?: { transportType?: string; tunnelState?: string; pairingState?: string };
}

/** Run a devicectl subcommand that writes JSON to a file, and read it back. */
async function devicectlJson(args: string[], timeoutMs = 30_000): Promise<unknown | null> {
  const dir = await mkdtemp(join(tmpdir(), 'rnperf-dc-'));
  const file = join(dir, 'out.json');
  try {
    const r = await run(XCRUN, ['devicectl', ...args, '--json-output', file], { timeoutMs });
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return r.ok ? null : null;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Physical iOS devices only. `devicectl list devices` also returns every
 * simulator on the machine (transportType "sameMachine"), which the simulator
 * source already covers — including both would double-list them.
 */
export async function listIosPhysicalDevices(): Promise<DeviceInfo[]> {
  const json = (await devicectlJson(['list', 'devices'])) as
    | { result?: { devices?: DevicectlDevice[] } }
    | null;
  const devices = json?.result?.devices ?? [];
  const hasXctrace = await xctraceAvailable();

  const out: DeviceInfo[] = [];
  for (const d of devices) {
    const hw = d.hardwareProperties ?? {};
    const conn = d.connectionProperties ?? {};
    if (hw.platform !== 'iOS') continue;
    if (conn.transportType === 'sameMachine') continue; // a simulator
    if (!hw.udid) continue;

    const paired = conn.pairingState === 'paired';
    const connected = conn.tunnelState === 'connected' || conn.tunnelState === 'available';
    const state: DeviceInfo['state'] = connected ? 'online' : paired ? 'offline' : 'unauthorized';

    out.push({
      id: hw.udid,
      name: d.deviceProperties?.name ?? hw.marketingName ?? hw.udid,
      platform: 'ios',
      kind: 'physical',
      osVersion: d.deviceProperties?.osVersionNumber ? `iOS ${d.deviceProperties.osVersionNumber}` : undefined,
      model: hw.marketingName ?? hw.productType,
      state,
      source: 'ios-devicectl',
      capabilities: {
        nativeMemory: hasXctrace,
        cpu: hasXctrace,
        uiFrames: false,
        listApps: true,
        logs: false,
        notes: {
          ...(hasXctrace
            ? {
                nativeMemory:
                  'Sampled with xctrace (Activity Monitor template) in ~10s windows, so resolution is coarser than adb or the simulator. @rnperf/sdk reports physical footprint every second instead.',
              }
            : {
                nativeMemory: 'xctrace not found. Install Xcode, or use @rnperf/sdk — its native module reports physical footprint from inside the app.',
                cpu: 'xctrace not found. There is no in-app substitute for process CPU; use a simulator or Android for CPU numbers.',
              }),
          uiFrames:
            'Not readable off-device without an Instruments GUI trace. Install @rnperf/sdk — its RNPerfSDK native module measures UI FPS and jank in-process, at the display\'s real refresh rate.',
          logs: 'Use Console.app or `idevicesyslog` for device logs; the SDK forwards app-level logs instead.',
        },
      },
    });
  }
  return out;
}

let xctraceCache: boolean | undefined;
export async function xctraceAvailable(): Promise<boolean> {
  if (xctraceCache !== undefined) return xctraceCache;
  const r = await run(XCRUN, ['xctrace', 'version'], { timeoutMs: 15_000 });
  xctraceCache = r.ok;
  return xctraceCache;
}

/** Processes currently running on a physical device. */
export async function listIosDeviceProcesses(udid: string): Promise<Array<{ pid: number; path: string }>> {
  const json = (await devicectlJson(['device', 'info', 'processes', '--device', udid], 40_000)) as
    | { result?: { runningProcesses?: Array<{ processIdentifier?: number; executable?: string }> } }
    | null;
  return (json?.result?.runningProcesses ?? [])
    .filter((p) => typeof p.processIdentifier === 'number' && p.executable)
    .map((p) => ({ pid: p.processIdentifier!, path: p.executable! }));
}

/** Installed user apps on a physical device, with running state. */
export async function listIosDeviceApps(udid: string): Promise<AppInfo[]> {
  const json = (await devicectlJson(
    ['device', 'info', 'apps', '--device', udid, '--include-all-apps'],
    40_000,
  )) as { result?: { apps?: Array<{ bundleIdentifier?: string; name?: string; appClip?: boolean; defaultApp?: boolean }> } } | null;

  const procs = await listIosDeviceProcesses(udid).catch(() => []);
  const runningNames = new Set(procs.map((p) => p.path.split('/').pop() ?? ''));

  return (json?.result?.apps ?? [])
    .filter((a) => a.bundleIdentifier && !a.appClip)
    .map((a) => ({
      bundleId: a.bundleIdentifier!,
      name: a.name,
      running: a.name ? runningNames.has(a.name) : false,
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.bundleId.localeCompare(b.bundleId));
}

export async function iosDeviceLaunchApp(udid: string, bundleId: string): Promise<boolean> {
  const r = await run(
    XCRUN,
    ['devicectl', 'device', 'process', 'launch', '--device', udid, bundleId],
    { timeoutMs: 60_000 },
  );
  return r.ok;
}
