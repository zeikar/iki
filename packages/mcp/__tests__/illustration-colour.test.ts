import { describe, expect, it } from "vitest";
import type { Illustration, Point } from "../src/illustration";
import {
  buildClassifier,
  HAIR,
  NEITHER,
  readSample,
  readSamples,
  SKIN,
  srgbToOklab,
  withoutSample,
} from "../src/illustration-colour";
import type { IllustrationSamples } from "../src/illustration-landmarks";

type RGB = [number, number, number];

/** A strip of 20 x 20 swatches on a transparent picture, one per colour;
 *  swatch k is centred on (10 + 20k, 10). */
function swatches(colours: RGB[]): Illustration {
  const width = 20 * colours.length;
  const height = 20;
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgb.set(colours[Math.floor(x / 20)], (y * width + x) * 3);
    }
  }
  return { width, height, rgb, alpha, background: "transparent" };
}

const at = (k: number): Point => [10 + 20 * k, 10];

/** The classifier for hair swatches `hair` (base, then shadow, then
 *  highlight) and skin swatches `skin` (base, then shadow). */
function classifierFor(hair: RGB[], skin: RGB[]) {
  const pic = swatches([...hair, ...skin]);
  const samples: IllustrationSamples = {
    hair: { base: [at(0)] },
    skin: { base: [at(hair.length)] },
  };
  if (hair[1]) samples.hair.shadow = [at(1)];
  if (hair[2]) samples.hair.highlight = [at(2)];
  if (skin[1]) samples.skin.shadow = [at(hair.length + 1)];
  return buildClassifier(readSamples(pic, samples))!;
}

const name = (c: number) => ["neither", "hair", "skin"][c];
const expectClass = (
  cl: ReturnType<typeof classifierFor>,
  colour: RGB,
  want: number,
) => expect(name(cl.classify(...colour)), String(colour)).toBe(name(want));

describe("srgbToOklab", () => {
  it("puts white at L 1 and black at L 0, both without chroma", () => {
    const white = srgbToOklab(255, 255, 255);
    expect(white[0]).toBeCloseTo(1, 3);
    expect(Math.hypot(white[1], white[2])).toBeLessThan(1e-3);
    expect(srgbToOklab(0, 0, 0)).toEqual([0, 0, 0]);
  });
});

describe("readSample", () => {
  it("reads its patch's median, the backdrop left out, and says whether it is on paint", () => {
    const pic = swatches([[240, 150, 175]]);
    // A line through the patch's middle column: the median ignores it.
    for (let y = 0; y < 20; y++) pic.rgb.set([40, 30, 40], (y * 20 + 10) * 3);
    const onLine = readSample(pic, [10, 10], "s");
    expect(onLine.rgb).toEqual([240, 150, 175]);
    expect(onLine.onPaint).toBe(true);

    pic.alpha.fill(0, 0, 20 * 10);
    const edge = readSample(pic, [10, 9], "s");
    expect(edge.onPaint).toBe(false);
    expect(edge.rgb).toEqual([240, 150, 175]);
    expect(readSample(pic, [10, 2], "s").lab).toBeNull();
  });

  it("names each sample by its landmark path", () => {
    const pic = swatches([
      [240, 150, 175],
      [255, 232, 215],
    ]);
    const reads = readSamples(pic, {
      hair: { base: [at(0)], highlight: [at(0)] },
      skin: { base: [at(1)] },
    });
    expect(reads.hair.map((r) => r.path)).toEqual([
      "landmarks.samples.hair.base[0]",
      "landmarks.samples.hair.highlight[0]",
    ]);
    expect(reads.skin[0].path).toBe("landmarks.samples.skin.base[0]");
  });
});

