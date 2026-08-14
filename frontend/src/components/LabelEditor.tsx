/**
 * VisualZPL — Label Editor
 *
 * React + Fabric.js based label design editor with a backend-driven live preview.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │           React state ( LabelDocument )                  │  ← source of truth
 *   │           ▲           │                  │               │
 *   │  modify   │           ▼ apply            ▼ build         │
 *   │      Fabric Canvas              ZplBuilder → string      │
 *   │                                          │               │
 *   │                                          ▼ POST          │
 *   │                                useLabelPreview hook      │
 *   │                                          │               │
 *   │                                          ▼               │
 *   │                                 LivePreviewPanel <img/>  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * - Drag / resize on the canvas writes back to state on `object:modified`.
 * - The ZPL string is recomputed on every state change.
 * - The hook debounces (400ms) and renders the ZPL into a PNG via the backend.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import * as fabric from 'fabric';

import type {
  BarcodeObject,
  ImageObject,
  LabelDocument,
  LabelObject,
  QrCodeObject,
  QrErrorCorrection,
  TextObject,
  ZplRotation,
} from '../types';
import { ZplBuilder } from '../ZplBuilder';
import { computeEncodingKey, imageToZpl } from '../ImageToZpl';
import { extractVariables, type DataRow } from '../BatchZpl';
import { downloadTextFile } from '../downloadFile';
import { LABEL_PRESETS, type LabelPreset } from '../LabelPresets';
import { importZpl } from '../zpl/importZpl';
import { useLabelPreview } from '../hooks/useLabelPreview';
import { useBrowserPrint } from '../hooks/useBrowserPrint';
import { useToastQueue, type Toast } from '../hooks/useToastQueue';
import { BatchDataModal } from './BatchDataModal';
import { ResizableBottomPanel } from './ResizableBottomPanel';
import { readJson, writeJson } from '../storage';
import {
  NumberField,
  ReadOnlyField,
  SelectField,
  TextField,
} from './formFields';
import { NewTableModal } from './table/NewTableModal';
import { createTableNode } from './table/tableNode';
import { TableOverlay, type CellSelection } from './table/tableOverlay';
import type { TableObject } from '../types';
import { TablePropertyForm } from './table/TablePropertyForm';
import { CellPropertyForm } from './table/CellPropertyForm';
import { RangeMergeForm } from './table/RangeMergeForm';

// ──────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ──────────────────────────────────────────────────────────────────────────

/** Display scale: 1mm = 4px (favors editor readability over print accuracy). */
const PX_PER_MM = 4;

const INITIAL_DOC: LabelDocument = {
  unit: 'mm',
  dpmm: 8,
  widthMm: 100,
  heightMm: 50,
  objects: [],
};

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

/** 계단식 배치 간격/주기 — 새 객체가 기존 객체를 정확히 덮지 않도록 밀어 놓는다. */
const CASCADE_STEP_MM = 4;
const CASCADE_CYCLE = 5;

/**
 * 새 객체의 시작 좌표. 타입별 기본 위치에 기존 객체 수만큼 계단식 오프셋을 더한다.
 *
 * 오프셋이 없으면 두 번째 객체가 첫 번째 객체 위에 정확히 겹쳐 놓여 화면에서
 * 사라진 것처럼 보인다(특히 표/이미지). 라벨 밖으로 나가지 않도록 클램프한다.
 */
const cascadeOrigin = (
  base: { x: number; y: number },
  count: number,
  labelWidthMm: number,
  labelHeightMm: number,
): { x: number; y: number } => {
  const offset = (count % CASCADE_CYCLE) * CASCADE_STEP_MM;
  return {
    x: Math.max(0, Math.min(base.x + offset, labelWidthMm - 5)),
    y: Math.max(0, Math.min(base.y + offset, labelHeightMm - 5)),
  };
};

/** ZPL rotation code ↔ fabric angle (degrees). */
const rotationToAngle = (r?: ZplRotation): number =>
  ({ N: 0, R: 90, I: 180, B: 270 }[r ?? 'N']);

const angleToRotation = (angle: number): ZplRotation => {
  const normalized = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return (['N', 'R', 'I', 'B'][normalized / 90] ?? 'N') as ZplRotation;
};

/** Deterministic 32-bit hash (FNV-1a variant). Used as a seed for visual stubs. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

/** Seeded PRNG so the same data always produces the same visual pattern. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1103515245);
    s = (s + 12345) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Rough bounding box (in mm) for an object — used by the "out of bounds"
 * check when the user resizes the label. Text/Barcode widths depend on the
 * rendered glyphs so we approximate; precise overflow detection is not the
 * goal here, just enough to warn the user.
 */
function estimateObjectBoundsMm(
  obj: LabelObject,
): { width: number; height: number } {
  switch (obj.type) {
    case 'text':
      // Average glyph width ≈ 0.6 of the font height for proportional fonts.
      return {
        width: Math.max(1, obj.data.length * obj.fontHeight * 0.6),
        height: obj.fontHeight,
      };
    case 'barcode': {
      const moduleWidth = obj.moduleWidth ?? 2;
      // Code 128 width ≈ (11 modules per char + 35 quiet zones) × module width.
      const widthDots = (obj.data.length * 11 + 35) * moduleWidth;
      return { width: widthDots / 8, height: obj.height };
    }
    case 'qrcode': {
      const magnification = obj.magnification ?? 5;
      // QR v1 = 21 cells across, assume 8 dots/mm density.
      const sizeMm = (21 * magnification) / 8;
      return { width: sizeMm, height: sizeMm };
    }
    case 'image':
      return { width: obj.widthMm, height: obj.heightMm };
    case 'table': {
      const w = obj.colWidthsMm.reduce((a, b) => a + b, 0);
      const h = obj.rowHeightsMm.reduce((a, b) => a + b, 0);
      return { width: w, height: h };
    }
  }
}

function isObjectOutOfBounds(
  obj: LabelObject,
  labelWidthMm: number,
  labelHeightMm: number,
): boolean {
  if (obj.x < 0 || obj.y < 0) return true;
  const { width, height } = estimateObjectBoundsMm(obj);
  return obj.x + width > labelWidthMm || obj.y + height > labelHeightMm;
}

