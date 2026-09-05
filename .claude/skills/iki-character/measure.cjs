// Measure composed Iki role layers and flag the failure modes that have
// actually shipped broken characters. Read-only: it never edits anything.
//
// Usage:  node measure.cjs <layersDir>
//
// Exists because "the eyes look too big" is not actionable but "the iris is 33%
// of the sclera width, target 0.45-0.60" is. Every check below is one that cost
// a real regeneration or re-tune round to find by eye.
//
// Only dependency is `sharp`; run it where sharp resolves (e.g.
// NODE_PATH=packages/mcp/node_modules).
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const DIR = path.resolve(process.argv[2] ?? "layers");

// Iris width as a fraction of sclera width. Below the floor the eye reads as a
// bead floating in white — that is the failure this check was written for, and
// it caught a model that shipped at 0.33. The ceiling was a guess and it was
// too tight: measured on a real anime reference the iris runs about 0.70 of the
// eye, with the white reduced to corner crescents, so 0.6 flagged the correct
// value as a fault three rounds running.
const IRIS_RATIO_MIN = 0.45;
const IRIS_RATIO_MAX = 0.72;
// A sclera flatter than this cannot hold a round iris: the iris overflows the
// lids no matter how narrow it is.
const EYE_ASPECT_MIN = 0.5;
// Iris centre may sit at most this far (px) from the white's centre of mass.
const IRIS_OFFSET_MAX = 3;
// A cropped part shows a long, nearly-continuous opaque run along one bbox edge,
// and that straight seam appears the moment the head turns. A round part's edge
// row is a short tangent run, so a fraction test alone flags every iris; both a
// high fraction AND real length are required to separate the two. Observed:
// genuine crops read 60-93%, circle tangents 8-14%.
const EDGE_SOLID_MAX = 0.5;
const EDGE_RUN_MIN_PX = 40;
// Longest straight "art appears out of nothing" run tolerated inside a part, as
// a fraction of its width. A body generated with hair draped over the shoulders
// had that hair cut flat by its own frame; the cut hid behind the head at rest
// and opened into a seam on turn. Measured: that part ran 15% of its width,
// a clean one 5%, so the boundary sits between them.
const FLAT_CUT_MAX_FRAC = 0.1;
// ...and long in absolute terms. A mouth's upper lip is a naturally horizontal
// run that clears the fraction test on a narrow part while being only ~15px.
const FLAT_CUT_MIN_PX = 40;
// The cut is antialiased, so the transition is a soft cliff rather than
// transparent-to-opaque; 8/200 finds nothing at all on real art.
const FLAT_CUT_ALPHA_ABOVE = 120;
const FLAT_CUT_ALPHA_BELOW = 140;

