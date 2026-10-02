import { expect, test } from '@playwright/test';

test('blocks oversized PDFs locally and preserves small uploads', async ({ page }) => {
  await page.goto('/register');
  const result = await page.evaluate(async () => {
    const modulePath = '/assets/uploads.js';
    const { prepareUpload, MAX_UPLOAD_BYTES } = await import(modulePath);
    const pdf = new File(['%PDF-1.7\n', new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'receipt.pdf', {
      type: 'application/pdf',
    });
    let message = '';
    try {
      await prepareUpload(pdf, 'receipt');
    } catch (error) {
      message = (error as Error).message;
    }
    const small = new File(['%PDF-1.7\n'], 'small.pdf', { type: 'application/pdf' });
    return {
      message,
      budget: MAX_UPLOAD_BYTES,
      unchanged: (await prepareUpload(small, 'receipt')) === small,
    };
  });
  // A PDF cannot be re-encoded in the browser, so an oversized one is refused outright.
  expect(result.message).toContain(`PDF under ${result.budget / 1024 / 1024} MB`);
  expect(result.unchanged).toBe(true);
});

test('browser compression preserves full logo and receipt dimensions', async ({ page }) => {
  await page.goto('/register');
  const result = await page.evaluate(async () => {
    const modulePath = '/assets/uploads.js';
    const { prepareUpload, MAX_UPLOAD_BYTES } = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 800;
    canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
    // Padding past each kind's own trigger forces compression while keeping a valid,
    // non-square image: logos refuse sources over 5 MB, other kinds over the 20 MB budget.
    const padded = (target: number) =>
      new File([png, new Uint8Array(target - png.size)], 'large.png', { type: 'image/png' });
    const results = [];
    for (const [kind, target] of [
      ['logo', 5 * 1024 * 1024 - 1],
      ['receipt', MAX_UPLOAD_BYTES + 1],
    ] as const) {
      const optimized = await prepareUpload(padded(target), kind);
      const bitmap = await createImageBitmap(optimized);
      results.push({
        kind,
        width: bitmap.width,
        height: bitmap.height,
        size: optimized.size,
        type: optimized.type,
      });
      bitmap.close();
    }
    // A file already inside the budget is returned untouched rather than re-encoded.
    const small = new File([png, new Uint8Array(1024)], 'small.png', { type: 'image/png' });
    const kept = await prepareUpload(small, 'photo');
    return { results, budget: MAX_UPLOAD_BYTES, keptUnchanged: kept === small };
  });
  for (const entry of result.results) {
    // Resizing is driven by the logo's 1600 px cap only; this source is already inside it,
    // so an oversized upload keeps its exact dimensions and is merely re-encoded.
    expect(entry.width, `${entry.kind} width`).toBe(1600);
    expect(entry.height, `${entry.kind} height`).toBe(800);
    expect(entry.size, `${entry.kind} size`).toBeLessThan(result.budget);
    expect(entry.type, `${entry.kind} type`).toBe('image/webp');
  }
  expect(result.keptUnchanged).toBe(true);
});
