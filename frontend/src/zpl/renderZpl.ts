/**
 * Local, fully-offline ZPL → canvas renderer.
 *
 * Purpose: preview labels in air-gapped / closed networks (폐쇄망) with NO call
 * to Labelary or any cloud service. Covers the command set VisualZPL emits, plus
 * common ZPL, so both generated and pasted ZPL render. Barcodes/QR use bwip-js
 * (bundled); text/boxes/graphics use the 2D canvas.
 *
 * Fidelity note: text uses a bundled/system sans-serif to approximate the
 * printer's scalable font 0 — layout, sizing, wrapping and alignment match, but
 * glyph shapes are an approximation. The exported ZPL remains the source of
 * truth for the physical printer.
 *
 * Supported: ^XA ^XZ ^CI ^PW ^LL ^FO ^FT ^A ^FB ^FD ^FS ^GB ^GC ^GD ^GE ^GFA ^BY, and
 * barcodes ^BC (Code128) ^B3 (Code39) ^B2 (ITF) ^BA (Code93) ^BE (EAN-13)
 * ^B8 (EAN-8) ^BU (UPC-A) ^BQ (QR) ^BX (Data Matrix) ^B7 (PDF417).
 * Unknown commands are skipped so a label still renders.
 */
import { toCanvas as bwipToCanvas } from 'bwip-js/browser';

export interface RenderZplOptions {
  widthMm: number;
  heightMm: number;
  dpmm: number;
}

type Rotation = 'N' | 'R' | 'I' | 'B';

interface FontState {
  rot: Rotation;
  h: number; // char height in dots
  w: number; // char width in dots (0 = proportional)
}

interface BlockState {
  w: number; // block width in dots
  maxLines: number;
  align: 'L' | 'C' | 'R' | 'J';
}

type Pending =
  | { kind: 'text' }
  | {
      kind: 'barcode';
      bcid: string;   // bwip-js symbology id
      twoD: boolean;
      height: number; // linear bar height in dots
      module: number; // module width in dots (scale)
      includetext: boolean;
      mag: number;    // 2D cell magnification / module size
      ec: string;     // 2D error-correction level (QR)
    };

// ZPL barcode command (^B..) → bwip-js symbology. `heightIdx` is the param
// index of the linear bar height (the interpretation-line flag sits at
// heightIdx+1); 2D codes size by module/scale (`magIdx`) instead.
const BARCODE_MAP: Record<
  string,
  { bcid: string; twoD?: boolean; heightIdx?: number; magIdx?: number }
> = {
  BC: { bcid: 'code128', heightIdx: 1 },
  B3: { bcid: 'code39', heightIdx: 2 },
  B2: { bcid: 'interleaved2of5', heightIdx: 1 },
  BA: { bcid: 'code93', heightIdx: 1 },
  BE: { bcid: 'ean13', heightIdx: 1 },
  B8: { bcid: 'ean8', heightIdx: 1 },
  BU: { bcid: 'upca', heightIdx: 1 },
  BQ: { bcid: 'qrcode', twoD: true, magIdx: 2 },
  BX: { bcid: 'datamatrix', twoD: true, magIdx: 1 },
  B7: { bcid: 'pdf417', twoD: true },
};

