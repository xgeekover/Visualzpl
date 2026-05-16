/**
 * useBrowserPrint
 *
 * React hook that talks to the Zebra Browser Print local agent over HTTP.
 *
 * Zebra Browser Print is a separately installed desktop utility that exposes
 * an HTTP API on the user's machine. When it is closed, fetch() will fail
 * with a network error and the hook reports `agentStatus === 'unavailable'`.
 *
 * Agent endpoints used (default base URL http://localhost:9100):
 *   GET  /available    -> { deviceList: ZebraDevice[] }
 *   GET  /default      -> the system-configured default device (best effort)
 *   POST /write        -> body { device, data }; pushes ZPL to a printer
 *
 * Lifecycle:
 *   - Probes the agent immediately on mount.
 *   - Re-probes every 30s so newly attached printers and a freshly-started
 *     agent are picked up without a manual reload.
 *   - Transient `printStatus` values ('success' / 'error') automatically
 *     reset to 'idle' after 3 seconds so the UI can show toast-like feedback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const BROWSER_PRINT_BASE_URL = 'http://localhost:9100';
const REFRESH_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const PRINT_TIMEOUT_MS = 15_000;
const STATUS_AUTO_RESET_MS = 3_000;

export type AgentStatus = 'unknown' | 'available' | 'unavailable';
export type PrintStatus = 'idle' | 'sending' | 'success' | 'error';

/** Shape of a single entry from Browser Print's `/available` deviceList. */
export interface ZebraDevice {
  name: string;
  uid: string;
  connection: string;
  deviceType: string;
  manufacturer?: string;
  version?: number;
  provider?: string;
  providerId?: number;
}

export interface UseBrowserPrintResult {
  /** Aggregate availability of the desktop agent. */
  agentStatus: AgentStatus;
  /** All printers reported by the agent. */
  devices: ZebraDevice[];
  /** User-picked device, if any (overrides the system default). */
  selectedDevice: ZebraDevice | null;
  /** Picks a printer by uid. Pass an unknown uid to clear the selection. */
  selectDevice: (uid: string) => void;
  /** Sends a ZPL string to the selected device (or default / first found). */
  print: (zplCode: string) => Promise<void>;
  /** Force a re-probe of the agent and device list. */
  refreshDevices: () => Promise<void>;
  /** Transient send state. */
  printStatus: PrintStatus;
  /** Last error message, kept until a successful print or manual refresh. */
  lastError: string | null;
}

interface AvailableResponse {
  deviceList?: ZebraDevice[];
}

/** fetch() wrapper that aborts after `timeoutMs` so a dead agent fails fast. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = PROBE_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    window.clearTimeout(timerId);
  }
}

export function useBrowserPrint(): UseBrowserPrintResult {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('unknown');
  const [devices, setDevices] = useState<ZebraDevice[]>([]);
  const [defaultDevice, setDefaultDevice] = useState<ZebraDevice | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<ZebraDevice | null>(
    null,
  );
  const [printStatus, setPrintStatus] = useState<PrintStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const autoResetTimerRef = useRef<number | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(
        `${BROWSER_PRINT_BASE_URL}/available`,
      );
      if (!response.ok) {
        setAgentStatus('unavailable');
        return;
      }
      const payload = (await response.json()) as AvailableResponse;
      const list = payload?.deviceList ?? [];
      setAgentStatus('available');
      setDevices(list);

      // Best-effort default lookup. Some Browser Print builds don't expose
      // /default; in that case we transparently fall back to the first entry.
      try {
        const defaultResp = await fetchWithTimeout(
          `${BROWSER_PRINT_BASE_URL}/default`,
        );
        if (defaultResp.ok) {
          const bodyText = await defaultResp.text();
          if (bodyText && bodyText.trim().length > 0) {
            const parsed = JSON.parse(bodyText) as ZebraDevice;
            setDefaultDevice(parsed);
            return;
          }
        }
      } catch {
        // ignore — fall through to list fallback
      }
      setDefaultDevice(list[0] ?? null);
    } catch {
      // Network error -> agent is almost certainly not running.
      setAgentStatus('unavailable');
      setDevices([]);
      setDefaultDevice(null);
    }
  }, []);

  // Initial probe + slow background refresh.
  useEffect(() => {
    void refreshDevices();
    const intervalId = window.setInterval(() => {
      void refreshDevices();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshDevices]);

  // Auto-reset the transient print status so the toast disappears.
  useEffect(() => {
    if (printStatus !== 'success' && printStatus !== 'error') return;
    if (autoResetTimerRef.current !== null) {
      window.clearTimeout(autoResetTimerRef.current);
    }
    autoResetTimerRef.current = window.setTimeout(() => {
      setPrintStatus('idle');
      autoResetTimerRef.current = null;
    }, STATUS_AUTO_RESET_MS);
  }, [printStatus]);

  // Final cleanup on unmount.
  useEffect(
    () => () => {
      if (autoResetTimerRef.current !== null) {
        window.clearTimeout(autoResetTimerRef.current);
      }
    },
    [],
  );

  const selectDevice = useCallback(
    (uid: string) => {
      const found = devices.find(d => d.uid === uid) ?? null;
      setSelectedDevice(found);
    },
    [devices],
  );

  const print = useCallback(
    async (zplCode: string) => {
      // Precedence: explicit user selection > system default > first found.
      const target =
        selectedDevice ?? defaultDevice ?? devices[0] ?? null;

      if (!target) {
        setLastError('No Zebra printer found');
        setPrintStatus('error');
        return;
      }

      setLastError(null);
      setPrintStatus('sending');

      try {
        const response = await fetchWithTimeout(
          `${BROWSER_PRINT_BASE_URL}/write`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: target, data: zplCode }),
            timeoutMs: PRINT_TIMEOUT_MS,
          },
        );
        if (!response.ok) {
          throw new Error(
            `Browser Print returned HTTP ${response.status}`,
          );
        }
        setPrintStatus('success');
      } catch (err) {
        const message =
          err instanceof Error
            ? err.name === 'AbortError'
              ? 'Print request timed out'
              : err.message
            : 'Print failed';
        setLastError(message);
        setPrintStatus('error');
      }
    },
    [selectedDevice, defaultDevice, devices],
  );

  return {
    agentStatus,
    devices,
    selectedDevice,
    selectDevice,
    print,
    refreshDevices,
    printStatus,
    lastError,
  };
}
