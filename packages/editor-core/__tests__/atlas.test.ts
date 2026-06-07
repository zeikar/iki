import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, parseIkiModel } from "@iki/format";
import type { IkiModel } from "@iki/format";
import {
  ATLAS_PADDING,
  UV_INSET_PX,
  packAtlas,
  uvRectFor,
} from "@iki/editor-core";
import type { AtlasPlacement } from "@iki/editor-core";

// Sources of intentionally different sizes. Their combined padded area forces
// targetWidth = ceil(sqrt(total)) which is narrower than placing all on one
// row, so the packer wraps at least one item to a second shelf.
const MIXED_SOURCES = [
  { id: "large", width: 128, height: 64 },
  { id: "small", width: 16, height: 16 },
  { id: "tall", width: 32, height: 96 },
  { id: "wide", width: 80, height: 24 },
];

// ── packAtlas – determinism ────────────────────────────────────────────────────

describe("packAtlas determinism", () => {
  it("shuffled input yields identical placement rects and page dims", () => {
    const original = packAtlas(MIXED_SOURCES);

    // Reverse order is a simple shuffle that changes insertion order.
    const shuffled = packAtlas([...MIXED_SOURCES].reverse());

    // Build id→rect maps for comparison.
    const toMap = (placements: AtlasPlacement[]) =>
      Object.fromEntries(
        placements.map(({ id, x, y, width, height }) => [
          id,
          { x, y, width, height },
        ]),
      );

    expect(toMap(shuffled.placements)).toEqual(toMap(original.placements));
    expect(shuffled.pageWidth).toBe(original.pageWidth);
    expect(shuffled.pageHeight).toBe(original.pageHeight);
  });

  it("rotated input yields identical placement rects and page dims", () => {
    const original = packAtlas(MIXED_SOURCES);

    // Rotate by one position — a different permutation from .reverse().
    const rotated = packAtlas([...MIXED_SOURCES.slice(1), MIXED_SOURCES[0]]);

    const toMap = (placements: AtlasPlacement[]) =>
      Object.fromEntries(
        placements.map(({ id, x, y, width, height }) => [
          id,
          { x, y, width, height },
        ]),
      );

    expect(toMap(rotated.placements)).toEqual(toMap(original.placements));
    expect(rotated.pageWidth).toBe(original.pageWidth);
    expect(rotated.pageHeight).toBe(original.pageHeight);
  });
});

// ── packAtlas – non-overlap (one-sided padded box) ────────────────────────────

describe("packAtlas non-overlap", () => {
  it("no two placements have overlapping padded boxes", () => {
    const { placements, padding, pageWidth, pageHeight } =
      packAtlas(MIXED_SOURCES);

    // At least two shelves exist (forced by the mixed sizes).
    const ys = new Set(placements.map((p) => p.y));
    expect(ys.size).toBeGreaterThan(1);

    for (let i = 0; i < placements.length; i++) {
      const a = placements[i];
      for (let j = i + 1; j < placements.length; j++) {
        const b = placements[j];

        // One-sided padded box: [x, x+width+padding) × [y, y+height+padding)
        const aRight = a.x + a.width + padding;
        const aBottom = a.y + a.height + padding;
        const bRight = b.x + b.width + padding;
        const bBottom = b.y + b.height + padding;

        const overlapX = a.x < bRight && b.x < aRight;
        const overlapY = a.y < bBottom && b.y < aBottom;

        expect(
          overlapX && overlapY,
          `placements "${a.id}" and "${b.id}" padded boxes overlap`,
        ).toBe(false);
      }
    }

    // Every placement (including its gutter) must fit within page bounds.
    for (const p of placements) {
      expect(p.x + p.width + padding).toBeLessThanOrEqual(pageWidth);
      expect(p.y + p.height + padding).toBeLessThanOrEqual(pageHeight);
    }
  });
});

// ── packAtlas – edge cases ─────────────────────────────────────────────────────

describe("packAtlas edge cases", () => {
  it("empty sources returns the zero-page layout", () => {
    const layout = packAtlas([]);
    expect(layout.pageWidth).toBe(0);
    expect(layout.pageHeight).toBe(0);
    expect(layout.placements).toHaveLength(0);
    expect(layout.padding).toBe(ATLAS_PADDING);
  });

  it("throws on width <= 0", () => {
    expect(() => packAtlas([{ id: "bad", width: 0, height: 32 }])).toThrow(
      /bad/,
    );
  });

  it("throws on negative width", () => {
    expect(() => packAtlas([{ id: "neg", width: -1, height: 32 }])).toThrow(
      /neg/,
    );
  });

  it("throws on non-finite width", () => {
    expect(() =>
      packAtlas([{ id: "inf", width: Infinity, height: 32 }]),
    ).toThrow(/inf/);
  });

  it("throws on height <= 0", () => {
    expect(() => packAtlas([{ id: "badh", width: 32, height: 0 }])).toThrow(
      /badh/,
    );
  });

  it("throws on non-finite height", () => {
    expect(() => packAtlas([{ id: "nanh", width: 32, height: NaN }])).toThrow(
      /nanh/,
    );
  });
});

