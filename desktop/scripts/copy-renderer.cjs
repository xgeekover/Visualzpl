// Copies the built frontend (../frontend/dist) into ./renderer so electron and
// electron-builder can bundle it. Node-based (fs.cpSync) → works on Win/Mac/Linux.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'frontend', 'dist');
const dest = path.join(__dirname, '..', 'renderer');

if (!fs.existsSync(src)) {
  console.error(
    `[copy-renderer] frontend build not found at ${src}\n` +
    `Run the frontend build first:  cd ../frontend && npm run build -- --base=./`,
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-renderer] ${src} -> ${dest}`);
