/**
 * useLabelPreview
 *
 * Debounced bridge between the editor state and the backend preview API.
 *
 * Behavior:
 *   1. Coalesces rapid edits with a 400ms trailing debounce.
 *   2. Aborts any in-flight request when a newer one starts.
 *   3. Discards stale responses via a monotonically increasing request id.
 *   4. Manages Object URLs created from PNG blobs and revokes them when replaced
 *      or when the consumer unmounts, preventing memory leaks.
 *
 * Backend contract:
 *   POST {API_BASE_URL}/api/label/preview
 *     Request:  application/json { zpl, widthMm, heightMm, dpmm }
 *     Response: 200 OK image/png (binary)
 *     Errors:   400 application/json { status, code, message }
 *               502 application/json { ... }
 */

import { useEffect, useRef, useState } from 'react';

const PREVIEW_DEBOUNCE_MS = 400;

/**
 * Resolve the API base URL once at module load.
 *   - Desktop (Electron): `window.__VZPL_API_BASE__`, injected by the preload
 *     script, points at the in-process loopback preview proxy (with its live
 *     port). Preferred when present so the same build runs on web and desktop.
 *   - Web: build-time `VITE_API_BASE_URL`, else localhost:8080.
 */
const RUNTIME_API_BASE =
  (typeof window !== 'undefined' &&
    (window as unknown as { __VZPL_API_BASE__?: string }).__VZPL_API_BASE__) ||
  undefined;

const API_BASE_URL =
  RUNTIME_API_BASE ??
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:8080';

const PREVIEW_ENDPOINT = `${API_BASE_URL}/api/label/preview`;

export interface UseLabelPreviewArgs {
  zplCode: string;
  widthMm: number;
  heightMm: number;
  dpmm: number;
}

export interface UseLabelPreviewResult {
  /** Object URL of the most recently rendered PNG, or null before the first success. */
  previewUrl: string | null;
  /** True once the debounce window has elapsed and a request is in flight. */
  isLoading: boolean;
  /** Human-readable error message, or null on success/idle. */
  error: string | null;
}

/** Mirrors `ApiErrorResponse` returned by the Spring Boot backend. */
interface BackendErrorPayload {
  status?: number;
  code?: string;
  message?: string;
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

  // Monotonic id of the latest request. Older responses self-discard.
  const requestIdRef = useRef(0);
  // Currently rendered Object URL — kept so we can revoke it when replaced.
  const activeObjectUrlRef = useRef<string | null>(null);
  // Tracks the AbortController of the pending request, if any.
  const inFlightControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Empty payloads would fail the backend's @NotBlank validation — skip eagerly.
    if (!zplCode.trim()) {
      return;
    }

    const debounceTimerId = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;

      // Cancel any prior request still on the wire.
      inFlightControllerRef.current?.abort();
      const controller = new AbortController();
      inFlightControllerRef.current = controller;

      setIsLoading(true);

      fetch(PREVIEW_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'image/png',
        },
        body: JSON.stringify({ zpl: zplCode, widthMm, heightMm, dpmm }),
      })
        .then(async response => {
          // Stale guard: a newer request superseded this one.
          if (requestId !== requestIdRef.current) return;

          if (!response.ok) {
            const payload = (await response
              .json()
              .catch(() => null)) as BackendErrorPayload | null;
            const message =
              payload?.message ?? `Preview failed (HTTP ${response.status})`;
            setError(message);
            setIsLoading(false);
            return;
          }

          const pngBlob = await response.blob();
          if (requestId !== requestIdRef.current) return;

          const nextObjectUrl = URL.createObjectURL(pngBlob);

          // Release memory held by the previously displayed image.
          if (activeObjectUrlRef.current) {
            URL.revokeObjectURL(activeObjectUrlRef.current);
          }
          activeObjectUrlRef.current = nextObjectUrl;

          setPreviewUrl(nextObjectUrl);
          setError(null);
          setIsLoading(false);
        })
        .catch(err => {
          // Aborts are intentional cancellations, not user-facing failures.
          if (controller.signal.aborted) return;
          if (requestId !== requestIdRef.current) return;

          const message =
            err instanceof Error ? err.message : 'Unknown preview error';
          setError(message);
          setIsLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounceTimerId);
    };
  }, [zplCode, widthMm, heightMm, dpmm]);

  // Final cleanup on unmount: abort in-flight and revoke the dangling Object URL.
  useEffect(() => {
    return () => {
      inFlightControllerRef.current?.abort();
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
        activeObjectUrlRef.current = null;
      }
    };
  }, []);

  return { previewUrl, isLoading, error };
}