const toInt = (s: string | undefined, d = 0): number => {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const asRotation = (c: string | undefined): Rotation =>
  c === 'R' || c === 'I' || c === 'B' ? c : 'N';

/** Upper bound per side so a typo'd ^PW/^LL cannot allocate a runaway canvas. */
const MAX_CANVAS_DOTS = 16000;

const clampDots = (n: number): number =>
  Math.max(1, Math.min(MAX_CANVAS_DOTS, Math.round(n)));

/**
 * Reads the media size the ZPL declares for itself: ^PW (print width) and
 * ^LL (label length), both in dots. Returns nulls when absent so the caller
 * can fall back to the editor's configured size.
 */
export function readDeclaredSize(zpl: string): {
  widthDots: number | null;
  heightDots: number | null;
} {
  const read = (cmd: 'PW' | 'LL'): number | null => {
    // Last occurrence wins — later commands override earlier ones on a printer.
    const matches = [...zpl.matchAll(new RegExp(`\\^${cmd}\\s*(\\d+)`, 'gi'))];
    if (matches.length === 0) return null;
    const value = parseInt(matches[matches.length - 1][1], 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return { widthDots: read('PW'), heightDots: read('LL') };
}

const ANGLE: Record<Rotation, number> = { N: 0, R: 90, I: 180, B: 270 };

/** Render ZPL to an offscreen canvas at native dot resolution. */
export function renderZplToCanvas(zpl: string, opts: RenderZplOptions): HTMLCanvasElement {
  const dpmm = opts.dpmm || 8;
  // The ZPL itself declares its media size via ^PW/^LL (dots). Honour that when
  // present so pasted external ZPL renders whole instead of being clipped to the
  // editor's width/height. Generated ZPL emits the same values, so nothing changes
  // for canvas-authored labels.
  const declared = readDeclaredSize(zpl);
  const W = clampDots(declared.widthDots ?? Math.round((opts.widthMm || 100) * dpmm));
  const H = clampDots(declared.heightDots ?? Math.round((opts.heightMm || 50) * dpmm));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';

  // ── field state ──
  let ox = 0;
  let oy = 0;
  let font: FontState = { rot: 'N', h: 30, w: 0 };
  let block: BlockState | null = null;
  let byModule = 2;
  let byHeight = 80;
  let pending: Pending = { kind: 'text' };

  const resetField = () => {
    block = null;
    pending = { kind: 'text' };
  };

  const drawBox = (rest: string) => {
    const p = rest.split(',');
    const w = Math.max(toInt(p[0], 1), 1);
    const h = Math.max(toInt(p[1], 1), 1);
    const t = Math.max(1, toInt(p[2], 1));
    ctx.fillStyle = '#000000';
    // A degenerate box (either side no thicker than the border) is how ZPL draws
    // plain rules/lines — fill it solid.
    if (w <= t || h <= t) {
      ctx.fillRect(ox, oy, w, h);
      return;
    }
    // Otherwise stroke the four edges and leave the interior untouched. ZPL is
    // additive — an element only turns dots on, it never erases what sits
    // beneath it. Painting the interior white would wipe out text/barcodes
    // placed under a frame, which is a very common label layout.
    ctx.fillRect(ox, oy, w, t); // top
    ctx.fillRect(ox, oy + h - t, w, t); // bottom
    ctx.fillRect(ox, oy, t, h); // left
    ctx.fillRect(ox + w - t, oy, t, h); // right
  };

  // ^GC<diameter>,<thickness>,<color> — circle (filled if thickness fills it).
  const drawCircle = (rest: string) => {
    const p = rest.split(',');
    const d = toInt(p[0], 1);
    const t = Math.max(1, toInt(p[1], 1));
    const cx = ox + d / 2;
    const cy = oy + d / 2;
    ctx.beginPath();
    if (t * 2 >= d) {
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#000000';
      ctx.fill();
    } else {
      ctx.arc(cx, cy, Math.max(0.5, (d - t) / 2), 0, Math.PI * 2);
      ctx.lineWidth = t;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
  };

  // ^GE<width>,<height>,<thickness>,<color> — ellipse.
  const drawEllipse = (rest: string) => {
    const p = rest.split(',');
    const w = toInt(p[0], 1);
    const h = toInt(p[1], 1);
    const t = Math.max(1, toInt(p[2], 1));
    const cx = ox + w / 2;
    const cy = oy + h / 2;
    ctx.beginPath();
    if (t * 2 >= Math.min(w, h)) {
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#000000';
      ctx.fill();
    } else {
      ctx.ellipse(cx, cy, Math.max(0.5, (w - t) / 2), Math.max(0.5, (h - t) / 2), 0, 0, Math.PI * 2);
      ctx.lineWidth = t;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
  };

  // ^GD<width>,<height>,<thickness>,<color>,<orientation> — diagonal line.
  const drawDiagonal = (rest: string) => {
    const p = rest.split(',');
    const w = toInt(p[0], 1);
    const h = toInt(p[1], 1);
    const t = Math.max(1, toInt(p[2], 1));
    const o = (p[4] || 'R').toUpperCase(); // R = "\", L = "/"
    ctx.beginPath();
    if (o === 'L') {
      ctx.moveTo(ox, oy + h);
      ctx.lineTo(ox + w, oy);
    } else {
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + w, oy + h);
    }
    ctx.lineWidth = t;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  };

  const drawGfa = (rest: string) => {
    // ^GFA,<total>,<total>,<bytesPerRow>,<hex>
    const parts = rest.split(',');
    const bpr = toInt(parts[3], 0);
    const hex = parts.slice(4).join(',').replace(/[^0-9A-Fa-f]/g, '');
    if (bpr <= 0 || hex.length < 2) return;
    const rows = Math.floor(hex.length / 2 / bpr);
    if (rows <= 0) return;
    const wpx = bpr * 8;
    const tmp = document.createElement('canvas');
    tmp.width = wpx;
    tmp.height = rows;
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    const img = tctx.createImageData(wpx, rows);
    for (let r = 0; r < rows; r++) {
      for (let b = 0; b < bpr; b++) {
        const byte = parseInt(hex.substr((r * bpr + b) * 2, 2), 16) || 0;
        for (let bit = 0; bit < 8; bit++) {
          const on = (byte >> (7 - bit)) & 1; // 1 = black dot
          const idx = (r * wpx + (b * 8 + bit)) * 4;
          const v = on ? 0 : 255;
          img.data[idx] = v;
          img.data[idx + 1] = v;
          img.data[idx + 2] = v;
          img.data[idx + 3] = on ? 255 : 0; // transparent where white
        }
      }
    }
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, ox, oy);
  };

  const drawText = (data: string) => {
    const size = Math.max(6, font.h);
    ctx.font = `${size}px "Helvetica Neue", Arial, "Liberation Sans", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000000';

    const rot = ANGLE[font.rot];
    const restore = rot !== 0;
    if (restore) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.translate(-ox, -oy);
    }

    if (block) {
      // word-wrap into the block, then align each line
      const lineH = size * 1.18;
      const words = data.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let cur = '';
      for (const word of words) {
        const test = cur ? `${cur} ${word}` : word;
        if (ctx.measureText(test).width > block.w && cur) {
          lines.push(cur);
          cur = word;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);
      const shown = lines.slice(0, block.maxLines > 0 ? block.maxLines : lines.length);
      shown.forEach((ln, i) => {
        const lw = ctx.measureText(ln).width;
        let lx = ox;
        if (block!.align === 'C') lx = ox + (block!.w - lw) / 2;
        else if (block!.align === 'R') lx = ox + (block!.w - lw);
        ctx.fillText(ln, lx, oy + i * lineH);
      });
    } else {
      ctx.fillText(data, ox, oy);
    }

    if (restore) ctx.restore();
  };

  const drawBarcode = (data: string) => {
    if (pending.kind !== 'barcode') return;
    const bc = pending;
    const tmp = document.createElement('canvas');
    // bwip-js's TS type omits some valid BWIPP options (eclevel); build opts as
    // a var and cast so the excess-property check doesn't fire.
    type BwipOpts = Parameters<typeof bwipToCanvas>[1];
    try {
      if (bc.twoD) {
        let payload = data;
        let ec = bc.ec;
        if (bc.bcid === 'qrcode') {
          // ^FD "<EC><Mode>,<payload>" (e.g. "MA,https://…") → strip the prefix.
          const m = /^([LMQH])[A-Za-z0-9],/.exec(data);
          if (m) ec = m[1];
          payload = data.replace(/^[LMQH]?[A-Za-z0-9],/, '');
        }
        const opts: Record<string, unknown> = {
          bcid: bc.bcid,
          text: payload,
          scale: Math.max(2, bc.mag),
          paddingwidth: 0,
          paddingheight: 0,
        };
        if (bc.bcid === 'qrcode') opts.eclevel = /^[LMQH]$/.test(ec) ? ec : 'M';
        bwipToCanvas(tmp, opts as unknown as BwipOpts);
        ctx.drawImage(tmp, ox, oy);
      } else {
        const opts = {
          bcid: bc.bcid,
          text: data,
          scale: Math.max(1, bc.module),
          height: Math.max(3, Math.round(bc.height / dpmm)), // mm
          includetext: bc.includetext,
          textxalign: 'center',
          paddingwidth: 0,
          paddingheight: 0,
        };
        bwipToCanvas(tmp, opts as BwipOpts);
        // Force the bar height to the ZPL height (dots), keep module-accurate width.
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, ox, oy, tmp.width, Math.max(1, bc.height));
      }
    } catch {
      // Unrenderable barcode data (e.g. EAN with the wrong digit count) →
      // leave a light placeholder box instead of failing the whole label.
      ctx.strokeStyle = '#94a3b8';
      ctx.strokeRect(ox, oy, 80, Math.max(20, bc.twoD ? 80 : bc.height));
      ctx.strokeStyle = '#000000';
    }
  };

  const onFieldData = (data: string) => {
    if (pending.kind === 'text') drawText(data);
    else drawBarcode(data);
  };

  // ── parse ──
  const tokens = zpl.split('^');
  for (const raw of tokens) {
    if (!raw) continue;
    const up2 = raw.slice(0, 2).toUpperCase();
    const up3 = raw.slice(0, 3).toUpperCase();

    if (up2 === 'XA' || up2 === 'XZ' || up2 === 'CI' || up2 === 'PW' || up2 === 'LL' ||
        up2 === 'LH' || up2 === 'LS' || up2 === 'CF' || up2 === 'FW' || up2 === 'FH' ||
        up2 === 'PO' || up2 === 'MN' || up2 === 'MM' || up2 === 'PR' || up2 === 'FR') {
      // control / layout commands with no direct pixel output here
      continue;
    }
    if (up2 === 'FO' || up2 === 'FT') {
      const p = raw.slice(2).split(',');
      ox = toInt(p[0]);
      oy = toInt(p[1]);
      continue;
    }
    if (up2 === 'FS') {
      resetField();
      continue;
    }
    if (up2 === 'FD') {
      onFieldData(raw.slice(2));
      continue;
    }
    if (up2 === 'FB') {
      const p = raw.slice(2).split(',');
      const al = (p[3] || 'L').toUpperCase();
      block = {
        w: toInt(p[0], 0),
        maxLines: toInt(p[1], 1),
        align: al === 'C' || al === 'R' || al === 'J' ? (al as 'C' | 'R' | 'J') : 'L',
      };
      continue;
    }
    if (up3 === 'GFA' || up3 === 'GFB' || up3 === 'GFC') {
      drawGfa(raw.slice(3));
      continue;
    }
    if (up2 === 'GB') {
      drawBox(raw.slice(2));
      continue;
    }
    if (up2 === 'GC') {
      drawCircle(raw.slice(2));
      continue;
    }
    if (up2 === 'GD') {
      drawDiagonal(raw.slice(2));
      continue;
    }
    if (up2 === 'GE') {
      drawEllipse(raw.slice(2));
      continue;
    }
    if (up2 === 'BY') {
      // ^BY<module>,<ratio>,<height> — module width + default bar height (dots).
      const p = raw.slice(2).split(',');
      byModule = toInt(p[0], byModule) || byModule;
      if (p[2] !== undefined && p[2] !== '') byHeight = toInt(p[2], byHeight) || byHeight;
      continue;
    }
    if (raw[0].toUpperCase() === 'B' && BARCODE_MAP[up2]) {
      const cfg = BARCODE_MAP[up2];
      const p = raw.slice(2).split(',');
      const lineFlag = cfg.heightIdx != null ? p[cfg.heightIdx + 1] : undefined;
      pending = {
        kind: 'barcode',
        bcid: cfg.bcid,
        twoD: !!cfg.twoD,
        height: cfg.heightIdx != null ? toInt(p[cfg.heightIdx], byHeight) : byHeight,
        module: byModule,
        includetext: cfg.twoD ? false : (lineFlag ? lineFlag.toUpperCase() !== 'N' : true),
        mag: cfg.magIdx != null ? toInt(p[cfg.magIdx], 3) : 3,
        ec: 'M',
      };
      continue;
    }
    if (raw[0].toUpperCase() === 'A') {
      // ^A<font><rot>,<h>,<w>  (e.g. A0N,32,0)
      const body = raw.slice(1);
      let idx = 1; // skip font id char
      let rot: Rotation = 'N';
      const rc = body[1];
      if (rc === 'N' || rc === 'R' || rc === 'I' || rc === 'B') {
        rot = rc;
        idx = 2;
      }
      const p = body.slice(idx).replace(/^,/, '').split(',');
      font = { rot, h: toInt(p[0], font.h), w: toInt(p[1], 0) };
      continue;
    }
    // else: unknown command — skip
  }

  return canvas;
}

/** Render ZPL to a PNG data URL (fully offline). */
export function renderZplToDataUrl(zpl: string, opts: RenderZplOptions): string {
  return renderZplToCanvas(zpl, opts).toDataURL('image/png');
}
