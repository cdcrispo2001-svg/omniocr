// Throwaway capability probe: loads opencv.js inside a real Chromium renderer
// and reports which OpenCV symbols the WASM build actually exposes.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');

protocol.registerSchemesAsPrivileged([{ scheme: 'omni', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

app.whenReady().then(async () => {
  protocol.handle('omni', async (req) => {
    const u = new URL(req.url);
    const base = u.hostname === 'node' ? path.join(ROOT, 'node_modules') : ROOT;
    const abs = path.join(base, decodeURIComponent(u.pathname));
    const res = await net.fetch(pathToFileURL(abs).toString());
    const h = new Headers(res.headers);
    if (abs.endsWith('.js')) h.set('content-type', 'text/javascript');
    if (abs.endsWith('.html')) h.set('content-type', 'text/html');
    if (abs.endsWith('.wasm')) h.set('content-type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers: h });
  });
  const win = new BrowserWindow({ show: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.webContents.on('console-message',(e,l,msg)=>console.log('[renderer]',msg));
  win.webContents.on('did-fail-load',(e,c,d,u)=>console.log('[fail]',c,d,u));
  await win.loadURL('omni://app/test/probe2.html');
  let out = null;
  for (let i = 0; i < 120; i++) {
    out = await win.webContents.executeJavaScript('window.__probe', true);
    if (out && out.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
});