/** Read a File from <input type="file"> into a Base64 DataURL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** Decode an image src enough to read its natural pixel dimensions. */
function measureImage(
  src: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

/** Fabric object enriched with our model-side identifier and source snapshot. */
type LabelNode = fabric.FabricObject & {
  labelId?: string;
  labelSource?: LabelObject;
};

// ──────────────────────────────────────────────────────────────────────────
// Fabric node factories — model → canvas visualization
// ──────────────────────────────────────────────────────────────────────────

function createTextNode(obj: TextObject): LabelNode {
  return new fabric.Textbox(obj.data, {
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    width: Math.max(60, obj.data.length * obj.fontHeight * PX_PER_MM * 0.6),
    fontSize: obj.fontHeight * PX_PER_MM,
    fontFamily: 'Helvetica, Arial, sans-serif',
    fill: '#0f172a',
    angle: rotationToAngle(obj.rotation),
    originX: 'left',
    originY: 'top',
    editable: false,
    splitByGrapheme: true,
  }) as LabelNode;
}

function createBarcodeNode(obj: BarcodeObject): LabelNode {
  // Visual approximation only — real Code 128 bars are produced by the printer / Labelary.
  const moduleWidth = obj.moduleWidth ?? 2;
  const heightPx = obj.height * PX_PER_MM;
  const widthDots = (obj.data.length * 11 + 35) * moduleWidth;
  const widthPx = Math.max(80, (widthDots / 8) * PX_PER_MM);

  const bg = new fabric.Rect({
    left: 0,
    top: 0,
    width: widthPx,
    height: heightPx,
    fill: '#ffffff',
    stroke: '#cbd5e1',
    strokeWidth: 0.5,
    selectable: false,
  });

  const rng = seededRng(hashString(obj.data));
  const stripes: fabric.Rect[] = [];
  const stripeArea = heightPx * 0.78;
  let cursor = 6;
  while (cursor < widthPx - 6) {
    const barWidth = 1 + Math.floor(rng() * 3);
    const gapWidth = 1 + Math.floor(rng() * 3);
    if (cursor + barWidth > widthPx - 6) break;
    stripes.push(
      new fabric.Rect({
        left: cursor,
        top: 2,
        width: barWidth,
        height: stripeArea,
        fill: '#0f172a',
        selectable: false,
      }),
    );
    cursor += barWidth + gapWidth;
  }

  const label = new fabric.Text(obj.data, {
    left: widthPx / 2,
    top: heightPx * 0.82,
    fontSize: Math.min(heightPx * 0.16, 12),
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fill: '#0f172a',
    originX: 'center',
    originY: 'top',
    selectable: false,
  });

  return new fabric.Group([bg, ...stripes, label], {
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    angle: rotationToAngle(obj.rotation),
    originX: 'left',
    originY: 'top',
    subTargetCheck: false,
  }) as LabelNode;
}

function createQrNode(obj: QrCodeObject): LabelNode {
  // Approximate QR version 1 (21×21 cells). Real encoding happens on the printer.
  const cells = 21;
  const magnification = obj.magnification ?? 5;
  const cellPx = (magnification / 8) * PX_PER_MM;
  const size = cells * cellPx;

  const elements: fabric.FabricObject[] = [
    new fabric.Rect({
      left: 0,
      top: 0,
      width: size,
      height: size,
      fill: '#ffffff',
      stroke: '#cbd5e1',
      strokeWidth: 0.5,
      selectable: false,
    }),
  ];

  // Three corner finder patterns (top-left / top-right / bottom-left).
  const drawFinder = (cx: number, cy: number) => {
    elements.push(
      new fabric.Rect({
        left: cx * cellPx,
        top: cy * cellPx,
        width: 7 * cellPx,
        height: 7 * cellPx,
        fill: '#0f172a',
        selectable: false,
      }),
      new fabric.Rect({
        left: (cx + 1) * cellPx,
        top: (cy + 1) * cellPx,
        width: 5 * cellPx,
        height: 5 * cellPx,
        fill: '#ffffff',
        selectable: false,
      }),
      new fabric.Rect({
        left: (cx + 2) * cellPx,
        top: (cy + 2) * cellPx,
        width: 3 * cellPx,
        height: 3 * cellPx,
        fill: '#0f172a',
        selectable: false,
      }),
    );
  };
  drawFinder(0, 0);
  drawFinder(cells - 7, 0);
  drawFinder(0, cells - 7);

  // Body cells: deterministic pattern derived from the payload string.
  const rng = seededRng(hashString(obj.data));
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const inFinder =
        (x < 8 && y < 8) ||
        (x >= cells - 8 && y < 8) ||
        (x < 8 && y >= cells - 8);
      if (inFinder) continue;
      if (rng() < 0.48) {
        elements.push(
          new fabric.Rect({
            left: x * cellPx,
            top: y * cellPx,
            width: cellPx,
            height: cellPx,
            fill: '#0f172a',
            selectable: false,
          }),
        );
      }
    }
  }

  return new fabric.Group(elements, {
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    angle: rotationToAngle(obj.rotation),
    originX: 'left',
    originY: 'top',
    subTargetCheck: false,
  }) as LabelNode;
}

function createFabricNode(obj: LabelObject): LabelNode {
  switch (obj.type) {
    case 'text':
      return createTextNode(obj);
    case 'barcode':
      return createBarcodeNode(obj);
    case 'qrcode':
      return createQrNode(obj);
    case 'image':
      throw new Error(
        'Image nodes are async — use createImageNode() instead',
      );
    case 'table':
      return createTableNode(obj) as LabelNode;
  }
}

/**
 * Async fabric.Image factory. Decodes the DataURL through fabric's loader so
 * the displayed bitmap stays in sync with what the printer will rasterize.
 * Rotation is locked because ^GFA does not support orientation parameters.
 */
async function createImageNode(obj: ImageObject): Promise<LabelNode> {
  const fabricImg = await fabric.FabricImage.fromURL(obj.sourceDataUrl);
  const widthPx = obj.widthMm * PX_PER_MM;
  const heightPx = obj.heightMm * PX_PER_MM;
  const naturalWidth = fabricImg.width ?? widthPx;
  const naturalHeight = fabricImg.height ?? heightPx;
  fabricImg.set({
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    scaleX: widthPx / naturalWidth,
    scaleY: heightPx / naturalHeight,
    angle: 0,
    originX: 'left',
    originY: 'top',
    lockRotation: true,
  });
  return fabricImg as LabelNode;
}

// ──────────────────────────────────────────────────────────────────────────
// State ↔ fabric sync helpers
// ──────────────────────────────────────────────────────────────────────────

/** Returns true if the change cannot be applied in place and needs a fresh node. */
function shouldRecreate(prev: LabelObject, next: LabelObject): boolean {
  if (prev.type !== next.type) return true;
  if (prev.type === 'text' && next.type === 'text') return false;
  if (prev.type === 'barcode' && next.type === 'barcode') {
    return (
      prev.data !== next.data ||
      prev.height !== next.height ||
      prev.moduleWidth !== next.moduleWidth
    );
  }
  if (prev.type === 'qrcode' && next.type === 'qrcode') {
    return (
      prev.data !== next.data ||
      prev.magnification !== next.magnification ||
      prev.model !== next.model
    );
  }
  if (prev.type === 'image' && next.type === 'image') {
    // Only recreate when the actual source image changes — size changes are
    // applied in place by adjusting fabric scaleX/scaleY.
    return prev.sourceDataUrl !== next.sourceDataUrl;
  }
  if (prev.type === 'table' && next.type === 'table') {
    return (
      JSON.stringify(prev.rowHeightsMm) !== JSON.stringify(next.rowHeightsMm) ||
      JSON.stringify(prev.colWidthsMm) !== JSON.stringify(next.colWidthsMm) ||
      JSON.stringify(prev.cells) !== JSON.stringify(next.cells) ||
      JSON.stringify(prev.merges) !== JSON.stringify(next.merges) ||
      prev.borderDots !== next.borderDots
    );
  }
  return false;
}

/** Apply a lightweight in-place update (position / rotation / text content). */
function applyModelToNode(node: LabelNode, model: LabelObject): void {
  node.set({
    left: model.x * PX_PER_MM,
    top: model.y * PX_PER_MM,
    angle: rotationToAngle(model.rotation),
  });

  if (model.type === 'text' && node instanceof fabric.Textbox) {
    node.set({
      text: model.data,
      fontSize: model.fontHeight * PX_PER_MM,
      scaleX: 1,
      scaleY: 1,
    });
  } else if (model.type === 'image' && node instanceof fabric.FabricImage) {
    // For images, "size" is encoded as fabric scaleX/scaleY relative to the
    // bitmap's natural pixel dimensions. Resetting to 1 would shrink them.
    const widthPx = model.widthMm * PX_PER_MM;
    const heightPx = model.heightMm * PX_PER_MM;
    const naturalWidth = node.width ?? widthPx;
    const naturalHeight = node.height ?? heightPx;
    node.set({
      scaleX: widthPx / naturalWidth,
      scaleY: heightPx / naturalHeight,
    });
  } else {
    node.set({ scaleX: 1, scaleY: 1 });
  }

  node.setCoords();
}

