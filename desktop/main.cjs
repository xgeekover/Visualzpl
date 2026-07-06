// VisualZPL desktop — Electron main process.
//
// Replaces the Java Spring Boot backend (which only ever proxied ZPL → PNG to
// Labelary for the frontend's `/api/label/preview` call) with a tiny in-process
// Node HTTP proxy. This keeps the desktop build Java/JRE-free while preserving
// identical preview behavior. Everything else the app does (ZPL generation,
// batch data, canvas editing) already runs client-side in the renderer.
//
// Flow:
//   1. Start a loopback HTTP proxy on an OS-assigned port.
//   2. Inject that port into the renderer via preload (`window.__VZPL_API_BASE__`).
//   3. Load the built frontend from file://.../renderer/index.html.
//   4. Renderer POSTs to the proxy exactly as it did to the old backend.
//
// Preview requires internet (Labelary is a cloud renderer) — same as before.

const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const LABELARY_BASE = process.env.LABELARY_BASE_URL || 'https://api.labelary.com';
const SUPPORTED_DPMM = new Set([6, 8, 12, 24]);
const MM_PER_INCH = 25.4;
const MAX_BODY_BYTES = 5_000_000;

let proxyServer = null;
let proxyPort = 0;

/** Read + parse a JSON request body with a hard size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400, code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

/** Forward a preview request to Labelary and return the PNG bytes. */
async function renderViaLabelary({ zpl, widthMm, heightMm, dpmm = 8, index = 0 }) {
  if (!zpl || !String(zpl).trim()) {
    throw Object.assign(new Error('zpl is required'), { status: 400, code: 'EMPTY_ZPL' });
  }
  const d = Number(dpmm) || 8;
  if (!SUPPORTED_DPMM.has(d)) {
    throw Object.assign(
      new Error(`Unsupported dpmm: ${d} (supported: 6, 8, 12, 24)`),
      { status: 400, code: 'BAD_DPMM' },
    );
  }
  const wIn = (Number(widthMm) || 100) / MM_PER_INCH;
  const hIn = (Number(heightMm) || 50) / MM_PER_INCH;
  const url = `${LABELARY_BASE}/v1/printers/${d}dpmm/labels/${wIn.toFixed(3)}x${hIn.toFixed(3)}/${Number(index) || 0}/`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'image/png' },
      body: String(zpl),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Cannot reach Labelary: ${e && e.message ? e.message : e}`),
      { status: 502, code: 'UPSTREAM_UNREACHABLE' },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // 4xx from Labelary means the ZPL was rejected — surface as a client error.
    const status = resp.status >= 400 && resp.status < 500 ? 400 : 502;
    throw Object.assign(
      new Error(`Labelary HTTP ${resp.status}: ${text || 'error'}`),
      { status, code: status === 400 ? 'INVALID_ZPL' : 'UPSTREAM_ERROR' },
    );
  }
  const buf = await resp.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    throw Object.assign(new Error('Empty PNG response from Labelary'), { status: 502, code: 'EMPTY_PNG' });
  }
  return Buffer.from(buf);
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // The renderer loads from file:// (origin "null"); allow it explicitly.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const isPreview = req.url && req.url.split('?')[0] === '/api/label/preview';
      if (req.method !== 'POST' || !isPreview) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 404, message: 'Not found' }));
        return;
      }
      try {
        const body = await readJson(req);
        const png = await renderViaLabelary(body);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status,
          code: (e && e.code) || 'PREVIEW_FAILED',
          message: (e && e.message) || 'Preview failed',
        }));
      }
    });
    server.on('error', reject);
    // Port 0 → OS assigns a free loopback port (avoids conflicts with 8080 etc.)
    server.listen(0, '127.0.0.1', () => {
      proxyServer = server;
      proxyPort = server.address().port;
      resolve(proxyPort);
    });
  });
}

/** Prefer the packaged renderer; fall back to the dev build under ../frontend. */
function rendererIndexPath() {
  const packaged = path.join(__dirname, 'renderer', 'index.html');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'VisualZPL',
    backgroundColor: '#e2e8f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the renderer the loopback proxy base (with the live port).
      additionalArguments: [`--vzpl-api-base=http://127.0.0.1:${proxyPort}`],
    },
  });

  // External links (e.g. labelary.com) open in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(rendererIndexPath());
}

app.whenReady().then(async () => {
  try {
    await startProxy();
  } catch (e) {
    // Non-fatal: the window still loads; preview will simply error until the
    // proxy is reachable. Log for diagnostics.
    // eslint-disable-next-line no-console
    console.error('[visualzpl] preview proxy failed to start:', e);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (proxyServer) {
    try { proxyServer.close(); } catch { /* ignore */ }
  }
});
