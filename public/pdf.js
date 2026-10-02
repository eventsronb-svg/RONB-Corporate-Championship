// Roster PDF export shared by the captain profile page and the organizer team
// page: one page per group of players, each row showing the player photo, the
// name and the jersey size. Photos are passed as JPEG bytes so they embed
// directly with /DCTDecode.

const PAGE = { width: 595, height: 842, margin: 40 };
const PHOTO_SIZE = 56;
const ROW_HEIGHT = 72;
const HEADER_HEIGHT = 124;
const ROWS_PER_PAGE = Math.max(
  1,
  Math.floor((PAGE.height - PAGE.margin * 2 - HEADER_HEIGHT) / ROW_HEIGHT),
);
const NAME_LEFT = PAGE.margin + PHOTO_SIZE + 20;
const SIZE_RIGHT = PAGE.width - PAGE.margin;
const PLACEHOLDER_SHADE = '0.957 0.949 0.945';
const encoder = new TextEncoder();
// Page content is WinAnsi, not UTF-8: TextEncoder would emit two bytes for an
// accented letter and the PDF would show "Ã©" instead of "é".
const winAnsi = (value) => Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);

const escapeText = (value) =>
  String(value)
    // WinAnsiEncoding covers Latin-1; base-14 fonts cannot show anything else.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/[\\()]/g, (char) => `\\${char}`);

const shorten = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
};

// Windows and macOS reject these in a saved file name, so the company name is
// trimmed down.
export const fileSafeName = (value) =>
  String(value ?? '')
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'team-profile';

const saveFile = (bytes, name, type) => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const text = (size, x, y, value, font = 'F1') =>
  // Images and the blank-photo placeholder can change the PDF graphics state.
  // Reset the non-stroking colour for every text run so roster details remain
  // solid black after a grey placeholder.
  `BT 0 g /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapeText(value)}) Tj ET\n`;

const rule = (y) =>
  `0.85 0.85 0.84 RG 0.6 w ${PAGE.margin} ${y.toFixed(2)} m ${SIZE_RIGHT} ${y.toFixed(2)} l S\n`;

const square = (x, y, size, shade) =>
  `${shade} rg ${x.toFixed(2)} ${y.toFixed(2)} ${size} ${size} re f\n`;

const drawImage = (name, x, y, size) =>
  `q ${size.toFixed(2)} 0 0 ${size.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q\n`;

const pageStream = ({ company, team, sport, rows, number, total }, withHeader) => {
  const top = PAGE.height - PAGE.margin;
  let content = '';
  if (withHeader) {
    content += text(20, PAGE.margin, top - 20, company, 'F2');
    content += text(11, PAGE.margin, top - 40, `${team} · ${sport}`);
    content += rule(top - 54);
    content += text(9.5, NAME_LEFT, top - 72, 'Player', 'F2');
    content += text(9.5, SIZE_RIGHT - 44, top - 72, 'Jersey size', 'F2');
  } else {
    // A roster that spills over several sheets repeats the team on each page.
    content += text(9.5, PAGE.margin, top - 20, `${company} · ${team}`, 'F2');
    content += rule(top - 32);
  }
  const firstRow = withHeader ? top - HEADER_HEIGHT + 18 : top - 48;
  rows.forEach((row, offset) => {
    const y = firstRow - offset * ROW_HEIGHT;
    if (row.image) content += drawImage(row.image, PAGE.margin, y - PHOTO_SIZE, PHOTO_SIZE);
    else content += square(PAGE.margin, y - PHOTO_SIZE, PHOTO_SIZE, PLACEHOLDER_SHADE);
    content += text(12, NAME_LEFT, y - 16, shorten(row.name, 40), 'F2');
    if (row.captain) content += text(9.5, NAME_LEFT, y - 32, 'Captain');
    content += text(11, SIZE_RIGHT - 44, y - 16, shorten(row.size || '-', 4), 'F2');
    if (offset < rows.length - 1) content += rule(y - ROW_HEIGHT + 14);
  });
  content += text(9, PAGE.margin, PAGE.margin - 10, `Page ${number} of ${total}`);
  return winAnsi(content);
};