/** Translate the current state of a fabric node back into the data model. */
function nodeToModelPatch(
  prev: LabelObject,
  node: fabric.FabricObject,
): LabelObject {
  const scaleX = node.scaleX ?? 1;
  const scaleY = node.scaleY ?? 1;
  const base = {
    ...prev,
    x: (node.left ?? 0) / PX_PER_MM,
    y: (node.top ?? 0) / PX_PER_MM,
    rotation: angleToRotation(node.angle ?? 0),
  };

  if (prev.type === 'text') {
    return {
      ...(base as TextObject),
      fontHeight: Math.max(1, prev.fontHeight * scaleY),
    };
  }
  if (prev.type === 'barcode') {
    return {
      ...(base as BarcodeObject),
      height: Math.max(1, prev.height * scaleY),
    };
  }
  if (prev.type === 'qrcode') {
    const mag = Math.round((prev.magnification ?? 5) * Math.max(scaleX, scaleY));
    return {
      ...(base as QrCodeObject),
      magnification: Math.min(10, Math.max(1, mag)),
    };
  }
  if (prev.type === 'image') {
    const naturalWidth = node.width ?? 1;
    const naturalHeight = node.height ?? 1;
    const newWidthMm = Math.max(1, (naturalWidth * scaleX) / PX_PER_MM);
    const newHeightMm = Math.max(1, (naturalHeight * scaleY) / PX_PER_MM);
    return {
      ...(base as ImageObject),
      widthMm: newWidthMm,
      heightMm: newHeightMm,
    };
  }
  return base;
}

// ──────────────────────────────────────────────────────────────────────────
// Inline SVG icons — kept as small components for tree-shaking friendliness.
// (Toast queue lives in ../hooks/useToastQueue; the old useFlashStatus has
//  been replaced.)
// ──────────────────────────────────────────────────────────────────────────

function ClipboardIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function PrinterIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function ImageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function TableIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
    </svg>
  );
}

function SparkleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.6 4.8L18.4 9l-4.8 1.2L12 15l-1.6-4.8L5.6 9l4.8-1.2L12 3z" />
      <path d="M19 14l.7 2.1 2.1.7-2.1.7L19 19.6l-.7-2.1-2.1-.7 2.1-.7L19 14z" />
    </svg>
  );
}

function ChevronDownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