async function stats(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const W = info.width;
  const H = info.height;
  const alpha = (x, y) => data[(y * W + x) * ch + 3];

  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha(x, y) > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;
        n++;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent

  const edge = (pts) => pts.filter((v) => v > 200).length / pts.length;
  const top = [];
  const bottom = [];
  const left = [];
  const right = [];
  for (let x = minX; x <= maxX; x++) {
    top.push(alpha(x, minY));
    bottom.push(alpha(x, maxY));
  }
  for (let y = minY; y <= maxY; y++) {
    left.push(alpha(minX, y));
    right.push(alpha(maxX, y));
  }

  // Longest contiguous run of pixels where the art appears out of nothing along
  // one row — transparent above, opaque below. Organic art (hair, cloth) meets
  // its silhouette at an angle, so a long FLAT run like this means the source
  // image was cropped through the drawing. It is often interior to the bbox
  // (a hair strand cut short above a wider shoulder line), which is why the
  // bbox-edge test alone misses it, and it only becomes visible once the head
  // turns and uncovers the cut.
  let flatCutRun = 0;
  let flatCutY = -1;
  for (let y = minY + 1; y <= maxY; y++) {
    let run = 0;
    for (let x = minX; x <= maxX; x++) {
      if (
        alpha(x, y - 1) < FLAT_CUT_ALPHA_ABOVE &&
        alpha(x, y) > FLAT_CUT_ALPHA_BELOW
      ) {
        run++;
        if (run > flatCutRun) {
          flatCutRun = run;
          flatCutY = y;
        }
      } else {
        run = 0;
      }
    }
  }

  return {
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    flatCutRun,
    flatCutY,
    bboxCx: (minX + maxX) / 2,
    bboxCy: (minY + maxY) / 2,
    massCx: sumX / n,
    massCy: sumY / n,
    // Distance from the layer's content to each canvas edge.
    marginTop: minY,
    marginBottom: H - 1 - maxY,
    marginLeft: minX,
    marginRight: W - 1 - maxX,
    edgeTop: edge(top),
    edgeBottom: edge(bottom),
    edgeLeft: edge(left),
    edgeRight: edge(right),
    canvasW: W,
    canvasH: H,
  };
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`layers dir not found: ${DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".png") && f !== "preview.png")
    .sort();
  if (files.length === 0) {
    console.error(`no role layers in ${DIR}`);
    process.exit(1);
  }

  const s = {};
  console.log(`# layers  (${DIR})\n`);
  console.log(
    "role          size        bbox-centre    mass-centre   margins t/b/l/r",
  );
  for (const f of files) {
    const role = path.basename(f, ".png");
    const m = await stats(path.join(DIR, f));
    if (!m) {
      console.log(`${role.padEnd(13)} EMPTY (fully transparent)`);
      continue;
    }
    s[role] = m;
    console.log(
      `${role.padEnd(13)} ${`${m.w}x${m.h}`.padEnd(11)} ` +
        `${`${m.bboxCx.toFixed(0)},${m.bboxCy.toFixed(0)}`.padEnd(14)} ` +
        `${`${m.massCx.toFixed(0)},${m.massCy.toFixed(0)}`.padEnd(13)} ` +
        `${m.marginTop}/${m.marginBottom}/${m.marginLeft}/${m.marginRight}`,
    );
  }

  const warn = [];

  // 1. Art running to its own edge → a straight seam appears on head turn.
  for (const [role, m] of Object.entries(s)) {
    const span = { top: m.w, bottom: m.w, left: m.h, right: m.h };
    for (const [side, v] of [
      ["top", m.edgeTop],
      ["left", m.edgeLeft],
      ["right", m.edgeRight],
      // A torso is meant to run off the bottom of the canvas.
      ...(role === "body" ? [] : [["bottom", m.edgeBottom]]),
    ]) {
      if (v > EDGE_SOLID_MAX && v * span[side] >= EDGE_RUN_MIN_PX) {
        warn.push(
          `${role}: ${pct(v)} of its ${side} edge is opaque — the art is cut off there, ` +
            `which shows as a straight seam once the head turns. Regenerate with empty margin on that side.`,
        );
      }
    }
  }

  // 1b. A straight cut through the drawing, wherever it falls in the bbox.
  for (const [role, m] of Object.entries(s)) {
    // `body` is the one role rigged to no deformer, so it cannot move and no
    // pose can uncover a cut in it. Its neck is deliberately cut flat at the
    // top, where the jaw covers it; flagging that is a false positive.
    if (role === "body") continue;
    if (
      m.flatCutRun > FLAT_CUT_MAX_FRAC * m.w &&
      m.flatCutRun >= FLAT_CUT_MIN_PX
    ) {
      warn.push(
        `${role}: ${m.flatCutRun}px of straight flat edge at y=${m.flatCutY} ` +
          `(${pct(m.flatCutRun / m.w)} of its width) — the source art is cut through there. ` +
          `It hides while the head faces front and opens into a seam on turn. ` +
          `Regenerate this part with the whole subject inside the frame.`,
      );
    }
  }

  // 2/3/4. Eye stack geometry, per side.
  for (const side of ["L", "R"]) {
    const eye = s[`eye_${side}`];
    const iris = s[`iris_${side}`];
    const lash = s[`lash_${side}`];
    if (!eye) continue;

    const aspect = eye.h / eye.w;
    if (aspect < EYE_ASPECT_MIN) {
      warn.push(
        `eye_${side}: sclera aspect h/w=${aspect.toFixed(2)} is flatter than ${EYE_ASPECT_MIN} — ` +
          `a round iris cannot sit inside it. Regenerate the eyewhite taller, not the iris smaller.`,
      );
    }

    if (iris) {
      const ratio = iris.w / eye.w;
      if (ratio < IRIS_RATIO_MIN || ratio > IRIS_RATIO_MAX) {
        warn.push(
          `iris_${side}: width is ${pct(ratio)} of the sclera (target ${IRIS_RATIO_MIN}-${IRIS_RATIO_MAX}) — ` +
            `retune LAYOUT IRIS_W, no regeneration needed.`,
        );
      }
      const dx = iris.bboxCx - eye.massCx;
      const dy = iris.bboxCy - eye.massCy;
      if (Math.abs(dx) > IRIS_OFFSET_MAX || Math.abs(dy) > IRIS_OFFSET_MAX) {
        warn.push(
          `iris_${side}: sits (${dx.toFixed(1)}, ${dy.toFixed(1)}) px from the white's centre of mass — ` +
            `retune LAYOUT iris_${side} cx/cy. The sclera's bbox centre is NOT its visual centre when the ` +
            `lash flick stretches the box.`,
        );
      }
    }

    // 5. The lash and the white are split from ONE source and pasted with the
    // same cx/cy/w, so their frames coincide even though the lash only inks the
    // upper part of it (its content sits higher — that is the fold working, not
    // a fault). What must line up is the horizontal centre and the top edge; a
    // drift there means the two LAYOUT entries fell out of sync and the fold
    // will tear.
    if (lash) {
      const dx = lash.bboxCx - eye.bboxCx;
      const dTop = lash.marginTop - eye.marginTop;
      if (Math.abs(dx) > 0.5 || Math.abs(dTop) > 0.5) {
        warn.push(
          `lash_${side}: centre is ${dx.toFixed(1)} px and top edge ${dTop.toFixed(1)} px off eye_${side}. ` +
            `They are split from one source and MUST share cx/cy/w in LAYOUT, or the blink fold tears. Retune to match.`,
        );
      }
    }
  }

  // 6. Optional roles that change how finished the character reads.
  for (const [role, why] of [
    ["body", "without it the character reads as a floating head on head-turn"],
    ["hair_back", "without it the silhouette is flat behind the face"],
  ]) {
    if (!s[role]) warn.push(`${role}: missing — ${why}.`);
  }

  console.log(`\n# checks\n`);
  if (warn.length === 0) {
    console.log("all geometry checks passed");
  } else {
    for (const w of warn) console.log(`- ${w}`);
  }
})();
