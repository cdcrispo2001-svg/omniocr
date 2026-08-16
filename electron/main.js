'use strict';
/**
 * OmniOCR — Electron main process.
 *
 * Responsibilities:
 *   - App/window lifecycle
 *   - The `omni://` privileged scheme (same-origin loading of WASM cores,
 *     traineddata, opencv, and app code — works identically on macOS/Windows
 *     and avoids file:// CORS restrictions)
 *   - Privileged file-system I/O on behalf of the sandboxed renderer
 *   - Depth-map extraction helper (macOS native helper + pure-JS fallbacks)
 *   - Headless test-harness mode (`--harness`)
 */

const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IS_HARNESS = process.argv.includes('--harness');
const HARNESS_ARGS = process.argv.filter((a) => a.startsWith('--harness-'));

// Bundled read-only assets live inside the app; user-installed language packs
// live in userData so they survive upgrades.
const RESOURCE_ROOTS = {
  app: ROOT,
  node: path.join(ROOT, 'node_modules'),
  tessdata: path.join(ROOT, 'vendor', 'tessdata'),
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'omni',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.traineddata': 'application/octet-stream',
  '.gz': 'application/octet-stream',
};

function userDataDir(sub) {
  const p = path.join(app.getPath('userData'), sub);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Resolve `omni://<host>/<path>` to an absolute file path, refusing escapes. */
function resolveOmni(url) {
  const u = new URL(url);
  const host = u.hostname;
  let base = RESOURCE_ROOTS[host];
  if (host === 'userlang') base = userDataDir('tessdata');
  if (!base) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const abs = path.normalize(path.join(base, rel));
  if (!abs.startsWith(path.normalize(base))) return null; // path traversal guard
  return unpacked(abs);
}

/**
 * In a packaged build the WASM cores, traineddata and lexicon are unpacked
 * beside the archive. Streaming them through net.fetch needs the real on-disk
 * path, not the virtual one inside app.asar.
 */
function unpacked(abs) {
  if (!abs.includes(`${path.sep}app.asar${path.sep}`)) return abs;
  const alt = abs.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(alt) ? alt : abs;
}

function registerProtocol() {
  protocol.handle('omni', async (request) => {
    const abs = resolveOmni(request.url);
    if (!abs) return new Response('Not found', { status: 404 });
    try {
      const res = await net.fetch(pathToFileURL(abs).toString());
      const headers = new Headers(res.headers);
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (mime) headers.set('content-type', mime);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return new Response(String(err), { status: 404 });
    }
  });
}

/**
 * Locate the Tesseract WASM core.
 *
 * npm places `tesseract.js-core` either at the top level or nested under
 * `tesseract.js`, depending on hoisting, and the packaged bundle can differ
 * from the development tree. Hardcoding one path produces an app that works in
 * development and fails silently once installed, so the path is resolved at
 * runtime and handed to the renderer.
 */
function resolveEngineAssets() {
  const candidates = [
    ['node', 'tesseract.js-core'],
    ['node', 'tesseract.js/node_modules/tesseract.js-core'],
  ];
  let corePath = 'omni://node/tesseract.js-core/';
  for (const [host, rel] of candidates) {
    const base = host === 'node' ? RESOURCE_ROOTS.node : RESOURCE_ROOTS.app;
    if (fs.existsSync(unpacked(path.join(base, rel, 'tesseract-core-simd-lstm.wasm.js')))) {
      corePath = `omni://${host}/${rel}/`;
      break;
    }
  }
  return {
    corePath,
    workerPath: 'omni://node/tesseract.js/dist/worker.min.js',
    langPath: 'omni://app/vendor/tessdata/best',
    lexiconPath: 'omni://app/vendor/lexicon',
  };
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: !IS_HARNESS,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const page = IS_HARNESS ? 'test/harness.html' : 'src/ui/index.html';
  mainWindow.loadURL(`omni://app/${page}`);

  if (process.env.OMNIOCR_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------------------------------------------------ *
 * Depth-map extraction
 * ------------------------------------------------------------------ */

function macDepthHelperPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'omni-depth'),
    path.join(ROOT, 'native', 'macos-depth', 'omni-depth'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Extract a depth/disparity map for an image.
 * Order: macOS native helper (HEIC/JPEG aux images) → caller-side JS parsers.
 * Returns { ok, width, height, data:[Float32 as Array], kind } or { ok:false }.
 */
function extractDepthNative(filePath) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not-darwin' };
  const helper = macDepthHelperPath();
  if (!helper) return { ok: false, reason: 'helper-missing' };
  try {
    const out = spawnSync(helper, [filePath], { maxBuffer: 1024 * 1024 * 256, encoding: 'buffer', timeout: 30000 });
    if (out.status !== 0) return { ok: false, reason: (out.stderr || Buffer.alloc(0)).toString().slice(0, 400) };
    // Helper emits: 16-byte header (magic 'ODPT', w:uint32, h:uint32, flags:uint32) + float32 payload
    const buf = out.stdout;
    if (!buf || buf.length < 16 || buf.toString('ascii', 0, 4) !== 'ODPT') return { ok: false, reason: 'bad-header' };
    const width = buf.readUInt32LE(4);
    const height = buf.readUInt32LE(8);
    const flags = buf.readUInt32LE(12);
    const need = width * height * 4;
    if (buf.length < 16 + need) return { ok: false, reason: 'short-payload' };
    return {
      ok: true,
      width,
      height,
      kind: flags & 1 ? 'disparity' : 'depth',
      buffer: buf.subarray(16, 16 + need).buffer.slice(buf.byteOffset + 16, buf.byteOffset + 16 + need),
    };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    ...resolveEngineAssets(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    depthHelper: !!macDepthHelperPath(),
    cpus: require('os').cpus().length,
    memGB: +(require('os').totalmem() / 1024 ** 3).toFixed(1),
  }));

  ipcMain.handle('dialog:open', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || 'Select documents',
      properties: opts.directory ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: opts.filters || [
        { name: 'Documents & Images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif', 'heic', 'heif', 'avif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled) return [];
    if (opts.directory) {
      const dir = res.filePaths[0];
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && /\.(pdf|png|jpe?g|tiff?|bmp|webp|gif|heic|heif|avif)$/i.test(e.name))
        .map((e) => path.join(dir, e.name))
        .sort();
    }
    return res.filePaths;
  });

  ipcMain.handle('dialog:save', async (_e, opts = {}) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: opts.title || 'Save',
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return res.canceled ? null : res.filePath;
  });

  ipcMain.handle('fs:read', async (_e, filePath) => {
    const buf = await fsp.readFile(filePath);
    return { name: path.basename(filePath), path: filePath, size: buf.length, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  });

  ipcMain.handle('fs:write', async (_e, filePath, data) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, Buffer.from(data));
    return { ok: true, path: filePath, size: Buffer.from(data).length };
  });

  ipcMain.handle('fs:stat', async (_e, p) => {
    try { const s = await fsp.stat(p); return { ok: true, size: s.size, isDir: s.isDirectory() }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('fs:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });

  ipcMain.handle('depth:extract', (_e, filePath) => extractDepthNative(filePath));

  // On-demand language packs (Tesseract tessdata_best), stored in userData.
  ipcMain.handle('lang:list', async () => {
    const dir = userDataDir('tessdata');
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter((f) => f.endsWith('.traineddata')).map((f) => f.replace('.traineddata', ''));
  });

  ipcMain.handle('lang:install', async (_e, code) => {
    if (!/^[a-z_]{3,12}$/i.test(code)) throw new Error('invalid language code');
    const dir = userDataDir('tessdata');
    const dest = path.join(dir, `${code}.traineddata`);
    if (fs.existsSync(dest)) return { ok: true, cached: true, path: dest };
    const url = `https://github.com/tesseract-ocr/tessdata_best/raw/main/${code}.traineddata`;
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100000) throw new Error('unexpected payload');
    await fsp.writeFile(dest, buf);
    return { ok: true, cached: false, path: dest, size: buf.length };
  });

  // Harness reporting: forwards renderer output to the terminal and sets exit code.
  ipcMain.on('harness:log', (_e, line) => process.stdout.write(line + '\n'));
  ipcMain.handle('harness:args', () => HARNESS_ARGS);
  ipcMain.on('harness:done', (_e, payload) => {
    try {
      fs.mkdirSync(path.join(ROOT, 'test', 'out'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'test', 'out', 'report.json'), JSON.stringify(payload, null, 2));
    } catch (_) { /* non-fatal */ }
    app.exit(payload && payload.pass ? 0 : 1);
  });
}

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.disableHardwareAcceleration = app.disableHardwareAcceleration; // no-op; GPU used for canvas ops

app.whenReady().then(() => {
  registerProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