export function LabelEditor() {
  const [doc, setDoc] = useState<LabelDocument>(INITIAL_DOC);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cellSelection, setCellSelection] = useState<CellSelection>({ kind: 'none' });

  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<fabric.Canvas | null>(null);
  const nodesRef = useRef<Map<string, LabelNode>>(new Map());
  /** Suppress canvas → state writes while we are applying state → canvas. */
  const applyingRef = useRef(false);
  /** Mirror of `selectedId` for use inside imperative fabric callbacks. */
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    setCellSelection({ kind: 'none' });
  }, [selectedId]);

  // Bottom panel layout — persisted across sessions in localStorage.
  const BOTTOM_PANEL_STORAGE_KEY = 'visualzpl.bottomPanel';
  type BottomPanelStored = { height: number; collapsed: boolean };
  const [bottomHeight, setBottomHeight] = useState<number>(
    () => readJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY)?.height ?? 240,
  );
  const [bottomCollapsed, setBottomCollapsed] = useState<boolean>(
    () => readJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY)?.collapsed ?? false,
  );
  useEffect(() => {
    writeJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY, {
      height: bottomHeight,
      collapsed: bottomCollapsed,
    });
  }, [bottomHeight, bottomCollapsed]);

  // Live ZPL string. Generated from the canvas doc, UNLESS the user has
  // manually edited / pasted raw ZPL into the code panel (`zplDraft` override).
  // When a draft is present, the preview + copy/download/print all follow it,
  // so external ZPL can be pasted, tweaked, and previewed without a full ZPL
  // importer. `재생성으로 되돌리기` clears the draft back to the generated ZPL.
  const generatedZpl = useMemo(() => new ZplBuilder(doc).build(), [doc]);
  const [zplDraft, setZplDraft] = useState<string | null>(null);
  const zplCode = zplDraft ?? generatedZpl;
  const isManualZpl = zplDraft !== null;

  // Backend preview via debounced hook.
  const previewWidthMm = doc.widthMm ?? 100;
  const previewHeightMm = doc.heightMm ?? 50;
  const previewDpmm = doc.dpmm ?? 8;

  const { previewUrl, isLoading, error: previewError } = useLabelPreview({
    zplCode,
    widthMm: previewWidthMm,
    heightMm: previewHeightMm,
    dpmm: previewDpmm,
  });

  // ── Centralized toast queue (replaces per-action useFlashStatus) ────
  const { toasts, showToast } = useToastQueue();

  const handleCopyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(zplCode);
      showToast('success', 'ZPL copied to clipboard');
    } catch {
      // Clipboard API can reject when the page is not focused or in an insecure context.
      showToast('error', 'Clipboard copy failed');
    }
  }, [zplCode, showToast]);

  const handleDownloadZpl = useCallback(() => {
    try {
      downloadTextFile(zplCode, 'visual-zpl-label.zpl');
      showToast('success', 'ZPL file exported');
    } catch {
      showToast('error', 'Download failed');
    }
  }, [zplCode, showToast]);

  /**
   * 코드 패널에 붙여넣은 ZPL 을 캔버스 객체로 가져온다.
   *
   * 가져오지 못한 명령(박스·이미지 등)은 토스트로 알린다 — 조용히 사라지면
   * 사용자가 손실을 눈치채지 못한 채 저장하게 되기 때문이다.
   */
  const handleImportZplToCanvas = useCallback(() => {
    const parsed = importZpl(zplCode, doc.dpmm ?? 8);

    if (parsed.objects.length === 0) {
      showToast(
        'error',
        parsed.warnings.length > 0
          ? `가져올 수 있는 객체가 없습니다 — ${parsed.warnings.join(', ')}는 편집 객체로 표현할 수 없습니다`
          : '가져올 객체를 찾지 못했습니다',
      );
      return;
    }

    // 편집기의 전역 id 카운터로 다시 매긴다 — 임포터가 자체 번호를 쓰면
    // 가져온 뒤 새로 추가하는 객체와 id 가 충돌할 수 있다.
    const idPrefix: Record<LabelObject['type'], string> = {
      text: 'text',
      barcode: 'barcode',
      qrcode: 'qr',
      image: 'image',
      table: 'table',
    };
    const objects = parsed.objects.map(obj => ({
      ...obj,
      id: nextId(idPrefix[obj.type]),
    })) as LabelObject[];

    setDoc(d => ({
      ...d,
      widthMm: parsed.widthMm ?? d.widthMm,
      heightMm: parsed.heightMm ?? d.heightMm,
      objects,
    }));
    setSelectedId(null);
    setZplDraft(null); // 이제 캔버스가 진실의 원천 — 다시 생성 모드로 돌아간다.

    if (parsed.warnings.length > 0) {
      showToast(
        'error',
        `${objects.length}개 객체를 가져왔습니다. 제외됨: ${parsed.warnings.join(', ')}`,
      );
    } else {
      showToast('success', `${objects.length}개 객체를 편집기로 가져왔습니다`);
    }
  }, [zplCode, doc.dpmm, showToast]);

  // ── Zebra Browser Print integration (local desktop agent) ──────────
  const {
    agentStatus,
    devices: zebraDevices,
    print: sendToZebra,
    printStatus,
    lastError: printError,
  } = useBrowserPrint();

  const canPrint =
    agentStatus === 'available' &&
    zebraDevices.length > 0 &&
    printStatus !== 'sending';

  const printButtonTooltip =
    agentStatus !== 'available'
      ? 'Zebra Browser Print agent not running'
      : zebraDevices.length === 0
        ? 'No Zebra printer connected'
        : 'Send the generated ZPL to the connected Zebra printer';

  const handlePrintToZebra = useCallback(async () => {
    await sendToZebra(zplCode);
  }, [sendToZebra, zplCode]);

  // Mirror terminal print events into the centralized toast queue. The ref
  // guard ensures we only toast on the *transition* into success/error so the
  // 3s auto-reset back to 'idle' does not re-fire toasts.
  const lastPrintStatusRef = useRef(printStatus);
  useEffect(() => {
    if (lastPrintStatusRef.current !== printStatus) {
      if (printStatus === 'success') {
        showToast('success', 'Print success!');
      } else if (printStatus === 'error') {
        showToast('error', printError ?? 'Printer not found');
      }
      lastPrintStatusRef.current = printStatus;
    }
  }, [printStatus, printError, showToast]);

  // ── Batch data modal (dynamic variable substitution) ───────────────
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isNewTableOpen, setIsNewTableOpen] = useState(false);
  // Lifted from BatchDataModal so presets can hydrate the rows in one shot.
  const [batchDataRows, setBatchDataRows] = useState<DataRow[]>([{}]);
  const detectedVariableCount = useMemo(
    () => extractVariables(doc).length,
    [doc],
  );

  // ── Quick Presets ────────────────────────────────────────────────────
  const handleLoadPreset = useCallback(
    (preset: LabelPreset) => {
      const canvasIsEmpty = doc.objects.length === 0;
      if (!canvasIsEmpty) {
        const proceed = window.confirm(
          'Loading a preset will replace your current design. Proceed?',
        );
        if (!proceed) {
          showToast('warning', 'Preset load cancelled');
          return;
        }
      }
      // Deep-clone so the user-edited doc cannot mutate the preset constant.
      const documentClone: LabelDocument = {
        ...preset.document,
        objects: preset.document.objects.map(o => ({ ...o })),
      };
      setDoc(documentClone);
      setBatchDataRows(preset.sampleDataRows.map(row => ({ ...row })));
      setSelectedId(null);
      showToast(
        'success',
        `Loaded preset: ${preset.name} · ${preset.sampleDataRows.length} sample row${preset.sampleDataRows.length === 1 ? '' : 's'} ready`,
      );
    },
    [doc.objects.length, showToast],
  );

  // ── 1) Initialize the fabric canvas ─────────────────────────────────
  useEffect(() => {
    if (!canvasElRef.current) return;

    const canvas = new fabric.Canvas(canvasElRef.current, {
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      selection: true,
    });
    canvas.setDimensions({
      width: (INITIAL_DOC.widthMm ?? 100) * PX_PER_MM,
      height: (INITIAL_DOC.heightMm ?? 50) * PX_PER_MM,
    });
    canvasRef.current = canvas;

    const handleModified = (e: { target?: fabric.FabricObject }) => {
      if (applyingRef.current) return;
      const target = e.target as LabelNode | undefined;
      if (!target?.labelId) return;
      const id = target.labelId;
      setDoc(prev => ({
        ...prev,
        objects: prev.objects.map(o =>
          o.id === id ? nodeToModelPatch(o, target) : o,
        ),
      }));
    };

    const handleSelect = (e: { selected?: fabric.FabricObject[] }) => {
      const sel = e.selected?.[0] as LabelNode | undefined;
      setSelectedId(sel?.labelId ?? null);
    };

    canvas.on('object:modified', handleModified);
    canvas.on('selection:created', handleSelect);
    canvas.on('selection:updated', handleSelect);
    canvas.on('selection:cleared', () => setSelectedId(null));

    return () => {
      canvas.dispose();
      canvasRef.current = null;
      nodesRef.current.clear();
    };
  }, []);

  // ── 2) Sync canvas dimensions when the label size changes ───────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || doc.widthMm == null || doc.heightMm == null) return;
    canvas.setDimensions({
      width: doc.widthMm * PX_PER_MM,
      height: doc.heightMm * PX_PER_MM,
    });
    canvas.requestRenderAll();
  }, [doc.widthMm, doc.heightMm]);

  // ── 3) Reconcile doc.objects ↔ fabric nodes ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    applyingRef.current = true;
    let cancelled = false;

    // Unified async factory — sync types resolve synchronously through Promise.resolve.
    const buildNode = (obj: LabelObject): Promise<LabelNode> =>
      obj.type === 'image'
        ? createImageNode(obj)
        : Promise.resolve(createFabricNode(obj));

    try {
      const nodes = nodesRef.current;
      const currentIds = new Set(doc.objects.map(o => o.id));

      // (a) Remove nodes whose model is gone.
      for (const [id, node] of nodes) {
        if (!currentIds.has(id)) {
          canvas.remove(node);
          nodes.delete(id);
        }
      }

      // (b) Add or update.
      for (const obj of doc.objects) {
        const existing = nodes.get(obj.id);
        if (!existing) {
          void buildNode(obj).then(node => {
            if (cancelled || !canvasRef.current) return;
            node.labelId = obj.id;
            node.labelSource = obj;
            nodesRef.current.set(obj.id, node);
            canvasRef.current.add(node);
            canvasRef.current.requestRenderAll();
          });
          continue;
        }
        const prev = existing.labelSource!;
        if (shouldRecreate(prev, obj)) {
          const wasActive = canvas.getActiveObject() === existing;
          canvas.remove(existing);
          nodes.delete(obj.id);
          void buildNode(obj).then(node => {
            if (cancelled || !canvasRef.current) return;
            node.labelId = obj.id;
            node.labelSource = obj;
            nodesRef.current.set(obj.id, node);
            canvasRef.current.add(node);
            if (wasActive) canvasRef.current.setActiveObject(node);
            canvasRef.current.requestRenderAll();
          });
        } else {
          applyModelToNode(existing, obj);
          existing.labelSource = obj;
        }
      }

      canvas.requestRenderAll();
    } finally {
      applyingRef.current = false;
    }

    return () => {
      cancelled = true;
    };
  }, [doc.objects]);

  // ── 3.5) Encode image bitmaps into ZPL ^GFA payloads as they appear ─
  //
  // Runs whenever the image list or printer dpmm changes. For each image whose
  // cached `encoded.key` no longer matches its current parameters, kicks off an
  // async raster→1bit→hex pass and writes the result back into state. A stale
  // encode (e.g. the user resized again mid-flight) is detected on commit and
  // dropped so the model never regresses.
  useEffect(() => {
    const dpmm = doc.dpmm ?? 8;
    const stale = doc.objects.filter(
      (o): o is ImageObject => {
        if (o.type !== 'image') return false;
        const currentKey = computeEncodingKey({
          sourceDataUrl: o.sourceDataUrl,
          widthMm: o.widthMm,
          heightMm: o.heightMm,
          threshold: o.threshold ?? 128,
          dpmm,
        });
        return !o.encoded || o.encoded.key !== currentKey;
      },
    );
    let cancelled = false;

    for (const obj of stale) {
      const targetKey = computeEncodingKey({
        sourceDataUrl: obj.sourceDataUrl,
        widthMm: obj.widthMm,
        heightMm: obj.heightMm,
        threshold: obj.threshold ?? 128,
        dpmm,
      });
      const widthDots = Math.max(1, Math.round(obj.widthMm * dpmm));
      const heightDots = Math.max(1, Math.round(obj.heightMm * dpmm));

      void imageToZpl(obj.sourceDataUrl, {
        widthDots,
        heightDots,
        threshold: obj.threshold ?? 128,
      })
        .then(result => {
          if (cancelled) return;
          setDoc(d => {
            const currentDpmm = d.dpmm ?? 8;
            const currentObj = d.objects.find(o => o.id === obj.id);
            if (!currentObj || currentObj.type !== 'image') return d;
            const currentKey = computeEncodingKey({
              sourceDataUrl: currentObj.sourceDataUrl,
              widthMm: currentObj.widthMm,
              heightMm: currentObj.heightMm,
              threshold: currentObj.threshold ?? 128,
              dpmm: currentDpmm,
            });
            if (currentKey !== targetKey) return d;
            return {
              ...d,
              objects: d.objects.map(o =>
                o.id === obj.id && o.type === 'image'
                  ? {
                      ...o,
                      encoded: {
                        key: targetKey,
                        hexData: result.hexData,
                        bytesPerRow: result.bytesPerRow,
                        totalBytes: result.totalBytes,
                        widthDots: result.widthDots,
                        heightDots: result.heightDots,
                      },
                    }
                  : o,
              ),
            };
          });
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn('Image encoding failed:', err);
        });
    }

    // Encode any table cells whose imageSourceDataUrl is set but whose
    // imageEncoded is missing or stale (based on the current cell box).
    for (const obj of doc.objects) {
      if (obj.type !== 'table') continue;
      const tableObj = obj as TableObject;
      for (const cell of tableObj.cells) {
        if (!cell.imageSourceDataUrl) continue;
        // Compute the cell's current outer rect to size the bitmap.
        const colXs: number[] = [0];
        for (const w of tableObj.colWidthsMm) colXs.push(colXs[colXs.length - 1] + w);
        const rowYs: number[] = [0];
        for (const h of tableObj.rowHeightsMm) rowYs.push(rowYs[rowYs.length - 1] + h);
        const merge = tableObj.merges.find(
          m =>
            cell.row >= m.row &&
            cell.row < m.row + m.rowSpan &&
            cell.col >= m.col &&
            cell.col < m.col + m.colSpan,
        );
        const topLeftRow = merge ? merge.row : cell.row;
        const topLeftCol = merge ? merge.col : cell.col;
        if (cell.row !== topLeftRow || cell.col !== topLeftCol) continue;
        const rs = merge ? merge.rowSpan : 1;
        const cs = merge ? merge.colSpan : 1;
        let cellWMm = 0;
        for (let i = 0; i < cs; i++) cellWMm += tableObj.colWidthsMm[topLeftCol + i] ?? 0;
        let cellHMm = 0;
        for (let i = 0; i < rs; i++) cellHMm += tableObj.rowHeightsMm[topLeftRow + i] ?? 0;
        const padMm = cell.paddingMm ?? 1;
        const innerWMm = Math.max(1, cellWMm - 2 * padMm);
        const innerHMm = Math.max(1, cellHMm - 2 * padMm);
        const targetKey = computeEncodingKey({
          sourceDataUrl: cell.imageSourceDataUrl,
          widthMm: innerWMm,
          heightMm: innerHMm,
          threshold: 128,
          dpmm,
        });
        if (cell.imageEncoded && cell.imageEncoded.key === targetKey) continue;
        const widthDots = Math.max(1, Math.round(innerWMm * dpmm));
        const heightDots = Math.max(1, Math.round(innerHMm * dpmm));
        void imageToZpl(cell.imageSourceDataUrl, { widthDots, heightDots, threshold: 128 })
          .then(result => {
            if (cancelled) return;
            setDoc(d => ({
              ...d,
              objects: d.objects.map(o => {
                if (o.id !== obj.id || o.type !== 'table') return o;
                return {
                  ...o,
                  cells: (o as TableObject).cells.map(c => {
                    if (c.row !== cell.row || c.col !== cell.col) return c;
                    return {
                      ...c,
                      imageEncoded: {
                        key: targetKey,
                        hexData: result.hexData,
                        bytesPerRow: result.bytesPerRow,
                        totalBytes: result.totalBytes,
                        widthDots: result.widthDots,
                        heightDots: result.heightDots,
                      },
                    };
                  }),
                };
              }),
            }));
          })
          .catch(err => {
            // eslint-disable-next-line no-console
            console.warn('Cell image encoding failed:', err);
          });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [doc.objects, doc.dpmm]);

  // ── 4) Mirror selection state to the canvas ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!selectedId) {
      if (canvas.getActiveObject()) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      }
      return;
    }
    const node = nodesRef.current.get(selectedId);
    if (node && canvas.getActiveObject() !== node) {
      canvas.setActiveObject(node);
      canvas.requestRenderAll();
    }
  }, [selectedId]);

  // ── 5) Object creation handlers ─────────────────────────────────────
  /** 타입별 기본 위치 + 기존 객체 수에 따른 계단식 오프셋. */
  const originFor = (base: { x: number; y: number }) =>
    cascadeOrigin(base, doc.objects.length, doc.widthMm ?? 100, doc.heightMm ?? 50);

  const addText = () => {
    const id = nextId('text');
    const obj: TextObject = {
      id,
      type: 'text',
      ...originFor({ x: 5, y: 5 }),
      fontHeight: 4,
      data: 'Sample Text',
    };
    setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
    setSelectedId(id);
  };

  const addBarcode = () => {
    const id = nextId('barcode');
    const obj: BarcodeObject = {
      id,
      type: 'barcode',
      ...originFor({ x: 5, y: 15 }),
      height: 12,
      moduleWidth: 2,
      printInterpretationLine: true,
      data: '12345678',
    };
    setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
    setSelectedId(id);
  };

  const addQrCode = () => {
    const id = nextId('qr');
    const obj: QrCodeObject = {
      id,
      type: 'qrcode',
      ...originFor({ x: 65, y: 5 }),
      magnification: 4,
      errorCorrection: 'M',
      data: 'https://visualzpl.io',
    };
    setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
    setSelectedId(id);
  };

  // ── Table insertion modal ───────────────────────────────────────────
  const handleAddTableClick = () => setIsNewTableOpen(true);

  const handleConfirmNewTable = (rows: number, cols: number) => {
    setIsNewTableOpen(false);
    const labelW = doc.widthMm ?? 100;
    const labelH = doc.heightMm ?? 50;
    const colWidthMm = Math.max(5, (labelW * 0.5) / cols);
    const rowHeightMm = Math.max(5, (labelH * 0.5) / rows);
    const id = nextId('table');
    const obj: TableObject = {
      id,
      type: 'table',
      ...cascadeOrigin({ x: 5, y: 5 }, doc.objects.length, labelW, labelH),
      data: `Table ${rows}×${cols}`,
      rowHeightsMm: Array.from({ length: rows }, () => rowHeightMm),
      colWidthsMm: Array.from({ length: cols }, () => colWidthMm),
      borderDots: 2,
      cells: [],
      merges: [],
    };
    setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
    setSelectedId(id);
  };

  // ── Image upload: hidden <input> triggered from the toolbar button ──
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so the user can re-select the same file later.
      event.target.value = '';
      if (!file) return;

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const natural = await measureImage(dataUrl);

        // Default print size: fit at most half the label width while
        // preserving the source aspect ratio.
        const labelWidthMm = doc.widthMm ?? 100;
        const dpmm = doc.dpmm ?? 8;
        const maxWidthMm = Math.max(10, labelWidthMm * 0.5);
        const aspect = natural.width / natural.height;
        const widthMm = Math.min(maxWidthMm, natural.width / dpmm);
        const heightMm = Math.max(1, widthMm / aspect);

        const id = nextId('image');
        const obj: ImageObject = {
          id,
          type: 'image',
          ...cascadeOrigin(
            { x: 5, y: 5 },
            doc.objects.length,
            labelWidthMm,
            doc.heightMm ?? 50,
          ),
          widthMm,
          heightMm,
          sourceDataUrl: dataUrl,
          threshold: 128,
          data: file.name,
        };
        setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
        setSelectedId(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Failed to import image:', err);
      }
    },
    [doc.widthMm, doc.dpmm],
  );

  // ── 6) Update / delete a single object via the property panel ───────
  const updateObject = useCallback(
    (id: string, patch: Partial<LabelObject>) => {
      setDoc(d => ({
        ...d,
        objects: d.objects.map(o =>
          o.id === id ? ({ ...o, ...patch } as LabelObject) : o,
        ),
      }));
    },
    [],
  );

  const deleteObject = (id: string) => {
    setDoc(d => ({ ...d, objects: d.objects.filter(o => o.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };

  // ── 7) Change overall label dimensions ──────────────────────────────
  //
  // Before committing a resize we estimate which existing objects would fall
  // outside the new bounds and ask the user to confirm — preventing them
  // from accidentally pushing artwork off the printable area.
  const updateLabelSize = (
    patch: Partial<Pick<LabelDocument, 'widthMm' | 'heightMm'>>,
  ) => {
    const nextWidth = patch.widthMm ?? doc.widthMm ?? 100;
    const nextHeight = patch.heightMm ?? doc.heightMm ?? 50;
    const outOfBounds = doc.objects.filter(o =>
      isObjectOutOfBounds(o, nextWidth, nextHeight),
    );
    if (outOfBounds.length > 0) {
      const proceed = window.confirm(
        `${outOfBounds.length} element${outOfBounds.length === 1 ? '' : 's'} might be out of bounds with the new label size. Proceed?`,
      );
      if (!proceed) {
        showToast('warning', 'Label resize cancelled');
        return;
      }
    }
    setDoc(d => ({ ...d, ...patch }));
  };

  const selected = doc.objects.find(o => o.id === selectedId) ?? null;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-slate-100">
      <header className="px-6 py-3 bg-white/90 backdrop-blur border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white text-[13px] font-bold shadow-sm shadow-blue-600/30 select-none">
              Z
            </span>
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-800">
              VisualZPL{' '}
              <span className="text-slate-400 font-normal">Label Editor</span>
            </h1>
          </div>
          <PresetMenu
            presets={LABEL_PRESETS}
            onSelect={handleLoadPreset}
          />
        </div>
        <div className="flex items-center gap-4 text-sm text-slate-600">
          <SizeInput
            label="Width (mm)"
            value={doc.widthMm}
            onChange={v => updateLabelSize({ widthMm: v })}
          />
          <SizeInput
            label="Height (mm)"
            value={doc.heightMm}
            onChange={v => updateLabelSize({ heightMm: v })}
          />
          <span className="text-xs text-slate-400">
            {doc.dpmm ?? 8} dpmm · Display scale {PX_PER_MM}px/mm
          </span>
        </div>
      </header>

      {/* ── Top Control Bar: client-side export actions ────────────── */}
      <div className="px-6 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-1">
            Export
          </span>
          <button
            type="button"
            onClick={handleCopyToClipboard}
            title="Copy the generated ZPL string to your clipboard"
            className="btn-secondary"
          >
            <ClipboardIcon />
            Copy to Clipboard
          </button>
          <button
            type="button"
            onClick={handleDownloadZpl}
            title="Download the generated ZPL as a .zpl file"
            className="btn-primary"
          >
            <DownloadIcon />
            Download ZPL File
          </button>

          <button
            type="button"
            onClick={() => setIsBatchModalOpen(true)}
            title={
              detectedVariableCount > 0
                ? `Open batch data editor (${detectedVariableCount} variable${detectedVariableCount === 1 ? '' : 's'} detected)`
                : 'Open batch data editor — add {{variable}} placeholders in your label first'
            }
            className="btn-secondary"
          >
            <TableIcon />
            Batch Data
            {detectedVariableCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded">
                {detectedVariableCount}
              </span>
            )}
          </button>

          {/* Visual separator between client-side export and hardware print */}
          <span
            aria-hidden="true"
            className="inline-block w-px h-6 bg-slate-200 mx-1"
          />

          <button
            type="button"
            onClick={handlePrintToZebra}
            disabled={!canPrint}
            title={printButtonTooltip}
            className="btn text-white bg-emerald-600 shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <PrinterIcon />
            {printStatus === 'sending' ? 'Sending…' : 'Print to Zebra'}
          </button>
        </div>
        <div
          aria-live="polite"
          className="flex items-center gap-2 text-xs font-medium min-h-[1.5rem] flex-wrap justify-end max-w-[55%]"
        >
          {toasts.map(toast => (
            <ToastBadge key={toast.id} toast={toast} />
          ))}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ── Left toolbar ──────────────────────────────────── */}
        <aside className="w-52 bg-white border-r border-slate-200 p-4 flex flex-col gap-2 shrink-0">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Tools
          </h2>
          <ToolButton onClick={addText} icon="T" label="Add Text" />
          <ToolButton onClick={addBarcode} icon="‖‖‖" label="Add Barcode" />
          <ToolButton onClick={addQrCode} icon="▣" label="Add QR Code" />
          <ToolButton
            onClick={handleAddImageClick}
            icon={<ImageIcon size={16} />}
            label="Add Image"
          />
          {/* Hidden input — opened programmatically by the Add Image button. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png, image/jpeg"
            className="hidden"
            onChange={handleImageFileSelected}
          />
          <ToolButton
            onClick={handleAddTableClick}
            icon={<TableIcon size={16} />}
            label="Add Table"
          />

          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-6 mb-1">
            Layers
          </h2>
          <ul className="flex-1 space-y-1 overflow-y-auto">
            {doc.objects.length === 0 ? (
              <li className="mt-1 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs leading-relaxed text-slate-400">
                No objects yet.
                <br />
                Add one from the tools above.
              </li>
            ) : (
              doc.objects.map(o => (
                <li
                  key={o.id}
                  onClick={() => setSelectedId(o.id)}
                  className={`px-2 py-1.5 text-sm rounded-lg cursor-pointer flex items-center gap-2 transition-colors ${
                    selectedId === o.id
                      ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span className="font-mono text-xs w-5 text-center">
                    {o.type === 'text'
                      ? 'T'
                      : o.type === 'barcode'
                        ? '‖'
                        : o.type === 'qrcode'
                          ? '▣'
                          : o.type === 'image'
                            ? 'I'
                            : '▦'}
                  </span>
                  <span className="truncate">{o.id}</span>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* ── Center canvas ────────────────────────────────── */}
        <main
          className="flex-1 flex items-center justify-center overflow-auto p-8"
          style={{
            backgroundColor: '#e9edf4',
            backgroundImage:
              'radial-gradient(rgba(100,116,139,0.28) 1px, transparent 1px)',
            backgroundSize: '16px 16px',
          }}
        >
          <div className="relative bg-white shadow-soft ring-1 ring-slate-200/80">
            <canvas ref={canvasElRef} />
            {selected?.type === 'table' && (
              <TableOverlay
                table={selected}
                selection={cellSelection}
                onSelectionChange={setCellSelection}
                onMove={(x, y) => {
                  if (selected.type !== 'table') return;
                  updateObject(selected.id, { x, y });
                }}
                onRowResize={(idx, mm) => {
                  if (selected.type !== 'table') return;
                  const next = [...selected.rowHeightsMm];
                  next[idx] = mm;
                  updateObject(selected.id, { rowHeightsMm: next });
                }}
                onColResize={(idx, mm) => {
                  if (selected.type !== 'table') return;
                  const next = [...selected.colWidthsMm];
                  next[idx] = mm;
                  updateObject(selected.id, { colWidthsMm: next });
                }}
              />
            )}
          </div>
        </main>

        {/* ── Right property panel ─────────────────────────── */}
        <aside className="w-80 bg-white border-l border-slate-200 p-4 overflow-y-auto shrink-0">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Properties
          </h2>
          {selected ? (
            selected.type === 'table' ? (
              cellSelection.kind === 'range' &&
              (cellSelection.startRow !== cellSelection.endRow ||
                cellSelection.startCol !== cellSelection.endCol) ? (
                <RangeMergeForm
                  table={selected}
                  range={cellSelection}
                  onTableChange={patch => updateObject(selected.id, patch)}
                  onClearSelection={() => setCellSelection({ kind: 'none' })}
                />
              ) : cellSelection.kind === 'single' ? (
                <CellPropertyForm
                  table={selected}
                  row={cellSelection.row}
                  col={cellSelection.col}
                  onTableChange={patch => updateObject(selected.id, patch)}
                />
              ) : (
                <TablePropertyForm
                  table={selected}
                  onChange={patch => updateObject(selected.id, patch)}
                  onDelete={() => deleteObject(selected.id)}
                />
              )
            ) : (
              <PropertyForm
                object={selected}
                onChange={patch => updateObject(selected.id, patch)}
                onDelete={() => deleteObject(selected.id)}
              />
            )
          ) : (
            <div className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-8 text-center text-sm leading-relaxed text-slate-400">
              Select an object on the canvas
              <br />
              <span className="text-xs">to edit its properties.</span>
            </div>
          )}
        </aside>
      </div>

      {/* ── Bottom: ZPL output (left) + Live Preview (right) ────────── */}
      <ResizableBottomPanel
        height={bottomHeight}
        onHeightChange={setBottomHeight}
        collapsed={bottomCollapsed}
        onToggleCollapse={() => setBottomCollapsed(c => !c)}
      >
        <div className="w-1/2 bg-slate-900 text-slate-100 flex flex-col border-r border-slate-700">
          <header className="px-4 py-2 border-b border-slate-700 flex items-center justify-between gap-2">
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-2">
              ZPL Code
              {isManualZpl ? (
                <span className="normal-case tracking-normal text-amber-400">· 수동 편집됨</span>
              ) : (
                <span className="normal-case tracking-normal text-slate-500">(Live)</span>
              )}
            </span>
            <div className="flex items-center gap-1">
              {isManualZpl && (
                <>
                  <button
                    type="button"
                    onClick={handleImportZplToCanvas}
                    title="붙여넣은 ZPL 을 캔버스 객체로 가져와 마우스로 편집합니다 (박스·이미지 등 일부 명령은 편집 객체로 표현할 수 없어 제외됩니다)"
                    className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:text-white px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
                  >
                    편집기로 가져오기
                  </button>
                  <button
                    type="button"
                    onClick={() => setZplDraft(null)}
                    title="캔버스에서 생성된 ZPL 로 되돌리기 (수동 편집 내용은 사라집니다)"
                    className="inline-flex items-center gap-1 text-xs text-amber-300 hover:text-white px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
                  >
                    재생성으로 되돌리기
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleCopyToClipboard}
                title="Copy ZPL to clipboard"
                className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
              >
                <ClipboardIcon size={12} />
                Copy Code
              </button>
            </div>
          </header>
          {/* Editable: paste/edit raw ZPL → live preview follows the draft.
              Typing switches this panel from generated (Live) to manual mode. */}
          <textarea
            value={zplCode}
            onChange={e => setZplDraft(e.target.value)}
            spellCheck={false}
            wrap="off"
            aria-label="ZPL code editor"
            placeholder="여기에 외부 ZPL 을 붙여넣거나 직접 편집하면 오른쪽 미리보기에 바로 반영됩니다…"
            className="flex-1 p-4 font-mono text-xs text-emerald-300 bg-slate-900 whitespace-pre overflow-auto resize-none outline-none border-0 placeholder:text-slate-600 focus:ring-1 focus:ring-inset focus:ring-emerald-500/40"
          />
        </div>

        <div className="w-1/2 bg-white flex flex-col">
          <LivePreviewPanel
            previewUrl={previewUrl}
            isLoading={isLoading}
            error={previewError}
          />
        </div>
      </ResizableBottomPanel>

      {/* Always-mounted modal — toggled via `isOpen` so dataRows persist. */}
      <BatchDataModal
        isOpen={isBatchModalOpen}
        onClose={() => setIsBatchModalOpen(false)}
        doc={doc}
        dataRows={batchDataRows}
        onDataRowsChange={setBatchDataRows}
        onPrintBatch={sendToZebra}
        canPrint={canPrint}
        isPrinting={printStatus === 'sending'}
        printDisabledReason={printButtonTooltip}
      />
      <NewTableModal
        isOpen={isNewTableOpen}
        onClose={() => setIsNewTableOpen(false)}
        onConfirm={handleConfirmNewTable}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// UI helper components
// ──────────────────────────────────────────────────────────────────────────

function ToolButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-2.5 w-full px-2.5 py-2 text-sm font-medium text-slate-700 bg-white rounded-lg ring-1 ring-inset ring-slate-200 shadow-sm transition-all duration-150 hover:bg-blue-50/60 hover:text-blue-700 hover:ring-blue-300 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
    >
      <span className="w-8 h-8 shrink-0 inline-flex items-center justify-center font-mono text-xs text-slate-500 bg-slate-100 rounded-md transition-colors group-hover:bg-blue-100 group-hover:text-blue-600">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <input
        type="number"
        min={1}
        className="w-20 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-800 shadow-sm transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/25"
        value={value ?? ''}
        onChange={e => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Render-status badge + image area + skeleton/spinner/error states. */
function LivePreviewPanel({
  previewUrl,
  isLoading,
  error,
}: {
  previewUrl: string | null;
  isLoading: boolean;
  error: string | null;
}) {
  const statusLabel = error
    ? 'Error'
    : isLoading
      ? 'Syncing…'
      : previewUrl
        ? 'Ready'
        : 'Waiting';

  const statusClass = error
    ? 'text-red-600'
    : isLoading
      ? 'text-amber-500'
      : previewUrl
        ? 'text-emerald-600'
        : 'text-slate-400';

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-2 border-b border-slate-200 flex items-center justify-between bg-slate-50">
        <span className="text-xs font-mono uppercase tracking-wider text-slate-500">
          Live Preview
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs font-mono ${statusClass}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {statusLabel}
        </span>
      </header>

      <div className="flex-1 relative bg-slate-100 flex items-center justify-center overflow-hidden">
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Rendered label preview"
            className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${
              isLoading ? 'opacity-50' : 'opacity-100'
            }`}
          />
        )}

        {!previewUrl && !isLoading && !error && (
          <p className="text-sm text-slate-400">Awaiting first render…</p>
        )}

        {!previewUrl && isLoading && <SkeletonLoader />}

        {previewUrl && isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Spinner />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-3 rounded-lg bg-red-50 px-3 py-2 ring-1 ring-red-200 shadow-sm animate-fade-in"
          >
            <div className="text-xs font-semibold text-red-800 mb-0.5">
              ZPL Render Error
            </div>
            <div className="text-xs font-mono text-red-700 break-words">
              {error}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-9 h-9 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
  );
}

function SkeletonLoader() {
  return (
    <div className="w-full h-full p-6">
      <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 rounded animate-pulse" />
    </div>
  );
}

function PropertyForm({
  object,
  onChange,
  onDelete,
}: {
  object: LabelObject;
  onChange: (patch: Partial<LabelObject>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-3">
      <ReadOnlyField label="ID" value={object.id} />
      <ReadOnlyField label="Type" value={object.type} />

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="X (mm)"
          value={object.x}
          step={0.5}
          onChange={v => onChange({ x: v })}
        />
        <NumberField
          label="Y (mm)"
          value={object.y}
          step={0.5}
          onChange={v => onChange({ y: v })}
        />
      </div>

      {/* ^GFA does not support orientation parameters, so hide rotation for images. */}
      {object.type !== 'image' && (
        <SelectField
          label="Rotation"
          value={object.rotation ?? 'N'}
          onChange={v => onChange({ rotation: v as ZplRotation })}
          options={[
            { value: 'N', label: '0°' },
            { value: 'R', label: '90°' },
            { value: 'I', label: '180°' },
            { value: 'B', label: '270°' },
          ]}
        />
      )}

      {object.type === 'image' ? (
        <ReadOnlyField label="Filename" value={object.data} />
      ) : (
        <TextField
          label="Data"
          value={object.data}
          multiline
          onChange={v => onChange({ data: v })}
        />
      )}

      {object.type === 'text' && (
        <NumberField
          label="Font Height (mm)"
          value={object.fontHeight}
          step={0.5}
          min={1}
          onChange={v => onChange({ fontHeight: v } as Partial<TextObject>)}
        />
      )}

      {object.type === 'barcode' && (
        <>
          <NumberField
            label="Height (mm)"
            value={object.height}
            step={0.5}
            min={1}
            onChange={v => onChange({ height: v } as Partial<BarcodeObject>)}
          />
          <NumberField
            label="Module Width (dot)"
            value={object.moduleWidth ?? 2}
            min={1}
            max={10}
            onChange={v =>
              onChange({ moduleWidth: v } as Partial<BarcodeObject>)
            }
          />
        </>
      )}

      {object.type === 'qrcode' && (
        <>
          <NumberField
            label="Magnification"
            value={object.magnification ?? 5}
            min={1}
            max={10}
            onChange={v =>
              onChange({ magnification: v } as Partial<QrCodeObject>)
            }
          />
          <SelectField
            label="Error Correction"
            value={object.errorCorrection ?? 'M'}
            onChange={v =>
              onChange({
                errorCorrection: v as QrErrorCorrection,
              } as Partial<QrCodeObject>)
            }
            options={[
              { value: 'L', label: 'L (~7%)' },
              { value: 'M', label: 'M (~15%)' },
              { value: 'Q', label: 'Q (~25%)' },
              { value: 'H', label: 'H (~30%)' },
            ]}
          />
        </>
      )}

      {object.type === 'image' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Width (mm)"
              value={object.widthMm}
              step={1}
              min={1}
              onChange={v =>
                onChange({ widthMm: v } as Partial<ImageObject>)
              }
            />
            <NumberField
              label="Height (mm)"
              value={object.heightMm}
              step={1}
              min={1}
              onChange={v =>
                onChange({ heightMm: v } as Partial<ImageObject>)
              }
            />
          </div>
          <NumberField
            label="Threshold (0-255)"
            value={object.threshold ?? 128}
            step={1}
            min={0}
            max={255}
            onChange={v =>
              onChange({ threshold: v } as Partial<ImageObject>)
            }
          />
          {object.encoded ? (
            <p className="text-xs text-slate-500 font-mono">
              Encoded {object.encoded.widthDots}×{object.encoded.heightDots} dots
              {' · '}
              {(object.encoded.totalBytes / 1024).toFixed(1)} KB
            </p>
          ) : (
            <p className="text-xs text-amber-600 font-mono">
              Encoding bitmap…
            </p>
          )}
        </>
      )}

      <button
        onClick={onDelete}
        className="w-full mt-4 px-3 py-2 text-sm text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200 transition-colors"
      >
        Delete
      </button>
    </div>
  );
}

/**
 * Quick Presets dropdown. Renders a button that toggles a popover list of
 * predefined layouts. Closes on outside click, on Escape, and after a
 * preset is selected. Selection delegates to `onSelect` which performs the
 * (optionally confirmed) hydration of the document and batch data rows.
 */
function PresetMenu({
  presets,
  onSelect,
}: {
  presets: LabelPreset[];
  onSelect: (preset: LabelPreset) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        title="Load a predefined label layout"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-violet-700 bg-violet-50 rounded-lg ring-1 ring-inset ring-violet-200 shadow-sm transition-all hover:bg-violet-100 active:scale-[0.98]"
      >
        <SparkleIcon />
        Quick Presets
        <ChevronDownIcon />
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label="Quick Presets"
          className="absolute top-full mt-2 left-0 w-80 bg-white rounded-xl ring-1 ring-slate-200 shadow-pop z-20 overflow-hidden animate-pop-in"
        >
          <ul className="divide-y divide-slate-100">
            {presets.map(preset => (
              <li key={preset.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(preset);
                    setIsOpen(false);
                  }}
                  className="w-full text-left px-4 py-2.5 hover:bg-violet-50 focus:bg-violet-50 focus:outline-none transition-colors"
                >
                  <div className="text-sm font-medium text-slate-800">
                    {preset.name}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {preset.description}
                  </div>
                  <div className="text-xs text-violet-600 mt-1">
                    {preset.document.objects.length} elements ·{' '}
                    {preset.sampleDataRows.length} sample row
                    {preset.sampleDataRows.length === 1 ? '' : 's'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Severity-colored pill rendered inside the Top Control Bar's aria-live
 * region. Errors carry `role="alert"` so they are announced immediately by
 * assistive tech; success/warning use the implicit polite priority of the
 * surrounding region.
 */
function ToastBadge({ toast }: { toast: Toast }) {
  const styleBySeverity: Record<Toast['severity'], string> = {
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span
      role={toast.severity === 'error' ? 'alert' : undefined}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border whitespace-nowrap ${styleBySeverity[toast.severity]}`}
    >
      {toast.message}
    </span>
  );
}
