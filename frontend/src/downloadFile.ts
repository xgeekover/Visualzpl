/**
 * Trigger a client-side download by wrapping text content in a Blob and
 * synthesizing an <a download> click. Used by both the single-label export
 * and the batch ZPL export so they stay in sync.
 *
 * The Object URL is revoked on a short delay so the browser has time to
 * actually start the download before the source disappears.
 */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
