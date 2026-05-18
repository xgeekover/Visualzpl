import * as fabric from 'fabric';
import {
  CELL_DEFAULTS,
  type ImageEncodedPayload,
  type TableObject,
  type ZplRotation,
} from '../../types';
import { buildOffsets, resolveCellRect } from './tableGeometry';

const PX_PER_MM = 4;

const rotationToAngle = (r?: ZplRotation): number =>
  ({ N: 0, R: 90, I: 180, B: 270 }[r ?? 'N']);

/**
 * Build a fabric.Group representing a TableObject. The group contains:
 *   - one outer Rect (or none, if borderDots is 0)
 *   - interior horizontal/vertical Lines (skipping merge interiors)
 *   - per-cell text (Textbox) or image (FabricImage) children
 *
 * The result is positioned at obj.x, obj.y (mm → px) and rotated as a unit.
 */
export function createTableNode(obj: TableObject): fabric.Group {
  const colXsMm = buildOffsets(obj.colWidthsMm);
  const rowYsMm = buildOffsets(obj.rowHeightsMm);
  const totalWPx = colXsMm[colXsMm.length - 1] * PX_PER_MM;
  const totalHPx = rowYsMm[rowYsMm.length - 1] * PX_PER_MM;

  const children: fabric.FabricObject[] = [];

  // Outer box
  children.push(
    new fabric.Rect({
      left: 0,
      top: 0,
      width: totalWPx,
      height: totalHPx,
      fill: '#ffffff',
      stroke: obj.borderDots > 0 ? '#0f172a' : 'transparent',
      strokeWidth: Math.max(1, obj.borderDots),
      selectable: false,
      evented: false,
    }),
  );

  // Interior horizontal/vertical lines, skipping merge interiors.
  if (obj.borderDots > 0) {
    for (let r = 1; r < obj.rowHeightsMm.length; r++) {
      const y = rowYsMm[r] * PX_PER_MM;
      for (let c = 0; c < obj.colWidthsMm.length; c++) {
        const above = obj.merges.find(
          m => r - 1 >= m.row && r - 1 < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        const below = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        if (above && above === below) continue;
        const x1 = colXsMm[c] * PX_PER_MM;
        const x2 = colXsMm[c + 1] * PX_PER_MM;
        children.push(
          new fabric.Line([x1, y, x2, y], {
            stroke: '#0f172a',
            strokeWidth: Math.max(1, obj.borderDots / 2),
            selectable: false,
            evented: false,
          }),
        );
      }
    }
    for (let c = 1; c < obj.colWidthsMm.length; c++) {
      const x = colXsMm[c] * PX_PER_MM;
      for (let r = 0; r < obj.rowHeightsMm.length; r++) {
        const left = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c - 1 >= m.col && c - 1 < m.col + m.colSpan,
        );
        const right = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        if (left && left === right) continue;
        const y1 = rowYsMm[r] * PX_PER_MM;
        const y2 = rowYsMm[r + 1] * PX_PER_MM;
        children.push(
          new fabric.Line([x, y1, x, y2], {
            stroke: '#0f172a',
            strokeWidth: Math.max(1, obj.borderDots / 2),
            selectable: false,
            evented: false,
          }),
        );
      }
    }
  }

  // Cell content
  for (const cell of obj.cells) {
    const rect = resolveCellRect(
      cell.row,
      cell.col,
      obj.rowHeightsMm,
      obj.colWidthsMm,
      obj.merges,
    );
    if (rect.row !== cell.row || rect.col !== cell.col) continue;
    const padMm = cell.paddingMm ?? CELL_DEFAULTS.paddingMm;
    const innerXPx = (rect.x + padMm) * PX_PER_MM;
    const innerYPx = (rect.y + padMm) * PX_PER_MM;
    const innerWPx = (rect.w - 2 * padMm) * PX_PER_MM;
    const innerHPx = (rect.h - 2 * padMm) * PX_PER_MM;
    if (innerWPx <= 0 || innerHPx <= 0) continue;

    if (cell.imageSourceDataUrl) {
      pushImageChild(children, cell.imageSourceDataUrl, innerXPx, innerYPx, innerWPx, innerHPx);
    } else if (cell.text !== undefined) {
      const fontHeightMm = cell.fontHeightMm ?? CELL_DEFAULTS.fontHeightMm;
      const align = cell.align ?? CELL_DEFAULTS.align;
      children.push(
        new fabric.Textbox(cell.text, {
          left: innerXPx,
          top: innerYPx,
          width: innerWPx,
          fontSize: fontHeightMm * PX_PER_MM,
          fontFamily: 'Helvetica, Arial, sans-serif',
          fill: '#0f172a',
          textAlign: align,
          editable: false,
          selectable: false,
          evented: false,
          angle: rotationToAngle(cell.fontRotation),
          originX: 'left',
          originY: 'top',
        }),
      );
    }
  }

  return new fabric.Group(children, {
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    angle: rotationToAngle(obj.rotation),
    originX: 'left',
    originY: 'top',
    subTargetCheck: false,
  });
}

/**
 * Push a fabric.FabricImage child once it loads. We push a placeholder
 * Rect immediately so the group geometry is stable, then swap on load.
 */
function pushImageChild(
  children: fabric.FabricObject[],
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const placeholder = new fabric.Rect({
    left: x,
    top: y,
    width: w,
    height: h,
    fill: 'rgba(148, 163, 184, 0.2)',
    selectable: false,
    evented: false,
  });
  children.push(placeholder);
  void fabric.FabricImage.fromURL(src).then(img => {
    const natW = img.width ?? w;
    const natH = img.height ?? h;
    img.set({
      left: x,
      top: y,
      scaleX: w / natW,
      scaleY: h / natH,
      selectable: false,
      evented: false,
    });
    const group = placeholder.group;
    if (!group) return;
    group.remove(placeholder);
    group.add(img);
    group.canvas?.requestRenderAll();
  }).catch(() => {
    /* leave placeholder visible — the user will re-upload */
  });
}

export type { ImageEncodedPayload };