class Pdf {
  constructor() {
    this.parts = [encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    this.length = this.parts[0].length;
    this.offsets = [0];
  }
  object(id, ...parts) {
    this.offsets[id] = this.length;
    this.push(`${id} 0 obj\n`);
    for (const part of parts) this.push(part);
    this.push('\nendobj\n');
  }
  stream(id, dictionary, bytes) {
    this.object(id, `${dictionary} /Length ${bytes.length} >>\nstream\n`, bytes, '\nendstream');
  }
  push(part) {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    this.parts.push(bytes);
    this.length += bytes.length;
  }
  finish(size) {
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++)
      table += `${String(this.offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    const bytes = encoder.encode(
      `${table}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${this.length}\n%%EOF\n`,
    );
    this.parts.push(bytes);
    return concat(this.parts);
  }
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const PHOTO_PIXELS = 240;

// Reads a player photo and crops it to a square JPEG for embedding. Photos are
// stored as WebP, which PDF cannot embed, so they pass through a canvas.
// Returns null when the image cannot be read, so one photo never stops an export.
export async function photoToJpeg(src) {
  if (!src) return null;
  try {
    const response = await fetch(src, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = PHOTO_PIXELS;
      canvas.height = PHOTO_PIXELS;
      canvas
        .getContext('2d')
        .drawImage(
          bitmap,
          (bitmap.width - side) / 2,
          (bitmap.height - side) / 2,
          side,
          side,
          0,
          0,
          PHOTO_PIXELS,
          PHOTO_PIXELS,
        );
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!jpeg) return null;
      return {
        width: PHOTO_PIXELS,
        height: PHOTO_PIXELS,
        data: new Uint8Array(await jpeg.arrayBuffer()),
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

// Gathers roster rows from a rendered form so an export matches what the user
// sees, including edits they have not saved yet. `fields` is the container of
// `.player-row` elements; `captain` is the captain <select>.
export function rowsFromFields(fields, captain) {
  return (
    [...fields.children]
      .map((row, index) => ({
        name: row.querySelector('input[name="player"]').value.trim(),
        // Sleeve style radios are also named `jersey-style-N`, so a prefix match
        // alone would report a sleeve as the size when no size is ticked.
        size:
          [...row.querySelectorAll('input[name^="jersey-"]:checked')].find((input) =>
            /^jersey-\d+$/.test(input.name),
          )?.value || '',
        captain: captain.value !== '' && Number(captain.value) === index,
        image: row.querySelector('.player-photo-preview')?.src || null,
      }))
      // Unused empty rows are dropped; a photo on its own is still worth exporting.
      .filter((row) => row.name || row.image)
      .map((row, index) => ({ ...row, name: row.name || `Player ${index + 1}` }))
  );
}

// Downloads a built roster and reports the outcome to the caller, which owns
// the page's own error surface: `{ empty }` when there is nothing to export,
// `{ failed, error }` when the file could not be produced, otherwise
// `{ skipped }` counting the photos that could not be read.
export async function exportRosterPdf({ rows, company, team, sport, button }) {
  if (!rows.length) return { skipped: 0, empty: true };
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing…';
  }
  let skipped = 0;
  try {
    // Photos are read one at a time so a long roster does not open a dozen
    // canvas decodes at once; each failure only drops its own photo.
    const photos = [];
    for (const row of rows) {
      const image = await photoToJpeg(row.image);
      if (row.image && !image) skipped += 1;
      photos.push({ ...row, image });
    }
    saveFile(
      buildRosterPdf({ company, team, sport, rows: photos }),
      `${fileSafeName(company)}.pdf`,
      'application/pdf',
    );
    return { skipped, empty: false };
  } catch (error) {
    return { skipped, empty: false, failed: true, error };
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

// One line for a successful export, counting the photos that were dropped.
export const exportSummary = (skipped) =>
  skipped
    ? `Team PDF downloaded. ${skipped} photo${skipped > 1 ? 's' : ''} could not be included.`
    : 'Team PDF downloaded.';

// Returns the finished file as bytes so the caller can wrap it in a Blob.
export function buildRosterPdf({ company, team, sport, rows, perPage = ROWS_PER_PAGE }) {
  const groups = [];
  for (let start = 0; start < rows.length; start += perPage)
    groups.push(rows.slice(start, start + perPage));
  if (!groups.length) groups.push([]);
  const total = groups.length;
  // 1 catalog, 2 pages, 3 regular font, 4 bold font, then per page: page,
  // contents and one image object per photo.
  let next = 5;
  const plan = groups.map((group) => ({
    rows: group,
    pageId: next++,
    contentId: next++,
    imageIds: group.filter((row) => row.image).map(() => next++),
  }));
  const pdf = new Pdf();
  pdf.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  pdf.object(
    2,
    `<< /Type /Pages /Count ${total} /Kids [${plan.map((p) => `${p.pageId} 0 R`).join(' ')}] >>`,
  );
  pdf.object(
    3,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  pdf.object(
    4,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  plan.forEach((page, index) => {
    const photos = page.rows.filter((row) => row.image);
    const names = page.imageIds.map((_, position) => `Im${index}p${position}`);
    const xobjects = names
      .map((name, position) => `/${name} ${page.imageIds[position]} 0 R`)
      .join(' ');
    pdf.object(
      page.pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobjects} >> >> ` +
        `/Contents ${page.contentId} 0 R >>`,
    );
    const stream = pageStream(
      { company, team, sport, rows: page.rows, number: index + 1, total },
      index === 0,
    );
    pdf.stream(page.contentId, '<<', stream);
    page.imageIds.forEach((id, position) => {
      const photo = photos[position].image;
      pdf.stream(
        id,
        `<< /Type /XObject /Subtype /Image /Width ${photo.width} /Height ${photo.height} ` +
          '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        photo.data,
      );
    });
  });
  return pdf.finish(next);
}
