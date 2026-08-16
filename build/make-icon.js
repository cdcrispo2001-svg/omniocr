// Renders the application icon at every size the platforms want.
// Run with: node_modules/.bin/electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = __dirname;
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

const DRAW = `(size) => {
  const c = new OffscreenCanvas(size, size);
  const x = c.getContext('2d');
  const S = size / 1024;
  const r = 180 * S;

  // rounded app tile with a deep blue gradient
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#1b3a5c');
  g.addColorStop(0.55, '#12253c');
  g.addColorStop(1, '#0b1724');
  x.beginPath();
  x.roundRect(0, 0, size, size, r);
  x.fillStyle = g;
  x.fill();

  // the page
  const pw = 470 * S, ph = 610 * S;
  const px = (size - pw) / 2 - 30 * S, py = (size - ph) / 2 - 10 * S;
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.45)';
  x.shadowBlur = 40 * S;
  x.shadowOffsetY = 14 * S;
  x.fillStyle = '#f7f9fc';
  x.beginPath();
  x.roundRect(px, py, pw, ph, 18 * S);
  x.fill();
  x.restore();

  // folded corner
  x.fillStyle = '#d7dee8';
  x.beginPath();
  x.moveTo(px + pw - 120 * S, py);
  x.lineTo(px + pw, py + 120 * S);
  x.lineTo(px + pw - 120 * S, py + 120 * S);
  x.closePath();
  x.fill();

  // text lines, fading out to suggest recognition in progress
  const lines = [0.86, 0.92, 0.78, 0.9, 0.62, 0.88, 0.84, 0.5];
  let ly = py + 190 * S;
  for (let i = 0; i < lines.length; i++) {
    x.fillStyle = i < 4 ? 'rgba(30,45,66,0.85)' : 'rgba(30,45,66,' + (0.5 - i * 0.05) + ')';
    x.beginPath();
    x.roundRect(px + 60 * S, ly, (pw - 120 * S) * lines[i], 26 * S, 13 * S);
    x.fill();
    ly += 54 * S;
  }

  // scan beam across the page
  const beam = x.createLinearGradient(px, py + 300 * S, px + pw, py + 300 * S);
  beam.addColorStop(0, 'rgba(74,158,255,0)');
  beam.addColorStop(0.5, 'rgba(74,158,255,0.95)');
  beam.addColorStop(1, 'rgba(74,158,255,0)');
  x.fillStyle = beam;
  x.fillRect(px - 30 * S, py + 296 * S, pw + 60 * S, 12 * S);

  // corner brackets — the "detect the page" motif
  x.strokeStyle = '#4a9eff';
  x.lineWidth = 26 * S;
  x.lineCap = 'round';
  const bx = px - 60 * S, by = py - 46 * S, bw = pw + 120 * S, bh = ph + 92 * S, L = 96 * S;
  const corner = (cx, cy, dx, dy) => {
    x.beginPath();
    x.moveTo(cx + dx * L, cy);
    x.lineTo(cx, cy);
    x.lineTo(cx, cy + dy * L);
    x.stroke();
  };
  corner(bx, by, 1, 1);
  corner(bx + bw, by, -1, 1);
  corner(bx, by + bh, 1, -1);
  corner(bx + bw, by + bh, -1, -1);

  return c.convertToBlob({ type: 'image/png' }).then(async (b) => Array.from(new Uint8Array(await b.arrayBuffer())));
}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<meta charset="utf-8">');
  const iconset = path.join(OUT, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });

  for (const size of SIZES) {
    const bytes = await win.webContents.executeJavaScript(`(${DRAW})(${size})`, true);
    const buf = Buffer.from(bytes);
    if (size === 512) fs.writeFileSync(path.join(OUT, 'icon.png'), buf);
    fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), buf);
    if (size >= 32) fs.writeFileSync(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), buf);
    console.log('icon', size);
  }
  app.exit(0);
});
