import type { AppInfo, DeviceInfo } from '@rnperf/protocol';
import { androidLaunchApp, listAndroidApps, listAndroidDevices } from './android.js';
import { iosSimLaunchApp, listIosSimApps, listIosSimulators } from './ios-sim.js';
import { iosDeviceLaunchApp, listIosDeviceApps, listIosPhysicalDevices } from './ios-device.js';

export * from './android.js';
export * from './ios-sim.js';
export * from './ios-device.js';

/**
 * Polls every source and keeps a merged view. Discovery shells out to adb and
 * xcrun, so it runs on a timer rather than per request — the UI and the MCP
 * server both read the cached list.
 */
export class DeviceRegistry {
  private devices: DeviceInfo[] = [];
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private listeners = new Set<(d: DeviceInfo[]) => void>();

  constructor(private readonly intervalMs = 4000) {}

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onChange(fn: (d: DeviceInfo[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): DeviceInfo[] {
    return this.devices;
  }

  get(id: string): DeviceInfo | undefined {
    return this.devices.find((d) => d.id === id);
  }

  /** Force a scan and return the fresh list. */
  async refresh(): Promise<DeviceInfo[]> {
    await this.scan();
    return this.devices;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const results = await Promise.allSettled([
        listAndroidDevices(),
        listIosSimulators(),
        listIosPhysicalDevices(),
      ]);
      const next = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      next.sort(
        (a, b) =>
          Number(b.state === 'online') - Number(a.state === 'online') ||
          a.platform.localeCompare(b.platform) ||
          a.name.localeCompare(b.name),
      );
      const changed = JSON.stringify(next) !== JSON.stringify(this.devices);
      this.devices = next;
      if (changed) for (const fn of this.listeners) fn(next);
    } finally {
      this.scanning = false;
    }
  }
}

export async function listApps(device: DeviceInfo): Promise<AppInfo[]> {
  switch (device.source) {
    case 'adb': return listAndroidApps(device.id);
    case 'ios-sim-host': return listIosSimApps(device.id);
    case 'ios-devicectl': return listIosDeviceApps(device.id);
    default: return [];
  }
}

export async function launchApp(device: DeviceInfo, bundleId: string): Promise<boolean> {
  switch (device.source) {
    case 'adb': return androidLaunchApp(device.id, bundleId);
    case 'ios-sim-host': return iosSimLaunchApp(device.id, bundleId);
    case 'ios-devicectl': return iosDeviceLaunchApp(device.id, bundleId);
    default: return false;
  }
}
