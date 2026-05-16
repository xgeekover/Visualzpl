/**
 * ImageToZpl
 *
 * Converts an arbitrary raster image (PNG / JPEG) into a 1-bit monochrome
 * payload suitable for the ZPL ^GFA (Graphic Field, ASCII hex) command.
 *
 * Pipeline:
 *   1. Load the source into an HTMLImageElement.
 *   2. Draw it onto an off-screen <canvas> at the target dot dimensions.
 *   3. Read back the RGBA ImageData.
 *   4. For each pixel, compute BT.601 luma; pixel < threshold => black (1).
 *   5. Pack the bits MSB-first, 8 pixels per byte. Each row is padded to a
 *      multiple of 8 pixels so it ends on a byte boundary.
 *   6. Encode the byte array as an upper-case ASCII hex string.
 *
 * The output is ready to be embedded as:
 *   ^FO{x},{y}^GFA,{totalBytes},{totalBytes},{bytesPerRow},{hexData}^FS
 */

export interface ImageToZplOptions {
  /** Target width in printer dots. */
  widthDots: number;
  /** Target height in printer dots. */
  heightDots: number;
  /** Luminance threshold (0-255). Pixels darker than this become black. Default 128. */
  threshold?: number;
  /** Treat near-transparent pixels as the white background. Default true. */
  transparentAsWhite?: boolean;
}

export interface ImageToZplResult {
  /** ASCII hex string suitable as the ^GFA data block. */
  hexData: string;
  /** Width of a single row in bytes. */
  bytesPerRow: number;
  /** Total bytes of the encoded bitmap. */
  totalBytes: number;
  /** Effective rendered width in dots (always a multiple of 8). */
  widthDots: number;
  /** Rendered height in dots. */
  heightDots: number;
}

/** Source accepted by `imageToZpl`. DataURLs, blob URLs, raw Blobs and Images. */
export type ImageToZplSource = string | HTMLImageElement | Blob;

const DEFAULT_THRESHOLD = 128;
const TRANSPARENT_ALPHA_CUTOFF = 16;

/**
 * Encode the given image into a ZPL ^GFA-ready payload.
 *
 * The promise resolves on successful decode + rasterization. It rejects if
 * the image fails to load or the 2D context cannot be acquired.
 */
export async function imageToZpl(
  source: ImageToZplSource,
  options: ImageToZplOptions,
): Promise<ImageToZplResult> {
  const {
    widthDots: requestedWidth,
    heightDots,
    threshold = DEFAULT_THRESHOLD,
    transparentAsWhite = true,
  } = options;

  if (requestedWidth <= 0 || heightDots <= 0) {
    throw new Error('Image dimensions must be positive');
  }

  const image = await loadImage(source);

  // ZPL requires each row to fit an integer number of bytes, so we round the
  // canvas width up to the nearest multiple of 8 and treat the padding columns
  // as white background.
  const paddedWidth = Math.ceil(requestedWidth / 8) * 8;
  const bytesPerRow = paddedWidth / 8;
  const totalBytes = bytesPerRow * heightDots;

  const canvas = document.createElement('canvas');
  canvas.width = paddedWidth;
  canvas.height = heightDots;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context is unavailable');

  if (transparentAsWhite) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, paddedWidth, heightDots);
  }

  // Draw the source into the target rectangle (excluding the right-side
  // padding). The browser handles downscaling / upscaling internally.
  ctx.drawImage(image, 0, 0, requestedWidth, heightDots);

  const { data: rgba } = ctx.getImageData(0, 0, paddedWidth, heightDots);

  // Pack to bytes — MSB-first matches ZPL's bit ordering.
  const bytes = new Uint8Array(totalBytes);
  let byteIndex = 0;
  for (let y = 0; y < heightDots; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        const pixelIndex = (y * paddedWidth + x) * 4;
        const r = rgba[pixelIndex];
        const g = rgba[pixelIndex + 1];
        const b = rgba[pixelIndex + 2];
        const a = rgba[pixelIndex + 3];

        // BT.601 luma, integer-friendly form.
        const luma = (r * 299 + g * 587 + b * 114) / 1000;
        const isOpaque = a >= TRANSPARENT_ALPHA_CUTOFF;
        const isBlack = isOpaque && luma < threshold;

        if (isBlack) {
          byte |= 1 << (7 - bit);
        }
      }
      bytes[byteIndex++] = byte;
    }
  }

  // Encode as upper-case hex. ZPL ^GFA expects ASCII hex when format is 'A'.
  const hexChunks: string[] = new Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    hexChunks[i] = bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }

  return {
    hexData: hexChunks.join(''),
    bytesPerRow,
    totalBytes,
    widthDots: paddedWidth,
    heightDots,
  };
}

/**
 * Compute a cheap identity key so callers can decide whether a re-encode is
 * required. The key includes every parameter that affects the encoded output.
 *
 * The DataURL itself is fingerprinted (length + ends) rather than embedded in
 * full, keeping the key short while remaining unique per source image.
 */
export function computeEncodingKey(args: {
  sourceDataUrl: string;
  widthMm: number;
  heightMm: number;
  threshold: number;
  dpmm: number;
}): string {
  const { sourceDataUrl, widthMm, heightMm, threshold, dpmm } = args;
  const sourceFingerprint = `${sourceDataUrl.length}#${sourceDataUrl.slice(
    0,
    32,
  )}#${sourceDataUrl.slice(-16)}`;
  return [
    dpmm,
    widthMm.toFixed(3),
    heightMm.toFixed(3),
    threshold,
    sourceFingerprint,
  ].join('|');
}

/** Load an image source into an HTMLImageElement that is ready to draw. */
function loadImage(source: ImageToZplSource): Promise<HTMLImageElement> {
  if (source instanceof HTMLImageElement) {
    if (source.complete && source.naturalWidth > 0) {
      return Promise.resolve(source);
    }
    return new Promise((resolve, reject) => {
      source.addEventListener('load', () => resolve(source), { once: true });
      source.addEventListener(
        'error',
        () => reject(new Error('Image load failed')),
        { once: true },
      );
    });
  }

  const img = new Image();
  // DataURLs and blob URLs are same-origin; cross-origin URLs require CORS.
  img.crossOrigin = 'anonymous';

  let objectUrl: string | null = null;
  if (source instanceof Blob) {
    objectUrl = URL.createObjectURL(source);
    img.src = objectUrl;
  } else {
    img.src = source;
  }

  return new Promise((resolve, reject) => {
    img.addEventListener(
      'load',
      () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(img);
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        reject(new Error('Image load failed'));
      },
      { once: true },
    );
  });
}
