/**
 * LabelPresets
 *
 * Industry-standard starting templates for VisualZPL. Each preset bundles:
 *   - A complete LabelDocument (canvas dimensions + pre-arranged objects)
 *   - Sample DataRow entries used to hydrate the BatchDataModal so users
 *     can immediately click "Batch Data" and see a realistic dataset.
 *
 * Conventions:
 *   - All coordinates are in millimeters.
 *   - DPI is fixed at 203 (8 dpmm) — matches the most common Zebra
 *     industrial printers (e.g. ZD420, ZT410, GK420).
 *   - Object ids are prefixed by preset to keep them descriptive when the
 *     user inspects the Layers panel after loading.
 */

import type { LabelDocument } from './types';
import type { DataRow } from './BatchZpl';

export interface LabelPreset {
  /** Stable id used as React key and (eventually) analytics. */
  id: string;
  /** Short label shown in the dropdown. */
  name: string;
  /** One-line description: dimensions + intended use. */
  description: string;
  /** Fully formed document loaded into the editor on selection. */
  document: LabelDocument;
  /** Seed rows hydrated into BatchDataModal upon load. */
  sampleDataRows: DataRow[];
}

export const LABEL_PRESETS: LabelPreset[] = [
  // ────────────────────────────────────────────────────────────────────
  // Preset 1 — Logistics Shipping Label (4 × 6 in / 101.6 × 152.4 mm)
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'shipping-4x6',
    name: 'Logistics Shipping Label',
    description: '4 × 6 in (101.6 × 152.4 mm) — carrier routing + tracking',
    document: {
      unit: 'mm',
      dpmm: 8,
      widthMm: 101.6,
      heightMm: 152.4,
      objects: [
        {
          id: 'ship-from-header',
          type: 'text',
          x: 5,
          y: 5,
          fontHeight: 3.5,
          data: 'FROM: VisualZPL Distribution Center',
        },
        {
          id: 'ship-to-header',
          type: 'text',
          x: 5,
          y: 14,
          fontHeight: 5,
          data: 'SHIP TO:',
        },
        {
          id: 'ship-recipient',
          type: 'text',
          x: 5,
          y: 22,
          fontHeight: 5,
          data: '{{Recipient}}',
        },
        {
          id: 'ship-address',
          type: 'text',
          x: 5,
          y: 31,
          fontHeight: 4,
          data: '{{Address}}',
        },
        {
          id: 'ship-city',
          type: 'text',
          x: 5,
          y: 39,
          fontHeight: 4,
          data: '{{City}}',
        },
        {
          id: 'ship-service-label',
          type: 'text',
          x: 5,
          y: 60,
          fontHeight: 3.5,
          data: 'SERVICE',
        },
        {
          id: 'ship-service',
          type: 'text',
          x: 5,
          y: 66,
          fontHeight: 6,
          data: '{{Service}}',
        },
        {
          id: 'ship-tracking-label',
          type: 'text',
          x: 5,
          y: 95,
          fontHeight: 3.5,
          data: 'TRACKING #',
        },
        {
          id: 'ship-tracking-number',
          type: 'text',
          x: 5,
          y: 101,
          fontHeight: 4,
          data: '{{TrackingNumber}}',
        },
        {
          id: 'ship-tracking-barcode',
          type: 'barcode',
          x: 5,
          y: 112,
          height: 25,
          moduleWidth: 3,
          printInterpretationLine: true,
          data: '{{TrackingNumber}}',
        },
      ],
    },
    sampleDataRows: [
      {
        Recipient: 'John Smith',
        Address: '123 Main St',
        City: 'Springfield, IL 62701',
        Service: 'Priority Ground',
        TrackingNumber: '1Z999AA10123456784',
      },
      {
        Recipient: 'Jane Doe',
        Address: '456 Oak Ave Apt 2B',
        City: 'Portland, OR 97201',
        Service: 'Express Air',
        TrackingNumber: '1Z999AA10123456791',
      },
      {
        Recipient: 'Robert Chen',
        Address: '789 Pine Rd',
        City: 'Austin, TX 78701',
        Service: 'Overnight',
        TrackingNumber: '1Z999AA10123456807',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // Preset 2 — Asset Identification Tag (2 × 1 in / 50.8 × 25.4 mm)
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'asset-tag-2x1',
    name: 'Asset Identification Tag',
    description: '2 × 1 in (50.8 × 25.4 mm) — company header + high-density QR',
    document: {
      unit: 'mm',
      dpmm: 8,
      widthMm: 50.8,
      heightMm: 25.4,
      objects: [
        {
          id: 'asset-company',
          type: 'text',
          x: 2,
          y: 2,
          fontHeight: 3,
          data: 'ACME Corp · IT Department',
        },
        {
          id: 'asset-label',
          type: 'text',
          x: 2,
          y: 8,
          fontHeight: 2.5,
          data: 'ASSET ID',
        },
        {
          id: 'asset-id',
          type: 'text',
          x: 2,
          y: 13,
          fontHeight: 5,
          data: '{{AssetID}}',
        },
        {
          id: 'asset-qr',
          type: 'qrcode',
          x: 30,
          y: 2,
          magnification: 3,
          errorCorrection: 'H',
          data: '{{AssetID}}',
        },
      ],
    },
    sampleDataRows: [
      { AssetID: 'ACME-2024-0001' },
      { AssetID: 'ACME-2024-0002' },
      { AssetID: 'ACME-2024-0003' },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // Preset 3 — Retail Price Tag (40 × 30 mm)
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'retail-40x30',
    name: 'Retail Price Tag',
    description: '40 × 30 mm — item, price, SKU barcode',
    document: {
      unit: 'mm',
      dpmm: 8,
      widthMm: 40,
      heightMm: 30,
      objects: [
        {
          id: 'retail-item',
          type: 'text',
          x: 2,
          y: 2,
          fontHeight: 3.5,
          data: '{{ItemName}}',
        },
        {
          id: 'retail-price',
          type: 'text',
          x: 2,
          y: 8,
          fontHeight: 6,
          data: '$ {{Price}}',
        },
        {
          id: 'retail-sku-barcode',
          type: 'barcode',
          x: 2,
          y: 18,
          height: 8,
          moduleWidth: 2,
          printInterpretationLine: true,
          data: '{{SKU}}',
        },
      ],
    },
    sampleDataRows: [
      { ItemName: 'Cotton T-Shirt', Price: '19.99', SKU: 'CT-001-M' },
      { ItemName: 'Denim Jeans', Price: '49.99', SKU: 'DJ-204-L' },
      { ItemName: 'Leather Wallet', Price: '29.99', SKU: 'LW-330-BLK' },
    ],
  },
];
