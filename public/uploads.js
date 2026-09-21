// Leave room for multipart boundaries and fields below Vercel's 4.5 MB body limit.
export const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export async function prepareUpload(file, kind) {
  if (!(file instanceof File) || !file.size) throw new Error('Choose a file to upload.');
  const pdf = kind === 'receipt' && file.type === 'application/pdf';
  if (!pdf && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Use PNG, JPEG or WebP; receipts also accept PDF.');
  }
  if (pdf) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('This PDF is too large. Choose a PDF under 4 MB or upload a receipt image.');
    }
    return file;
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image up to 5 MB.');
  // Small files are optimized on the server, avoiding an extra lossy encode.
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be opened. Choose a valid PNG, JPEG or WebP.');
  }
  try {
    if (bitmap.width * bitmap.height > 20_000_000) {
      throw new Error('This image has too many pixels. Choose an image under 20 megapixels.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable. Choose a file under 4 MB.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
    if (!compressed || compressed.size > MAX_UPLOAD_BYTES) {
      throw new Error('This image is still too large after compression. Choose a file under 4 MB.');
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
