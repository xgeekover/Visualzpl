/**
 * useLabelPreview
 *
 * Renders the label preview **fully locally** (offline / 폐쇄망 safe) — no
 * Labelary, no backend, no network. The ZPL is rasterized on-device by
 * `renderZplToCanvas` (canvas + bwip-js for barcodes/QR).
 *
 * Behavior:
 *   1. Coalesces rapid edits with a short trailing debounce.
 *   2. Produces a PNG data URL (no Object URL lifecycle to manage).
 *   3. Surfaces render errors instead of network errors.
 *
 * Fidelity: text approximates the printer's scalable font; layout, sizing,
 * boxes, graphics and barcodes/QR are accurate. The exported ZPL remains the
 * source of truth for the physical printer.
 */

import { useEffect, useState } from 'react';
import { renderZplToDataUrl } from '../zpl/renderZpl';

const PREVIEW_DEBOUNCE_MS = 250;

export interface UseLabelPreviewArgs {
  zplCode: string;
  widthMm: number;
  heightMm: number;
  dpmm: number;
}

export interface UseLabelPreviewResult {
  /** Data URL of the most recently rendered PNG, or null before the first render. */
  previewUrl: string | null;
  /** True during the debounce window before a render commits. */
  isLoading: boolean;
  /** Human-readable error message, or null on success/idle. */
  error: string | null;
}

export function useLabelPreview({
  zplCode,
  widthMm,
  heightMm,
  dpmm,
}: UseLabelPreviewArgs): UseLabelPreviewResult {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!zplCode.trim()) {
      setPreviewUrl(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const timer = window.setTimeout(() => {
      try {
        const url = renderZplToDataUrl(zplCode, { widthMm, heightMm, dpmm });
        setPreviewUrl(url);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Preview render failed');
      } finally {
        setIsLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [zplCode, widthMm, heightMm, dpmm]);

  return { previewUrl, isLoading, error };
}
