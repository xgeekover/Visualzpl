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
 * Supported: ^XA ^XZ ^CI ^PW ^LL ^FO ^FT ^A ^FB ^FD ^FS ^GB ^GFA ^BY ^BC ^BQ.
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
  | { kind: 'code128'; height: number; module: number; line: boolean; above: boolean }
  | { kind: 'qr'; mag: number; ec: string };

const toInt = (s: string | undefined, d = 0): number => {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const asRotation = (c: string | undefined): Rotation =>
  c === 'R' || c === 'I' || c === 'B' ? c : 'N';

const ANGLE: Record<Rotation, number> = { N: 0, R: 90, I: 180, B: 270 };

/** Render ZPL to an offscreen canvas at native dot resolution. */
export function renderZplToCanvas(zpl: string, opts: RenderZplOptions): HTMLCanvasElement {
  const dpmm = opts.dpmm || 8;
  const W = Math.max(1, Math.round((opts.widthMm || 100) * dpmm));
  const H = Math.max(1, Math.round((opts.heightMm || 50) * dpmm));

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
  let pending: Pending = { kind: 'text' };

  const resetField = () => {
    block = null;
    pending = { kind: 'text' };
  };

  const drawBox = (rest: string) => {
    const p = rest.split(',');
    const w = toInt(p[0], 1);
    const h = toInt(p[1], 1);
    const t = Math.max(1, toInt(p[2], 1));
    if (w <= t || h <= t) {
      ctx.fillRect(ox, oy, Math.max(w, 1), Math.max(h, 1));
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(ox + t, oy + t, w - 2 * t, h - 2 * t);
      ctx.fillStyle = '#000000';
    }
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
    const tmp = document.createElement('canvas');
    try {
      if (pending.kind === 'code128') {
        bwipToCanvas(tmp, {
          bcid: 'code128',
          text: data,
          scale: Math.max(1, pending.module),
          height: Math.max(3, Math.round(pending.height / dpmm)), // mm
          includetext: pending.line,
          textxalign: 'center',
          paddingwidth: 0,
          paddingheight: 0,
        });
        // Force the bar height to the ZPL height (dots), keep module-accurate width.
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, ox, oy, tmp.width, Math.max(1, pending.height));
      } else if (pending.kind === 'qr') {
        // VisualZPL emits ^FD "<EC><Mode>,<payload>" (e.g. "MA,https://…"); strip it.
        const payload = data.replace(/^[LMQH]?[A-Za-z0-9],/, '');
        // `eclevel` is a valid BWIPP qrcode option but missing from bwip-js's
        // TS type; assign to a var so the excess-property check doesn't fire.
        const qrOpts = {
          bcid: 'qrcode' as const,
          text: payload,
          scale: Math.max(1, pending.mag),
          eclevel: /^[LMQH]$/.test(pending.ec) ? pending.ec : 'M',
          paddingwidth: 0,
          paddingheight: 0,
        };
        bwipToCanvas(tmp, qrOpts);
        ctx.drawImage(tmp, ox, oy);
      }
    } catch {
      // Unrenderable barcode data — leave a light placeholder box.
      ctx.strokeStyle = '#94a3b8';
      ctx.strokeRect(ox, oy, 80, Math.max(20, pending.kind === 'code128' ? pending.height : 80));
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
    if (up2 === 'BY') {
      byModule = toInt(raw.slice(2).split(',')[0], byModule) || byModule;
      continue;
    }
    if (up2 === 'BC') {
      const p = raw.slice(2).split(',');
      pending = {
        kind: 'code128',
        height: toInt(p[1], 80),
        module: byModule,
        line: (p[2] || 'Y').toUpperCase() !== 'N',
        above: (p[3] || 'N').toUpperCase() === 'Y',
      };
      continue;
    }
    if (up2 === 'BQ') {
      const p = raw.slice(2).split(',');
      pending = { kind: 'qr', mag: toInt(p[2], 3), ec: 'M' };
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
