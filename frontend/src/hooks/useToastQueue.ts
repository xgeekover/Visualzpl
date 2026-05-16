/**
 * useToastQueue
 *
 * Centralized transient notification queue. Replaces the per-action
 * `useFlashStatus` pattern so multiple events firing close together (e.g. a
 * Copy success and a Print success) can coexist on screen instead of stomping
 * each other.
 *
 * Behavior:
 *   - Toasts are stored as a FIFO list and rendered in arrival order.
 *   - Each toast auto-dismisses after `durationMs` (default 2.5s).
 *   - Severity drives presentation: success / warning / error.
 *   - Stale timers are cleaned up on unmount and on manual dismiss.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastSeverity = 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  severity: ToastSeverity;
  message: string;
}

export interface UseToastQueueResult {
  toasts: Toast[];
  showToast: (severity: ToastSeverity, message: string) => void;
  dismissToast: (id: number) => void;
  clearToasts: () => void;
}

const DEFAULT_DURATION_MS = 2500;

// Module-level monotonic counter — IDs only need uniqueness within a session.
let toastIdCounter = 0;

export function useToastQueue(
  durationMs: number = DEFAULT_DURATION_MS,
): UseToastQueueResult {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(
    (severity: ToastSeverity, message: string) => {
      const id = ++toastIdCounter;
      setToasts(prev => [...prev, { id, severity, message }]);
      const timer = window.setTimeout(() => dismissToast(id), durationMs);
      timersRef.current.set(id, timer);
    },
    [durationMs, dismissToast],
  );

  const clearToasts = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer);
    }
    timersRef.current.clear();
    setToasts([]);
  }, []);

  // Final cleanup on unmount — stops any timers that have not fired yet.
  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    [],
  );

  return { toasts, showToast, dismissToast, clearToasts };
}
