import type { AppInfo, DeviceInfo } from '@rnperf/protocol';
import { ADB, has, run } from '../util/exec.js';

/** `adb devices -l` → structured list. */
export async function listAndroidDevices(): Promise<DeviceInfo[]> {
  if (!(await has(ADB))) return [];
  const r = await run(ADB, ['devices', '-l'], { timeoutMs: 8000 });
  if (!r.ok && !r.stdout) return [];

  const out: DeviceInfo[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\S+)\s+(device|offline|unauthorized|bootloader|recovery)\b(.*)$/.exec(trimmed);
    if (!m) continue;
    const [, serial, rawState, rest] = m;
    const props = Object.fromEntries(
      (rest ?? '').trim().split(/\s+/).filter(Boolean).map((kv) => {
        const i = kv.indexOf(':');
        return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
      }),
    ) as Record<string, string>;

    const state: DeviceInfo['state'] =
      rawState === 'device' ? 'online'
      : rawState === 'unauthorized' ? 'unauthorized'
      : rawState === 'offline' ? 'offline'
      : 'booting';

    const isEmulator = serial!.startsWith('emulator-') || props['product']?.startsWith('sdk_') === true;
    let osVersion: string | undefined;
    let model = props['model']?.replace(/_/g, ' ');

    if (state === 'online') {
      const [rel, mdl] = await Promise.all([
        run(ADB, ['-s', serial!, 'shell', 'getprop', 'ro.build.version.release'], { timeoutMs: 5000 }),
        model ? Promise.resolve(null) : run(ADB, ['-s', serial!, 'shell', 'getprop', 'ro.product.model'], { timeoutMs: 5000 }),
      ]);
      osVersion = rel.stdout.trim() || undefined;
      if (mdl) model = mdl.stdout.trim() || model;
    }

    out.push({
      id: serial!,
      name: model || serial!,
      platform: 'android',
      kind: isEmulator ? 'emulator' : 'physical',
      osVersion: osVersion ? `Android ${osVersion}` : undefined,
      model,
      state,
      source: 'adb',
      capabilities: {
        nativeMemory: state === 'online',
        cpu: state === 'online',
        uiFrames: state === 'online',
        listApps: state === 'online',
        logs: state === 'online',
        notes: state === 'unauthorized'
          ? { all: 'Device is unauthorized — accept the USB debugging prompt on the device.' }
          : {
              uiFrames:
                'Read over adb with gfxinfo. @rnperf/sdk also measures frames in-process with Choreographer, which is what reports when no cable is attached; device-side values win when both are present.',
            },
      },
    });
  }
  return out;
}

/** Third-party packages installed on the device, with running state. */
export async function listAndroidApps(serial: string): Promise<AppInfo[]> {
  const [pkgs, procs] = await Promise.all([
    run(ADB, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeoutMs: 15_000 }),
    run(ADB, ['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,NAME'], { timeoutMs: 10_000 }),
  ]);

  const running = new Map<string, number>();
  for (const line of procs.stdout.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) running.set(m[2]!, Number(m[1]));
  }

  return pkgs.stdout
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean)
    .map((bundleId) => ({
      bundleId,
      pid: running.get(bundleId),
      running: running.has(bundleId),
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.bundleId.localeCompare(b.bundleId));
}

export async function androidPid(serial: string, pkg: string): Promise<number | undefined> {
  const r = await run(ADB, ['-s', serial, 'shell', 'pidof', pkg], { timeoutMs: 5000 });
  const pid = Number(r.stdout.trim().split(/\s+/)[0]);
  if (Number.isFinite(pid) && pid > 0) return pid;
  // Older/odd images without pidof.
  const ps = await run(ADB, ['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,NAME'], { timeoutMs: 8000 });
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m && m[2] === pkg) return Number(m[1]);
  }
  return undefined;
}

/** Display refresh rate, so "jank" is judged against the real frame budget. */
export async function androidRefreshHz(serial: string): Promise<number> {
  const r = await run(ADB, ['-s', serial, 'shell', 'dumpsys', 'display'], { timeoutMs: 8000 });
  const m = /fps=([\d.]+)/.exec(r.stdout) ?? /refreshRate=([\d.]+)/.exec(r.stdout);
  const hz = m ? Number(m[1]) : NaN;
  return Number.isFinite(hz) && hz > 20 ? hz : 60;
}

export async function androidLaunchApp(serial: string, pkg: string): Promise<boolean> {
  const r = await run(
    ADB,
    ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
    { timeoutMs: 15_000 },
  );
  return r.ok;
}