// ── uvRectFor ─────────────────────────────────────────────────────────────────

describe("uvRectFor", () => {
  it("result is inside the source pixel rect (inset, not expanded)", () => {
    const placement: AtlasPlacement = {
      id: "a",
      x: 10,
      y: 20,
      width: 80,
      height: 60,
    };
    const page = { width: 256, height: 256 };
    const uv = uvRectFor(placement, page);

    // Inset x/y must be >= source left/top in UV space.
    expect(uv.x).toBeGreaterThanOrEqual(placement.x / page.width);
    expect(uv.y).toBeGreaterThanOrEqual(placement.y / page.height);

    // Inset right/bottom must be <= source right/bottom in UV space.
    const srcRight = (placement.x + placement.width) / page.width;
    const srcBottom = (placement.y + placement.height) / page.height;
    expect(uv.x + uv.width).toBeLessThanOrEqual(srcRight);
    expect(uv.y + uv.height).toBeLessThanOrEqual(srcBottom);
  });

  it("all four UV fields are in 0..1 and x+width <= 1, y+height <= 1", () => {
    const placement: AtlasPlacement = {
      id: "b",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    };
    const page = { width: 128, height: 128 };
    const uv = uvRectFor(placement, page);

    expect(uv.x).toBeGreaterThanOrEqual(0);
    expect(uv.y).toBeGreaterThanOrEqual(0);
    expect(uv.width).toBeGreaterThanOrEqual(0);
    expect(uv.height).toBeGreaterThanOrEqual(0);
    expect(uv.x).toBeLessThanOrEqual(1);
    expect(uv.y).toBeLessThanOrEqual(1);
    expect(uv.x + uv.width).toBeLessThanOrEqual(1);
    expect(uv.y + uv.height).toBeLessThanOrEqual(1);
  });

  it("1×1 degenerate source clamps gracefully (width and height >= 0, all in 0..1)", () => {
    const placement: AtlasPlacement = {
      id: "tiny",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    const page = { width: 256, height: 256 };
    // UV_INSET_PX=0.5: pw = 1 - 2*0.5 = 0, so the clamp must produce exactly 0.
    const uv = uvRectFor(placement, page, UV_INSET_PX);

    expect(uv.width).toBe(0);
    expect(uv.height).toBe(0);
    expect(uv.x).toBeGreaterThanOrEqual(0);
    expect(uv.y).toBeGreaterThanOrEqual(0);
    expect(uv.x + uv.width).toBeLessThanOrEqual(1);
    expect(uv.y + uv.height).toBeLessThanOrEqual(1);
  });

  it("custom inset=0 covers the full source rect exactly", () => {
    const placement: AtlasPlacement = {
      id: "c",
      x: 4,
      y: 8,
      width: 64,
      height: 32,
    };
    const page = { width: 128, height: 64 };
    const uv = uvRectFor(placement, page, 0);

    expect(uv.x).toBeCloseTo(4 / 128);
    expect(uv.y).toBeCloseTo(8 / 64);
    expect(uv.width).toBeCloseTo(64 / 128);
    expect(uv.height).toBeCloseTo(32 / 64);
  });
});

// ── uvRectFor + parseIkiModel round-trip ──────────────────────────────────────

describe("uvRectFor parseIkiModel round-trip", () => {
  it("uvRectFor result passes parseIkiModel validation without throwing", () => {
    const layout = packAtlas([{ id: "tex", width: 64, height: 64 }]);
    const placement = layout.placements[0];
    const page = { width: layout.pageWidth, height: layout.pageHeight };
    const uv = uvRectFor(placement, page);

    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "uv-round-trip",
      canvas: { width: 100, height: 100 },
      parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
      textures: [{ source: "data:image/png;base64,AA==" }],
      parts: [
        {
          id: "part-tex",
          color: [1, 1, 1, 1],
          width: 64,
          height: 64,
          order: 0,
          transform: { x: 0, y: 0 },
          texture: { index: 0, uv },
        },
      ],
    };

    expect(() => parseIkiModel(model)).not.toThrow();
  });
});
