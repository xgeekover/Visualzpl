/**
 * VisualZPL 변환 엔진 검증용 샘플
 *
 *   ts-node src/example.ts    또는    npx tsx src/example.ts
 */

import { ZplBuilder } from './ZplBuilder';
import { LabelDocument } from './types';

/** 50mm × 60mm 라벨 한 장 (203 DPI 기준) */
const sample: LabelDocument = {
  unit: 'mm',
  dpmm: 8,           // 203 DPI
  widthMm: 50,
  heightMm: 60,
  objects: [
    {
      id: 'title',
      type: 'text',
      x: 5,
      y: 5,
      fontHeight: 4,   // 4mm ≈ 32 dot
      data: 'VisualZPL',
    },
    {
      id: 'sku-barcode',
      type: 'barcode',
      x: 5,
      y: 15,
      height: 10,      // 10mm ≈ 80 dot
      moduleWidth: 2,
      printInterpretationLine: true,
      data: 'ABC-12345',
    },
    {
      id: 'detail-qr',
      type: 'qrcode',
      x: 5,
      y: 30,
      magnification: 4,
      errorCorrection: 'M',
      data: 'https://visualzpl.io/v/12345',
    },
  ],
};

const zpl = new ZplBuilder(sample).build();
console.log(zpl);
