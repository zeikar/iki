import type { IkiUvRect } from "@iki/format";

export const ATLAS_PADDING = 2;
export const UV_INSET_PX = 0.5;

/** Intrinsic pixel size of one decoded image; id is an editor-only stable key. */
export interface AtlasSource {
  id: string;
  width: number;
  height: number;
}

/** Sub-image pixel rect within the page, top-left origin, EXCLUDING the gutter. */
export interface AtlasPlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasLayout {
  pageWidth: number;
  pageHeight: number;
  placements: AtlasPlacement[];
  padding: number;
}

/**
 * Deterministic shelf/row packer. Sources are sorted by id for stability so
 * identical inputs always produce an identical layout.
 *
 * Padding is one-sided: each placement reserves `padding` px on its RIGHT and
 * BOTTOM only. Page left/top edges need no gutter.
 *
 * pageWidth/pageHeight = tight bound (max x+width+padding, max y+height+padding).
 * Empty sources → { pageWidth: 0, pageHeight: 0, placements: [], padding }.
 * Throws a plain Error naming the offending source id on a non-finite or <= 0 dimension.
 */
export function packAtlas(
  sources: AtlasSource[],
  padding = ATLAS_PADDING,
): AtlasLayout {
  for (const src of sources) {
    if (!isFinite(src.width) || src.width <= 0) {
      throw new Error(
        `packAtlas: source "${src.id}" has invalid width ${src.width}`,
      );
    }
    if (!isFinite(src.height) || src.height <= 0) {
      throw new Error(
        `packAtlas: source "${src.id}" has invalid height ${src.height}`,
      );
    }
  }

  if (sources.length === 0) {
    return { pageWidth: 0, pageHeight: 0, placements: [], padding };
  }

  // Stable sort by id so identical inputs always produce the same layout.
  const sorted = sources
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Target page width: ceil(sqrt(total padded area)), raised to a sane minimum.
  const totalArea = sorted.reduce(
    (sum, s) => sum + (s.width + padding) * (s.height + padding),
    0,
  );
  const targetWidth = Math.max(
    Math.ceil(Math.sqrt(totalArea)),
    // Ensure at least the widest single source fits.
    Math.max(...sorted.map((s) => s.width + padding)),
  );

  const placements: AtlasPlacement[] = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0; // tallest padded item in the current row

  for (const src of sorted) {
    const paddedW = src.width + padding;
    const paddedH = src.height + padding;

    // Wrap to next row when the item doesn't fit on the current shelf.
    if (shelfX > 0 && shelfX + paddedW > targetWidth) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }

    placements.push({
      id: src.id,
      x: shelfX,
      y: shelfY,
      width: src.width,
      height: src.height,
    });

    shelfX += paddedW;
    if (paddedH > shelfHeight) shelfHeight = paddedH;
  }

  // Tight page bounds: max right/bottom padded edge across all placements.
  let pageWidth = 0;
  let pageHeight = 0;
  for (const p of placements) {
    const right = p.x + p.width + padding;
    const bottom = p.y + p.height + padding;
    if (right > pageWidth) pageWidth = right;
    if (bottom > pageHeight) pageHeight = bottom;
  }

  return { pageWidth, pageHeight, placements, padding };
}

/**
 * Convert a pixel placement into a UV rect, inset by `insetPx` on all four
 * edges and clamped to [0, 1] so the validator's bounds check always passes.
 */
export function uvRectFor(
  placement: AtlasPlacement,
  page: { width: number; height: number },
  insetPx = UV_INSET_PX,
): IkiUvRect {
  const px = placement.x + insetPx;
  const py = placement.y + insetPx;
  const pw = placement.width - insetPx * 2;
  const ph = placement.height - insetPx * 2;

  const x = Math.max(0, px / page.width);
  const y = Math.max(0, py / page.height);
  const width = Math.min(1 - x, Math.max(0, pw / page.width));
  const height = Math.min(1 - y, Math.max(0, ph / page.height));

  return { x, y, width, height };
}
