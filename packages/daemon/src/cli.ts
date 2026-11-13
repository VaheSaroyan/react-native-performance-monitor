#!/usr/bin/env node
import { DEFAULT_DAEMON_PORT } from '@rnperf/protocol';
import { Daemon } from './server.js';
import { DeviceRegistry, listApps } from './devices/index.js';
import { METRIC_LABELS, METRIC_UNITS } from '@rnperf/protocol';
import { round } from './util/stats.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (command) {
    case 'daemon': {
      const daemon = new Daemon({
        port: Number(flag('port') ?? process.env.RNPERF_PORT ?? DEFAULT_DAEMON_PORT),
        projectRoot: flag('root') ?? process.cwd(),
      });
      const { port } = await daemon.start();
      console.log(`rnperf daemon listening on http://localhost:${port}`);
      console.log(`  SDK ingest   ws://<your-lan-ip>:${port}/ingest`);
      console.log(`  UI stream    ws://localhost:${port}/live`);
      console.log(`  project root ${daemon.projectRoot}`);
      const shutdown = async () => {
        console.log('\nstopping…');
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      break;
    }

    case 'devices': {
      const registry = new DeviceRegistry();
      const devices = await registry.refresh();
      if (devices.length === 0) {
        console.log('No devices found. Start an emulator/simulator, or connect a device over USB.');
        break;
      }
      for (const d of devices) {
        const caps = Object.entries(d.capabilities)
          .filter(([k, v]) => k !== 'notes' && v === true)
          .map(([k]) => k)
          .join(', ');
        console.log(`${d.state === 'online' ? '●' : '○'} ${d.name}`);
        console.log(`    id        ${d.id}`);
        console.log(`    platform  ${d.platform} ${d.osVersion ?? ''} (${d.kind})`);
        console.log(`    source    ${d.source}`);
        console.log(`    provides  ${caps || 'nothing — see notes'}`);
        for (const [cap, note] of Object.entries(d.capabilities.notes ?? {})) {
          console.log(`    ! ${cap}: ${note}`);
        }
        console.log();
      }
      break;
    }

    case 'apps': {
      const deviceId = args[1] ?? flag('device');
      if (!deviceId) {
        console.error('usage: rnperf apps <deviceId>');
        process.exit(1);
      }
      const registry = new DeviceRegistry();
      const devices = await registry.refresh();
      const device = devices.find((d) => d.id === deviceId);
      if (!device) {
        console.error(`Unknown device ${deviceId}. Run \`rnperf devices\`.`);
        process.exit(1);
      }
      const apps = await listApps(device);
      for (const a of apps) {
        console.log(`${a.running ? '●' : '○'} ${a.bundleId}${a.name ? `  (${a.name})` : ''}${a.pid ? `  pid ${a.pid}` : ''}`);
      }
      break;
    }

    case 'record': {
      const deviceId = args[1] ?? flag('device');
      const bundleId = flag('app');
      const seconds = Number(flag('seconds') ?? 20);
      if (!deviceId) {
        console.error('usage: rnperf record <deviceId> --app <bundleId> [--seconds 20] [--label name]');
        process.exit(1);
      }
      const daemon = new Daemon({ projectRoot: flag('root') ?? process.cwd() });
      await daemon.store.init();
      await daemon.devices.refresh();
      const device = daemon.devices.get(deviceId);
      if (!device) {
        console.error(`Unknown device ${deviceId}. Run \`rnperf devices\`.`);
        process.exit(1);
      }

      const session = await daemon.sessions.start(device, {
        deviceId,
        bundleId,
        label: flag('label') ?? `cli ${new Date().toLocaleTimeString()}`,
        intervalMs: Number(flag('interval') ?? 1000),
      });
      console.log(`recording session ${session.id} for ${seconds}s — interact with the app now…`);

      session.on('warning', (_id: string, message: string) => console.log(`  ! ${message}`));
      let ticks = 0;
      session.on('sample', () => {
        ticks += 1;
        process.stdout.write(`\r  ${ticks} samples`);
      });

      await new Promise((r) => setTimeout(r, seconds * 1000));
      await daemon.sessions.stop(session.id);
      process.stdout.write('\n');

      const summary = await daemon.summaryFor(session.id);
      console.log(`\nsession ${session.id} — ${summary.meta.sampleCount} samples over ${round(summary.durationMs / 1000)}s`);
      console.log(`sources: ${summary.meta.activeSources.join(', ') || 'none'}\n`);

      for (const [key, stat] of Object.entries(summary.metrics)) {
        const unit = METRIC_UNITS[key] ?? '';
        console.log(
          `  ${(METRIC_LABELS[key] ?? key).padEnd(18)} ` +
          `p50 ${String(round(stat.p50, 1)).padStart(8)}${unit}   ` +
          `p95 ${String(round(stat.p95, 1)).padStart(8)}${unit}   ` +
          `max ${String(round(stat.max, 1)).padStart(8)}${unit}`,
        );
      }

      const { findings } = (await (async () => {
        const [samples, events] = await Promise.all([
          daemon.store.readSamples(session.id),
          daemon.store.readEvents(session.id),
        ]);
        const { deriveFindings } = await import('./analysis/findings.js');
        const f = deriveFindings(summary, samples, events);
        await daemon.attachLocations(f);
        return { findings: f };
      })());

      if (findings.length) {
        console.log(`\n${findings.length} finding(s):\n`);
        for (const f of findings) {
          console.log(`  [${f.severity}] ${f.title}`);
          console.log(`      ${f.evidence}`);
          for (const loc of f.locations ?? []) console.log(`      → ${loc.file}:${loc.line}`);
          console.log(`      fix: ${f.suggestion}\n`);
        }
      } else {
        console.log('\nNo findings — nothing crossed a threshold in this window.');
      }
      process.exit(0);
      break;
    }

    default:
      console.log(`rnperf — React Native performance monitor

  rnperf daemon [--port 8787] [--root <project dir>]
      Start the collector daemon. The desktop app and the MCP server both talk to it.

  rnperf devices
      List every connected device and what each one can measure.

  rnperf apps <deviceId>
      List installed apps on a device.

  rnperf record <deviceId> --app <bundleId> [--seconds 20] [--label name]
      Record a session from the terminal and print a summary plus findings.
`);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
