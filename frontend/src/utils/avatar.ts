/**
 * @fileoverview Avatar file processing — downscale/compress to ≤1MB data URL.
 */

const MAX_BYTES = 1_048_576;
const MAX_DIM = 512;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Load an image file into an HTMLImageElement.
 * @param file - Image file to load
 * @returns Loaded image element
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image file"));
    };
    img.src = url;
  });
}

/**
 * Encode a canvas to a jpeg data URL at given quality.
 * @param canvas - Canvas to encode
 * @param quality - JPEG quality 0-1
 * @returns Data URL string
 */
function encodeCanvas(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not encode image"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Could not encode image"));
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Process an avatar file into a ≤1MB jpeg data URL, downscaling if needed.
 * Large phone photos are compressed automatically instead of rejected.
 * @param file - Raw image file from file picker
 * @returns Data URL ready for preview and PUT /api/auth/avatar
 * @throws When type unsupported or image unreadable
 * @example const url = await processAvatarFile(file);
 */
export async function processAvatarFile(file: File): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Photo must be jpeg, png or webp");
  }

  // Small enough already — still normalize through canvas to jpeg for consistency,
  // unless the file is tiny (skip work for trivial sizes).
  const img = await loadImage(file);
  let { width, height } = img;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.drawImage(img, 0, 0, width, height);

  // Try decreasing qualities until under the limit.
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = await encodeCanvas(canvas, quality);
    // Approximate byte size from Base64 length.
    const bytes = Math.ceil((url.length - url.indexOf(",") - 1) * 0.75);
    if (bytes <= MAX_BYTES) return url;
  }
  throw new Error("Photo is too large even after compression (must be ≤1MB)");
}

/** Max avatar bytes accepted by client and server. */
export const AVATAR_MAX_BYTES = MAX_BYTES;
