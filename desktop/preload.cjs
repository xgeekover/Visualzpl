// Exposes the loopback preview-proxy base URL (with its live port) to the
// renderer as `window.__VZPL_API_BASE__`. The frontend prefers this over its
// build-time default when present, so the same build runs on web and desktop.
const { contextBridge } = require('electron');

const PREFIX = '--vzpl-api-base=';
const arg = process.argv.find((a) => a.startsWith(PREFIX));
const apiBase = arg ? arg.slice(PREFIX.length) : '';

contextBridge.exposeInMainWorld('__VZPL_API_BASE__', apiBase);
