// VisualZPL desktop — Electron main process.
//
// Fully offline desktop shell. The frontend now renders label previews LOCALLY
// (canvas + bwip-js, see frontend/src/zpl/renderZpl.ts) with no network at all,
// so the app works in air-gapped / closed networks (폐쇄망). No Java backend,
// no Labelary proxy — the main process just opens a window on the built UI.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (e.g. labelary.com) open in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(rendererIndexPath());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