describe("buildClassifier", () => {
  const GREY: RGB = [128, 128, 128];
  const INK: RGB = [40, 30, 40];

  it("splits pink hair from peach skin, and leaves grey and ink to neither", () => {
    const cl = classifierFor(
      [
        [240, 150, 175],
        [205, 115, 145],
      ],
      [[255, 232, 215]],
    );
    expectClass(cl, [240, 150, 175], HAIR);
    expectClass(cl, [225, 135, 160], HAIR); // between base and shadow
    expectClass(cl, [180, 95, 125], HAIR); // past the shadow, far from skin
    expectClass(cl, [255, 232, 215], SKIN);
    expectClass(cl, [250, 222, 205], SKIN);
    expectClass(cl, GREY, NEITHER);
    expectClass(cl, INK, NEITHER);
    expectClass(cl, [200, 30, 40], NEITHER); // a ribbon
    expectClass(cl, [80, 90, 160], NEITHER); // cloth
  });

  it("splits orange hair from warm skin, two close sets", () => {
    const cl = classifierFor(
      [
        [230, 130, 60],
        [195, 100, 45],
        [250, 175, 100],
      ],
      [
        [250, 205, 170],
        [230, 180, 145],
      ],
    );
    expect(cl.separation).toBeLessThan(0.06);
    expectClass(cl, [215, 115, 55], HAIR);
    expectClass(cl, [245, 165, 95], HAIR);
    expectClass(cl, [250, 205, 170], SKIN);
    expectClass(cl, [240, 190, 155], SKIN);
    expectClass(cl, GREY, NEITHER);
    expectClass(cl, [90, 45, 30], NEITHER); // a brown line
  });

  it("splits near-black hair from peach skin, and still leaves grey to neither", () => {
    const cl = classifierFor(
      [
        [35, 30, 40],
        [20, 18, 25],
      ],
      [[255, 232, 215]],
    );
    expectClass(cl, [30, 28, 35], HAIR);
    expectClass(cl, [255, 232, 215], SKIN);
    expectClass(cl, GREY, NEITHER);
    expectClass(cl, [200, 30, 40], NEITHER);
  });

  it("is not widened by one sample on a busy patch", () => {
    const PINK: RGB = [240, 150, 175];
    const pic = swatches([PINK, PINK, [255, 232, 215]]);
    // Sample 1's patch: a third pink, the rest far darker and far lighter,
    // so its median is pink and its noise large.
    for (let k = 0; k < 25; k++) {
      const x = 28 + (k % 5);
      const y = 8 + Math.floor(k / 5);
      const shade: RGB =
        k % 3 === 0 ? PINK : k % 3 === 1 ? [120, 40, 70] : [255, 230, 245];
      pic.rgb.set(shade, (y * 60 + x) * 3);
    }
    const reads = readSamples(pic, {
      hair: { base: [at(0)], highlight: [at(1)] },
      skin: { base: [at(2)] },
    });
    expect(reads.hair[1].rgb).toEqual(PINK);
    expect(reads.hair[1].noise).toBeGreaterThan(0.1);
    const cl = buildClassifier(reads)!;
    expect(name(cl.classify(...GREY))).toBe("neither");
  });

  it("sends a tie to hair: two sets sampled on the same (lightly textured) paint", () => {
    const PINK: RGB = [240, 150, 175];
    const pic = swatches([PINK, PINK]);
    // A grain of a few levels, so each set has a reach to tie within.
    for (let i = 0; i < pic.width * pic.height; i++) {
      if (i % 3 === 1) pic.rgb.set([246, 156, 181], i * 3);
      if (i % 3 === 2) pic.rgb.set([234, 144, 169], i * 3);
    }
    const cl = buildClassifier(
      readSamples(pic, { hair: { base: [at(0)] }, skin: { base: [at(1)] } }),
    )!;
    expect(cl.separation).toBe(0);
    expectClass(cl, PINK, HAIR);
    expectClass(cl, GREY, NEITHER);
  });

  it("judges a sample by the others: withoutSample leaves it out, base count kept right", () => {
    const pic = swatches([
      [240, 150, 175],
      [240, 150, 175],
      [255, 232, 215],
    ]);
    const reads = readSamples(pic, {
      hair: { base: [at(0), at(1)], shadow: [at(1)] },
      skin: { base: [at(2)] },
    });
    const out = withoutSample(reads, "landmarks.samples.hair.base[0]");
    expect(out.hair.map((r) => r.path)).toEqual([
      "landmarks.samples.hair.base[1]",
      "landmarks.samples.hair.shadow[0]",
    ]);
    expect(out.hairBase).toBe(1);
    expect(out.skin).toBe(reads.skin);
  });

  it("gives no classifier when a set has no sample on paint", () => {
    const pic = swatches([[240, 150, 175]]);
    pic.alpha.fill(0);
    pic.alpha.fill(1, 0, 10);
    expect(
      buildClassifier(
        readSamples(pic, {
          hair: { base: [[5, 0]] },
          skin: { base: [[10, 15]] },
        }),
      ),
    ).toBeNull();
  });
});
