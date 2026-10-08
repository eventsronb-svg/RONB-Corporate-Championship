// Receipts and player photos are accepted up to 20 MB. A file already inside the budget is
// uploaded untouched, so ordinary photos are never re-encoded; only oversized ones are
// compressed down to it.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// Logos are small, publicly cached images, so they keep their own tighter cap.
const MAX_SOURCE_BYTES = { logo: 5 * 1024 * 1024 };
const MAX_DIMENSION = { logo: 1600 };
// Compression ladder: each quality is tried at full size before the image is shrunk, so an
// oversized photo keeps its original dimensions whenever a quality step alone brings it in.
const QUALITY_STEPS = [0.82, 0.7, 0.55, 0.4];
const SCALE_STEPS = [1, 0.75, 0.5, 0.35, 0.25];
const BUDGET_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
// Lets callers label size failures as "Image too big" instead of parsing messages.
const tooBig = (message) => Object.assign(new Error(message), { code: 'image_too_big' });
const invalidImage = () =>
  new Error('This image could not be opened. Choose a valid PNG, JPEG or WebP.');

// A photo or receipt that already fits the budget is uploaded untouched, so the browser
// never decodes it. Reading the first bytes keeps that promise while still refusing a
// corrupt file here instead of after a round trip to the server.
async function hasImageHeader(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const startsAt = (offset, signature) =>
    signature.every((byte, index) => head[offset + index] === byte);
  if (file.type === 'image/png')
    return startsAt(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (file.type === 'image/jpeg') return startsAt(0, [0xff, 0xd8, 0xff]);
  // WebP is a RIFF container with the format name at offset 8.
  return startsAt(0, [0x52, 0x49, 0x46, 0x46]) && startsAt(8, [0x57, 0x45, 0x42, 0x50]);
}

const toBlob = (canvas, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));

function draw(bitmap, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

export async function prepareUpload(file, kind) {
  if (!(file instanceof File) || !file.size) throw new Error('Choose a file to upload.');
  const pdf = kind === 'receipt' && file.type === 'application/pdf';
  if (!pdf && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Use PNG, JPEG or WebP; receipts also accept PDF.');
  }
  if (pdf) {
    // A PDF cannot be re-encoded in the browser, so an oversized one is refused outright.
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `This PDF is too large. Choose a PDF under ${BUDGET_MB} MB or upload a receipt image.`,
      );
    }
    return file;
  }
  const maxSourceBytes = MAX_SOURCE_BYTES[kind];
  if (maxSourceBytes && file.size > maxSourceBytes) {
    throw tooBig(`Choose an image up to ${Math.round(maxSourceBytes / 1024 / 1024)} MB.`);
  }
  // Logos are resized to their display size, so they are always re-encoded. Every other kind
  // that already fits the budget is sent as-is, which avoids decoding a large photo only to
  // re-encode it into something bigger than the original.
  const dimensionCap = MAX_DIMENSION[kind];
  if (!dimensionCap && file.size <= MAX_UPLOAD_BYTES) {
    if (!(await hasImageHeader(file))) throw invalidImage();
    return file;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw invalidImage();
  }
  try {
    // Logos shrink to a fixed longest edge; other kinds start at full size.
    const maxScale = dimensionCap
      ? Math.min(1, dimensionCap / Math.max(bitmap.width, bitmap.height))
      : 1;
    let compressed = null;
    for (const scale of SCALE_STEPS) {
      const step = Math.min(1, maxScale * scale);
      const width = Math.max(1, Math.round(bitmap.width * step));
      const height = Math.max(1, Math.round(bitmap.height * step));
      const canvas = draw(bitmap, width, height);
      // Browsers silently shrink canvases past their size limit; smaller steps would fail too.
      if (!canvas || canvas.width !== width || canvas.height !== height) break;
      for (const quality of QUALITY_STEPS) {
        const blob = await toBlob(canvas, quality);
        if (!blob) break;
        compressed = blob;
        if (blob.size <= MAX_UPLOAD_BYTES) break;
      }
      if (compressed && compressed.size <= MAX_UPLOAD_BYTES) break;
    }
    if (!compressed || compressed.size > MAX_UPLOAD_BYTES) {
      throw tooBig(`This image could not be compressed below ${BUDGET_MB} MB. Try another photo.`);
    }
    // Browsers without WebP encoding can return PNG instead.
    const extension = compressed.type === 'image/webp' ? 'webp' : 'png';
    return new File([compressed], `${kind}.${extension}`, { type: compressed.type });
  } finally {
    bitmap.close();
  }
}

export async function prepareUploadForm(form) {
  for (const kind of ['receipt', 'logo', 'photo']) {
    const file = form.get(kind);
    if (file instanceof File && file.size) form.set(kind, await prepareUpload(file, kind));
  }
  return form;
}
