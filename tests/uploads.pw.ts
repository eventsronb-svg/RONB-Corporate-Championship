import { expect, test } from '@playwright/test';

test('blocks oversized PDFs locally and preserves small uploads', async ({ page }) => {
  await page.goto('/register');
  const result = await page.evaluate(async () => {
    const modulePath = '/assets/uploads.js';
    const { prepareUpload } = await import(modulePath);
    const pdf = new File(['%PDF-1.7\n', new Uint8Array(4_000_000)], 'receipt.pdf', {
      type: 'application/pdf',
    });
    let message = '';
    try {
      await prepareUpload(pdf, 'receipt');
    } catch (error) {
      message = (error as Error).message;
    }
    const small = new File(['%PDF-1.7\n'], 'small.pdf', { type: 'application/pdf' });
    return { message, unchanged: (await prepareUpload(small, 'receipt')) === small };
  });
  expect(result.message).toContain('PDF under 4 MB');
  expect(result.unchanged).toBe(true);
});

test('browser compression preserves full logo and receipt dimensions', async ({ page }) => {
  await page.goto('/register');
  const results = await page.evaluate(async () => {
    const modulePath = '/assets/uploads.js';
    const { prepareUpload } = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 800;
    canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
    // Padding forces browser compression while keeping a valid, non-square image.
    const file = new File([png, new Uint8Array(4_000_001 - png.size)], 'large.png', {
      type: 'image/png',
    });
    const results = [];
    for (const kind of ['logo', 'receipt']) {
      const optimized = await prepareUpload(file, kind);
      const bitmap = await createImageBitmap(optimized);
      results.push({ width: bitmap.width, height: bitmap.height, size: optimized.size });
      bitmap.close();
    }
    return results;
  });
  for (const result of results) {
    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
    expect(result.size).toBeLessThan(4_000_000);
  }
});
