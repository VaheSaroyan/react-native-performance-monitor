import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Daemon } from '@rnperf/daemon';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `npm run dev` sets this alongside the Vite server. Running `electron .` on
// its own (or a packaged build) serves the built files instead, so neither
// path depends on a dev server that may not be there.
const isDev = process.env.RNPERF_DEV === '1' && !app.isPackaged;

let daemon;
let daemonPort = 0;
let window;

/**
 * The daemon runs inside the Electron main process so the app is a single
 * thing to start. It still listens on a local port, which is what lets the
 * MCP server and the CLI share the same live sessions.
 */
async function startDaemon() {
  // No default project root: pointing it at $HOME would make component lookup
  // scan the user's entire home directory. The user picks it explicitly.
  daemon = new Daemon();
  const { port } = await daemon.start();
  daemonPort = port;
  return port;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const query = `?port=${daemonPort}`;
  if (isDev) {
    window.loadURL(`http://localhost:5273/${query}`);
  } else {
    window.loadFile(join(__dirname, '..', 'dist', 'index.html'), { search: query });
  }

  // Keep external links in the user's browser rather than a chromeless window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('rnperf:port', () => daemonPort);

ipcMain.handle('rnperf:pick-project-root', async () => {
  const result = await dialog.showOpenDialog(window, {
    title: 'Select your React Native project',
    properties: ['openDirectory'],
    message: 'Findings will be traced to source files in this directory.',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const projectRoot = result.filePaths[0];
  if (daemon) daemon.projectRoot = projectRoot;
  return projectRoot;
});

ipcMain.handle('rnperf:project-root', () => daemon?.projectRoot ?? null);

app.whenReady().then(async () => {
  try {
    await startDaemon();
  } catch (err) {
    dialog.showErrorBox('Could not start the rnperf daemon', String(err?.message ?? err));
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await daemon?.stop().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await daemon?.stop().catch(() => {});
});
