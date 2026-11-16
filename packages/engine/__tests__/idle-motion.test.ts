import { describe, expect, it } from "vitest";
import { type IkiParameter, StandardParameter } from "@ikijs/format";
import { IdleMotion } from "@ikijs/engine";
import { blinkEnvelope, breathEnvelope } from "../src/idle-motion";

// Local timing literals matching the impl's intent — NOT imported from impl.
const BLINK_CLOSE_MS = 60;
const BLINK_HOLD_MS = 20;
const BLINK_DURATION_MS = 180;
const BREATH_IN_END = 0.4;
const BREATH_OUT_END = 0.88;
const BREATH_PERIOD_MIN_MS = 3200;
const BREATH_PERIOD_MAX_MS = 4600;
// Degrees the nod lifts at full breath.
const BREATH_PITCH_DEG = 1;
const GAZE_X_MAX = 0.8;
const GAZE_Y_MAX = 0.5;
const GAZE_RETARGET_MIN_MS = 800;
const GAZE_RETARGET_MAX_MS = 3300;
const GAZE_EYE_CONTACT_P = 0.4;
const DOUBLE_BLINK_P = 0.18;
const DOUBLE_BLINK_GAP_MS = 70;
const BROW_BLINK_DIP = 0.06;
// Head degrees per unit of gaze target, turn and nod.
const HEAD_FOLLOW_X_DEG = 10;
const HEAD_FOLLOW_Y_DEG = 10;

const EMITTED_IDS = new Set([
  StandardParameter.EyeOpenLeft,
  StandardParameter.EyeOpenRight,
  StandardParameter.Breath,
  StandardParameter.EyeballX,
  StandardParameter.EyeballY,
  StandardParameter.AngleX,
  StandardParameter.AngleY,
  StandardParameter.AngleZ,
  StandardParameter.AmbientSway,
]);

// A model's declared brow Y parameters, the ones the blink dip writes.
const BROWS = [
  { id: StandardParameter.BrowLeftY, min: -1, max: 1, default: 0 },
  { id: StandardParameter.BrowRightY, min: -1, max: 1, default: 0 },
];
// The ids idle writes for a model that declares both brows.
const EMITTED_IDS_WITH_BROWS = new Set([
  ...EMITTED_IDS,
  StandardParameter.BrowLeftY,
  StandardParameter.BrowRightY,
]);

// Head-idle noise amplitudes matching the impl's intent — NOT imported from impl.
const HEAD_NOISE_X_DEG = 6;
const HEAD_NOISE_Y_DEG = 4;
// The turn and nod add the gaze follow on top of their noise.
const HEAD_X_MAX_DEG = HEAD_NOISE_X_DEG + HEAD_FOLLOW_X_DEG * GAZE_X_MAX;
// The nod also lifts with each breath.
const HEAD_Y_MAX_DEG =
  HEAD_NOISE_Y_DEG + HEAD_FOLLOW_Y_DEG * GAZE_Y_MAX + BREATH_PITCH_DEG;
const HEAD_Z_MAX_DEG = 4;
// The springs chasing the noise may overshoot it a little.
const SPRING_OVERSHOOT = 1.1;

/** Build a capturing sink → Map<id, emitted values in order>. */
function makeSink(): {
  sink: (id: string, value: number) => void;
  emissions: Map<string, number[]>;
} {
  const emissions = new Map<string, number[]>();
  const sink = (id: string, value: number) => {
    if (!emissions.has(id)) emissions.set(id, []);
    emissions.get(id)!.push(value);
  };
  return { sink, emissions };
}

/**
 * Drive an IdleMotion through `timestamps`, collecting all emissions.
 * Returns emissions after all updates.
 */
function drive(
  timestamps: number[],
  rng: () => number,
  parameters?: IkiParameter[],
): Map<string, number[]> {
  const { sink, emissions } = makeSink();
  const motion = new IdleMotion(sink, { rng, parameters });
  for (const t of timestamps) {
    motion.update(t);
  }
  return emissions;
}

/** A seeded 32-bit LCG in [0, 1): realistic, distinct draws for every seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** RNG returning values from a fixed array, cycling when exhausted. */
function cyclingRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

/**
 * Build a timestamp array: start at `startMs`, take `count` steps of
 * `stepMs` each.  First element is the "first update" anchor.
 */
function timestamps(startMs: number, count: number, stepMs: number): number[] {
  return Array.from({ length: count }, (_, i) => startMs + i * stepMs);
}

// ---------------------------------------------------------------------------
// sink-only contract
// ---------------------------------------------------------------------------

describe("IdleMotion survives a non-finite timestamp", () => {
  // `clockMs += NaN` sticks, and every blink/gaze schedule reads clockMs — one
  // bad frame would leave the face permanently still.
  it("drops the bad frame and keeps animating", () => {
    const seen = new Map<string, number>();
    const idle = new IdleMotion((id, v) => seen.set(id, v), { rng: () => 0.5 });
    idle.update(0);
    idle.update(NaN);
    const afterBadFrame = JSON.stringify([...seen]);
    for (let t = 100; t <= 4000; t += 100) idle.update(t);
    expect(JSON.stringify([...seen])).not.toBe(afterBadFrame);
  });
});

describe("sink-only contract", () => {
  it("emits exactly the 9 standard parameter ids", () => {
    const emissions = drive(timestamps(0, 10, 100), cyclingRng([0.5]));
    expect(new Set(emissions.keys())).toEqual(EMITTED_IDS);
  });

  it("publishes the ids it emits — same set, write order, no duplicates", () => {
    const ids = new IdleMotion(() => {}).drivenParameterIds;
    expect(new Set(ids)).toEqual(EMITTED_IDS);
    expect(ids).toHaveLength(EMITTED_IDS.size);
    // Map keys keep first-insertion order, so one drive's key order IS the write order.
    const emissions = drive(timestamps(0, 10, 100), cyclingRng([0.5]));
    expect([...emissions.keys()]).toEqual([...ids]);
  });

  it("with the brows declared, emits them too and publishes them after the eyes, in write order", () => {
    const ids = new IdleMotion(() => {}, { parameters: BROWS })
      .drivenParameterIds;
    expect(new Set(ids)).toEqual(EMITTED_IDS_WITH_BROWS);
    expect(ids).toHaveLength(EMITTED_IDS_WITH_BROWS.size);
    expect(ids.slice(0, 4)).toEqual([
      StandardParameter.EyeOpenLeft,
      StandardParameter.EyeOpenRight,
      StandardParameter.BrowLeftY,
      StandardParameter.BrowRightY,
    ]);
    const emissions = drive(timestamps(0, 10, 100), cyclingRng([0.5]), BROWS);
    expect([...emissions.keys()]).toEqual([...ids]);
  });

  it("writes only the brows the model declares, and none for other parameters", () => {
    const left = [BROWS[0], { id: "ParamOther", min: 0, max: 1, default: 0 }];
    const ids = new IdleMotion(() => {}, { parameters: left })
      .drivenParameterIds;
    expect(new Set(ids)).toEqual(
      new Set([...EMITTED_IDS, StandardParameter.BrowLeftY]),
    );
    const emissions = drive(timestamps(0, 10, 100), cyclingRng([0.5]), left);
    expect([...emissions.keys()]).toEqual([...ids]);
    // Declaring no brow leaves the list as it was.
    const none = new IdleMotion(() => {}, { parameters: [left[1]] })
      .drivenParameterIds;
    expect(none).toEqual(new IdleMotion(() => {}).drivenParameterIds);
  });

  it("first update emits resting pose: eyes=1, brows=0, breath=0, gaze=0,0, sway=0,0, ambient=0", () => {
    const { sink, emissions } = makeSink();
    const motion = new IdleMotion(sink, {
      rng: cyclingRng([0.5]),
      parameters: BROWS,
    });
    motion.update(1000);
    expect(emissions.get(StandardParameter.EyeOpenLeft)![0]).toBe(1);
    expect(emissions.get(StandardParameter.EyeOpenRight)![0]).toBe(1);
    expect(emissions.get(StandardParameter.BrowLeftY)![0]).toBe(0);
    expect(emissions.get(StandardParameter.BrowRightY)![0]).toBe(0);
    expect(emissions.get(StandardParameter.Breath)![0]).toBe(0);
    expect(emissions.get(StandardParameter.EyeballX)![0]).toBe(0);
    expect(emissions.get(StandardParameter.EyeballY)![0]).toBe(0);
    expect(emissions.get(StandardParameter.AngleX)![0]).toBe(0);
    expect(emissions.get(StandardParameter.AngleY)![0]).toBe(0);
    expect(emissions.get(StandardParameter.AngleZ)![0]).toBe(0);
    expect(emissions.get(StandardParameter.AmbientSway)![0]).toBe(0);
  });

  it("every update (including first) emits exactly all its ids, brows included", () => {
    const N = 20;
    for (const parameters of [undefined, BROWS]) {
      const emissions = drive(
        timestamps(0, N, 100),
        cyclingRng([0.5]),
        parameters,
      );
      const counts = [...emissions.values()].map((v) => v.length);
      expect(counts.every((c) => c === N)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// blink envelope (pure function)
// ---------------------------------------------------------------------------

describe("blink envelope", () => {
  const CLOSE_PHASE = BLINK_CLOSE_MS / BLINK_DURATION_MS; // 1/3
  const HOLD_END_PHASE = (BLINK_CLOSE_MS + BLINK_HOLD_MS) / BLINK_DURATION_MS; // 4/9

  it("is 1 at both endpoints and for any phase outside [0, 1]", () => {
    expect(blinkEnvelope(0)).toBe(1);
    expect(blinkEnvelope(1)).toBe(1);
    expect(blinkEnvelope(-0.5)).toBe(1);
    expect(blinkEnvelope(-0.001)).toBe(1);
    expect(blinkEnvelope(1.5)).toBe(1);
  });

  it("is shut (0) across the whole hold, phase ∈ [CLOSE/T, (CLOSE+HOLD)/T]", () => {
    for (let i = 0; i <= 1000; i++) {
      const phase = CLOSE_PHASE + (i / 1000) * (HOLD_END_PHASE - CLOSE_PHASE);
      expect(blinkEnvelope(phase)).toBe(0);
    }
  });

  it("is monotone: non-increasing while closing, non-decreasing while opening", () => {
    let prevClose = blinkEnvelope(0);
    for (let i = 1; i <= 1000; i++) {
      const v = blinkEnvelope((i / 1000) * CLOSE_PHASE);
      expect(v).toBeLessThanOrEqual(prevClose + 1e-9);
      prevClose = v;
    }
    let prevOpen = blinkEnvelope(HOLD_END_PHASE);
    for (let i = 1; i <= 1000; i++) {
      const phase = HOLD_END_PHASE + (i / 1000) * (1 - HOLD_END_PHASE);
      const v = blinkEnvelope(phase);
      expect(v).toBeGreaterThanOrEqual(prevOpen - 1e-9);
      prevOpen = v;
    }
  });

  it("is asymmetric: first zero at phase 1/3 < 0.5, and the open span exceeds the close span", () => {
    let firstZero = -1;
    let lastZero = -1;
    for (let i = 0; i <= 1000; i++) {
      if (blinkEnvelope(i / 1000) === 0) {
        if (firstZero === -1) firstZero = i;
        lastZero = i;
      }
    }
    expect(firstZero / 1000).toBeCloseTo(CLOSE_PHASE, 2);
    expect(1 - lastZero / 1000).toBeGreaterThan(firstZero / 1000);
    expect(blinkEnvelope(CLOSE_PHASE - 1e-6)).toBeGreaterThan(0);
    expect(blinkEnvelope(CLOSE_PHASE)).toBe(0);
    expect(blinkEnvelope(HOLD_END_PHASE)).toBe(0);
    expect(blinkEnvelope(HOLD_END_PHASE + 1e-6)).toBeGreaterThan(0);
  });

  it("has smooth (eased) ends, not a linear corner", () => {
    // A symmetric linear triangle would give 0.98 / 0.98 here — this pins the easing.
    expect(blinkEnvelope(0.01)).toBeGreaterThan(0.99);
    expect(blinkEnvelope(0.99)).toBeGreaterThan(0.99);
  });

  it("stays within [0, 1] across the whole phase range", () => {
    for (let i = 0; i <= 1000; i++) {
      const v = blinkEnvelope(i / 1000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// blink
// ---------------------------------------------------------------------------

describe("blink", () => {
  /**
   * With rng()[0]=0: nextBlinkAtMs = lerp(1500, 6000, 0) = 1500.
   * With rng()[1]=1: nextGazeRetargetMs = lerp(800, 3300, 1) = 3300 (safely after blink).
   * dt is clamped to 100ms, so advancing clock by 1500ms needs 15 steps.
   * After the first (anchor) update: prevNowMs = 0, clockMs stays 0.
   * Then 15 updates of 100ms → clockMs = 1500 → blink triggers.
   *
   * During blink: clockMs ∈ [1500, 1680]. Fine-step through it.
   */
  it("eye values dip near 0 at mid-blink and return to 1 after, asymmetrically", () => {
    const { sink, emissions } = makeSink();
    // rng call order: [0]=blinkAt (0→1500ms), [1]=gazeAt (1→3300ms, past our test window)
    // [2..4]=head noise seeds, [5]=breath period (0.5→3900ms, past the window),
    // [6]=double-blink coin after the blink ends (past the window's checks)
    const rng = cyclingRng([0, 1, 0.5]);
    const motion = new IdleMotion(sink, { rng });

    // Step 1: anchor at t=0 (first update — resting pose, no clock advance)
    motion.update(0);

    // Advance clock to just before blink (1400ms = 14 steps of 100ms)
    for (let i = 1; i <= 14; i++) {
      motion.update(i * 100);
    }
    const leftBeforeBlink = emissions.get(StandardParameter.EyeOpenLeft)!;
    const lastBeforeBlink = leftBeforeBlink[leftBeforeBlink.length - 1];
    expect(lastBeforeBlink).toBe(1); // still fully open before blink

    // Step at clock=1500: blink starts here (clockMs hits 1500)
    motion.update(1500);

    // Fine-step through the whole blink window at 20ms, bound from the local
    // constant (not a literal) so a retune of the timing constants doesn't
    // silently stop covering the tail of the envelope.
    for (let ms = 1520; ms <= 1500 + BLINK_DURATION_MS; ms += 20) {
      motion.update(ms);
    }

    const leftSeries = emissions.get(StandardParameter.EyeOpenLeft)!;
    const rightSeries = emissions.get(StandardParameter.EyeOpenRight)!;

    // Both eye series must be identical at every step
    expect(leftSeries).toEqual(rightSeries);

    // Updates during blink are indices 15 (clockMs=1500) through 24 (clockMs=1680)
    const blinkSlice = leftSeries.slice(15); // from clock=1500 onward
    // The dip must sit across the HOLD of the envelope, not the edges: at
    // blink start (phase 0) the eye is still open, at the close point (60ms
    // in) it is shut, and it stays shut through the hold.
    expect(blinkSlice[0]).toBeCloseTo(1, 5); // clockMs=1500, phase 0 → open
    expect(blinkSlice[3]).toBe(0); // clockMs=1560, close point → shut
    expect(blinkSlice[4]).toBe(0); // clockMs=1580, hold end → still shut

    // After blink completes (last sample in blinkSlice), eyes return to 1
    const lastInSlice = blinkSlice[blinkSlice.length - 1];
    expect(lastInSlice).toBe(1); // clockMs=1680

    // Asymmetry, observed on the driven series: fewer non-zero samples on the
    // way down to the first 0 than on the way up from the last 0 back to 1.
    const zeroIndices = blinkSlice
      .map((v, i) => (v === 0 ? i : -1))
      .filter((i) => i >= 0);
    const firstZero = zeroIndices[0];
    const lastZero = zeroIndices[zeroIndices.length - 1];
    const closingSamples = blinkSlice.slice(1, firstZero); // 1520, 1540
    const openingSamples = blinkSlice.slice(
      lastZero + 1,
      blinkSlice.length - 1,
    ); // 1600–1660
    expect(closingSamples).toHaveLength(2);
    expect(openingSamples).toHaveLength(4);
    expect(closingSamples.length).toBeLessThan(openingSamples.length);
  });

  it("eyes stay at 1 between blinks", () => {
    // rng()=1 → blinkAt = lerp(1500,6000,1) = 6000 (far away)
    const emissions = drive(
      timestamps(0, 30, 100), // 30 updates, max clock=2800ms — no blink
      cyclingRng([1]),
    );
    const leftSeries = emissions.get(StandardParameter.EyeOpenLeft)!;
    // All values after first update (resting=1 included) must be 1
    expect(leftSeries.every((v) => v === 1)).toBe(true);
  });

  it("the two eye parameters carry identical values at every step", () => {
    const emissions = drive(
      timestamps(0, 50, 40), // 50 updates, 40ms steps
      cyclingRng([0, 0.5]), // triggers blink at 1500ms
    );
    const left = emissions.get(StandardParameter.EyeOpenLeft)!;
    const right = emissions.get(StandardParameter.EyeOpenRight)!;
    expect(left).toEqual(right);
  });
});

describe("double blink", () => {
  const FRAME_MS = 10;
  const TEN_MIN = timestamps(0, 600000 / FRAME_MS + 1, FRAME_MS);
  const SEEDS = [1, 7, 42, 99, 2024];

  type Blink = { start: number; end: number };

  /**
   * Each blink a run made, read off EyeOpenLeft: the frame before its first
   * closed sample (phase 0 writes 1) to the frame after its last (the frame
   * the finish is seen on), in ms. On 10 ms frames neither edge is rounded.
   */
  function blinksOf(emissions: Map<string, number[]>): Blink[] {
    const eye = emissions.get(StandardParameter.EyeOpenLeft)!;
    const out: Blink[] = [];
    for (let k = 1; k < eye.length; k++) {
      if (eye[k] < 1 && eye[k - 1] === 1) {
        out.push({ start: (k - 1) * FRAME_MS, end: -1 });
      }
      if (eye[k] === 1 && eye[k - 1] < 1) out.at(-1)!.end = k * FRAME_MS;
    }
    return out.filter((b) => b.end >= 0);
  }

  const gaps = SEEDS.map((seed) => {
    const blinks = blinksOf(drive(TEN_MIN, lcg(seed)));
    return blinks.slice(1).map((b, i) => b.start - blinks[i].end);
  });

  it("a second blink starts 70 ms after the first reopens; every other gap is the usual 1.5–6 s", () => {
    for (const g of gaps.flat()) {
      if (g < 1000) {
        expect(g).toBe(DOUBLE_BLINK_GAP_MS);
      } else {
        expect(g).toBeGreaterThanOrEqual(1500);
        expect(g).toBeLessThanOrEqual(6000 + FRAME_MS);
      }
    }
  });

  it("about 18 % of blinks are followed by a second, and no pair runs to three", () => {
    let firsts = 0;
    let doubles = 0;
    for (const g of gaps) {
      for (let i = 0; i < g.length; i++) {
        const short = g[i] === DOUBLE_BLINK_GAP_MS;
        // A short gap after a short gap would be a third blink in the chain.
        if (short) expect(g[i - 1]).not.toBe(DOUBLE_BLINK_GAP_MS);
        // The blink before a gap that follows a pair is that pair's second:
        // it draws no coin, so it does not count as a first.
        if (i > 0 && g[i - 1] === DOUBLE_BLINK_GAP_MS) continue;
        firsts++;
        if (short) doubles++;
      }
    }
    expect(firsts).toBeGreaterThan(500);
    expect(doubles / firsts).toBeGreaterThan(DOUBLE_BLINK_P - 0.05);
    expect(doubles / firsts).toBeLessThan(DOUBLE_BLINK_P + 0.05);
  });
});

describe("brow blink dip", () => {
  const FRAME_MS = 16;
  const TWO_MIN = timestamps(0, 120000 / FRAME_MS + 1, FRAME_MS);

  it("each brow is −0.06 × (1 − its eye) at every step, so it drops with the blink", () => {
    for (const seed of [1, 7, 42]) {
      const emissions = drive(TWO_MIN, lcg(seed), BROWS);
      const left = emissions.get(StandardParameter.EyeOpenLeft)!;
      const right = emissions.get(StandardParameter.EyeOpenRight)!;
      const browL = emissions.get(StandardParameter.BrowLeftY)!;
      const browR = emissions.get(StandardParameter.BrowRightY)!;
      expect(browL).toHaveLength(TWO_MIN.length);
      left.forEach((eye, k) => {
        expect(browL[k]).toBeCloseTo(-BROW_BLINK_DIP * (1 - eye), 12);
        expect(browR[k]).toBeCloseTo(-BROW_BLINK_DIP * (1 - right[k]), 12);
      });
      // Blinks shut the eyes, so the dip reaches its full depth.
      expect(Math.min(...browL)).toBeCloseTo(-BROW_BLINK_DIP, 12);
    }
  });

  it("dips from each brow's own resting value: its default, clamped into range", () => {
    const raised = [
      { id: StandardParameter.BrowLeftY, min: 0, max: 1, default: 0.5 },
      // Out of range: rests at the clamped 0.8, as the player's store does.
      { id: StandardParameter.BrowRightY, min: -1, max: 0.8, default: 2 },
    ];
    const emissions = drive(TWO_MIN, lcg(1), raised);
    const eye = emissions.get(StandardParameter.EyeOpenLeft)!;
    const browL = emissions.get(StandardParameter.BrowLeftY)!;
    const browR = emissions.get(StandardParameter.BrowRightY)!;
    expect(browL[0]).toBe(0.5);
    expect(browR[0]).toBe(0.8);
    eye.forEach((e, k) => {
      expect(browL[k]).toBeCloseTo(0.5 - BROW_BLINK_DIP * (1 - e), 12);
      expect(browR[k]).toBeCloseTo(0.8 - BROW_BLINK_DIP * (1 - e), 12);
    });
    expect(Math.min(...browL)).toBeCloseTo(0.5 - BROW_BLINK_DIP, 12);
  });

  it("declaring the brows changes nothing else idle writes", () => {
    const plain = drive(TWO_MIN, lcg(3));
    const withBrows = drive(TWO_MIN, lcg(3), BROWS);
    for (const id of EMITTED_IDS) {
      expect(withBrows.get(id)).toEqual(plain.get(id));
    }
  });
});

// ---------------------------------------------------------------------------
// breath
// ---------------------------------------------------------------------------

describe("breath envelope", () => {
  it("is 0 at both ends, outside [0, 1], and from the end of the fall on", () => {
    expect(breathEnvelope(0)).toBe(0);
    expect(breathEnvelope(1)).toBe(0);
    expect(breathEnvelope(-0.5)).toBe(0);
    expect(breathEnvelope(1.5)).toBe(0);
    for (let i = 0; i <= 1000; i++) {
      const phase = BREATH_OUT_END + (i / 1000) * (1 - BREATH_OUT_END);
      expect(breathEnvelope(phase)).toBe(0);
    }
    expect(breathEnvelope(BREATH_OUT_END - 1e-6)).toBeGreaterThan(0);
  });

  it("peaks at 1 where the rise ends, and nowhere else", () => {
    expect(breathEnvelope(BREATH_IN_END)).toBe(1);
    expect(breathEnvelope(BREATH_IN_END - 1e-6)).toBeLessThan(1);
    expect(breathEnvelope(BREATH_IN_END + 1e-6)).toBeLessThan(1);
  });

  it("rises monotonically, then falls monotonically, staying in [0, 1]", () => {
    let prev = breathEnvelope(0);
    for (let i = 1; i <= 1000; i++) {
      const v = breathEnvelope((i / 1000) * BREATH_IN_END);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    for (let i = 1; i <= 1000; i++) {
      const phase =
        BREATH_IN_END + (i / 1000) * (BREATH_OUT_END - BREATH_IN_END);
      const v = breathEnvelope(phase);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });
});

describe("breath", () => {
  const FRAME_MS = 16;
  const TWO_MIN = timestamps(0, 120000 / FRAME_MS + 1, FRAME_MS);
  const runs = [1, 7, 42].map(
    (seed) => drive(TWO_MIN, lcg(seed)).get(StandardParameter.Breath)!,
  );

  it("all emitted values are in [0, 1], reaching both", () => {
    for (const series of runs) {
      for (const v of series) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Math.max(...series)).toBeGreaterThan(0.99);
      expect(series.filter((v) => v === 0).length).toBeGreaterThan(0);
    }
  });

  it("each cycle lasts 3.2–4.6 s, and the lengths vary", () => {
    for (const series of runs) {
      // A cycle starts on the frame its inhale leaves 0: the rest at the end
      // of each cycle writes exact zeros, so these frames are unambiguous.
      const starts: number[] = [];
      for (let k = 1; k < series.length; k++) {
        if (series[k] > 0 && series[k - 1] === 0) starts.push(k * FRAME_MS);
      }
      const lengths = starts.slice(1).map((t, i) => t - starts[i]);
      expect(lengths.length).toBeGreaterThan(20);
      for (const ms of lengths) {
        // Each start is seen up to one frame late.
        expect(ms).toBeGreaterThanOrEqual(BREATH_PERIOD_MIN_MS - FRAME_MS);
        expect(ms).toBeLessThanOrEqual(BREATH_PERIOD_MAX_MS + FRAME_MS);
      }
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeGreaterThan(500);
    }
  });

  it("wraps cleanly at the 100 ms frame cap: still one breath per cycle", () => {
    // Each step crosses at most one cycle boundary and draws one period.
    const series = drive(timestamps(0, 1201, 100), lcg(3)).get(
      StandardParameter.Breath,
    )!;
    let rises = 0;
    for (let k = 1; k < series.length; k++) {
      if (series[k] > 0 && series[k - 1] === 0) rises++;
    }
    // 120 s over 3.2–4.6 s cycles.
    expect(rises).toBeGreaterThanOrEqual(
      Math.floor(120000 / BREATH_PERIOD_MAX_MS),
    );
    expect(rises).toBeLessThanOrEqual(Math.ceil(120000 / BREATH_PERIOD_MIN_MS));
  });
});

// ---------------------------------------------------------------------------
// gaze
// ---------------------------------------------------------------------------

describe("gaze", () => {
  const FRAME_MS = 16;
  const TEN_MIN = timestamps(0, 600000 / FRAME_MS + 1, FRAME_MS);
  const SEEDS = [1, 7, 42];
  const runs = SEEDS.map((seed) => drive(TEN_MIN, lcg(seed)));
  // Per-frame eye movement under this is still. A hold (0.8 s at least) is
  // far longer than a landing (~0.3 s), so the eyes are still before every
  // jump, and the jump's first frame moves well over it.
  const STILL = 1e-4;
  // A settled position this close to (0, 0) is eye contact.
  const CONTACT = 1e-5;
  // A jump needs this many still frames before it (100 ms): a landing's
  // overshoot turns back through one still frame, a real hold is 0.8 s.
  const SETTLED_FRAMES = 6;

  type Hold = { frame: number; x: number; y: number };

  /**
   * The points a run's eyes hold, in order: the frame the eyes left for each
   * (the retarget's frame; 0 for the rest pose they start on) and where they
   * settled, read on the last still frame before the next jump. The last,
   * unfinished hold is left out. A retarget to the point already held (eye
   * contact twice) shows no jump, so it extends the hold.
   */
  function holdsOf(emissions: Map<string, number[]>): Hold[] {
    const xs = emissions.get(StandardParameter.EyeballX)!;
    const ys = emissions.get(StandardParameter.EyeballY)!;
    const moves = (k: number) =>
      Math.abs(xs[k] - xs[k - 1]) >= STILL ||
      Math.abs(ys[k] - ys[k - 1]) >= STILL;
    const out: Hold[] = [];
    let start = 0;
    for (let k = 1; k < xs.length; k++) {
      const settled =
        k === 1 ||
        (k > SETTLED_FRAMES &&
          Array.from({ length: SETTLED_FRAMES }, (_, i) => k - 1 - i).every(
            (j) => !moves(j),
          ));
      if (moves(k) && settled) {
        out.push({ frame: start, x: xs[k - 1], y: ys[k - 1] });
        start = k;
      }
    }
    return out;
  }
  const seen = runs.map(holdsOf);
  const isContact = (h: Hold) =>
    Math.abs(h.x) < CONTACT && Math.abs(h.y) < CONTACT;

  it("stays within ±0.8 / ±0.5, give or take a little spring overshoot", () => {
    const OVERSHOOT = 0.01;
    for (const emissions of runs) {
      for (const v of emissions.get(StandardParameter.EyeballX)!) {
        expect(Math.abs(v)).toBeLessThanOrEqual(GAZE_X_MAX + OVERSHOOT);
      }
      for (const v of emissions.get(StandardParameter.EyeballY)!) {
        expect(Math.abs(v)).toBeLessThanOrEqual(GAZE_Y_MAX + OVERSHOOT);
      }
    }
    // Where the eyes settle ranges over the box, not a small disk at its center.
    const all = seen.flat();
    for (const h of all) {
      expect(Math.abs(h.x)).toBeLessThanOrEqual(GAZE_X_MAX + CONTACT);
      expect(Math.abs(h.y)).toBeLessThanOrEqual(GAZE_Y_MAX + CONTACT);
    }
    expect(Math.max(...all.map((h) => Math.abs(h.x)))).toBeGreaterThan(0.7);
    expect(Math.max(...all.map((h) => Math.abs(h.y)))).toBeGreaterThan(0.4);
  });

  it("stays in range and settles at the 100 ms frame cap", () => {
    // Every frame a clamped 100 ms step: the stiff eye springs must not ring.
    const slow = drive(timestamps(0, 1201, 100), lcg(3));
    const xs = slow.get(StandardParameter.EyeballX)!;
    for (const v of xs) {
      expect(Math.abs(v)).toBeLessThanOrEqual(GAZE_X_MAX + 0.01);
    }
    // Each hold ends still: 0.8 s is long enough to land at any frame rate.
    const still = xs.filter((v, i) => i > 0 && Math.abs(v - xs[i - 1]) < 1e-4);
    expect(still.length).toBeGreaterThan(xs.length / 2);
  });

  it("returns to eye contact, (0, 0), on about 40 % of retargets", () => {
    // A jump away from a point off-center always shows, so the share of
    // those that land on (0, 0) is the eye-contact odds.
    let fromOff = 0;
    let toContact = 0;
    for (const hs of seen) {
      for (let i = 1; i < hs.length; i++) {
        if (isContact(hs[i - 1])) continue;
        fromOff++;
        if (isContact(hs[i])) toContact++;
      }
    }
    expect(fromOff).toBeGreaterThan(300);
    expect(toContact / fromOff).toBeGreaterThan(GAZE_EYE_CONTACT_P - 0.08);
    expect(toContact / fromOff).toBeLessThan(GAZE_EYE_CONTACT_P + 0.08);
  });

  it("holds each point for 0.8–3.3 s between retargets", () => {
    const offCenter: number[] = [];
    for (const hs of seen) {
      for (let i = 1; i < hs.length; i++) {
        const ms = (hs[i].frame - hs[i - 1].frame) * FRAME_MS;
        // A retarget fires on the first frame at or past its time.
        expect(ms).toBeGreaterThanOrEqual(GAZE_RETARGET_MIN_MS);
        // Eye contact may be held across two retargets, so only an off-center
        // hold is one interval for sure.
        if (!isContact(hs[i - 1])) offCenter.push(ms);
      }
    }
    for (const ms of offCenter) {
      expect(ms).toBeLessThan(GAZE_RETARGET_MAX_MS + FRAME_MS);
    }
    // Spread across the range, not one fixed beat.
    expect(Math.min(...offCenter)).toBeLessThan(1000);
    expect(Math.max(...offCenter)).toBeGreaterThan(3100);
  });

  it("lands within 5 % of the jump by 0.3 s after every retarget", () => {
    const LAND_FRAMES = Math.round(300 / FRAME_MS);
    runs.forEach((emissions, i) => {
      const xs = emissions.get(StandardParameter.EyeballX)!;
      const ys = emissions.get(StandardParameter.EyeballY)!;
      const hs = seen[i];
      for (let j = 1; j < hs.length; j++) {
        const h = hs[j];
        const k = h.frame + LAND_FRAMES;
        const jump = Math.hypot(h.x - hs[j - 1].x, h.y - hs[j - 1].y);
        expect(Math.hypot(h.x - xs[k], h.y - ys[k])).toBeLessThanOrEqual(
          0.05 * jump,
        );
      }
    });
  });

  it("leads the head: the turn reaches half its follow later than the eyes reach half their jump", () => {
    // Two runs on the same head-noise seeds whose first retarget (at 0.8 s)
    // differs: eye contact in one, a look to (0.8, 0) in the other. The springs
    // are linear, so the difference between the runs is the response to the
    // gaze alone, the noise cancelled out.
    // Draws: blink at 6 s, first retarget at 0.8 s, three noise seeds, the
    // first breath (4.6 s, past the window), then the retarget's eye-contact
    // coin (under the odds = contact), its x and y, and the next wait (3.3 s,
    // past the window).
    const contact = cyclingRng([1, 0, 0.3, 0.6, 0.9, 1, 0, 1]);
    const look = cyclingRng([1, 0, 0.3, 0.6, 0.9, 1, 0.99, 1, 0.5, 1]);
    const ts = timestamps(0, 3000 / 8 + 1, 8);
    const a = drive(ts, contact);
    const b = drive(ts, look);
    const diff = (id: string) => {
      const sa = a.get(id)!;
      return b.get(id)!.map((v, i) => v - sa[i]);
    };
    const eye = diff(StandardParameter.EyeballX);
    const head = diff(StandardParameter.AngleX);
    // Nothing differs before the retarget; after it the eyes go to 0.8 and the
    // head to 0.8 of its follow, the same way (a look right turns it right).
    const firstMove = eye.findIndex((v) => v !== 0);
    expect(firstMove).toBe(800 / 8);
    expect(head.slice(0, firstMove).every((v) => v === 0)).toBe(true);
    expect(eye.at(-1)!).toBeCloseTo(GAZE_X_MAX, 3);
    expect(head.at(-1)!).toBeCloseTo(HEAD_FOLLOW_X_DEG * GAZE_X_MAX, 1);
    const eyeHalf = eye.findIndex((v) => v >= GAZE_X_MAX / 2);
    const headHalf = head.findIndex(
      (v) => v >= (HEAD_FOLLOW_X_DEG * GAZE_X_MAX) / 2,
    );
    expect(eyeHalf).toBeGreaterThan(firstMove);
    expect(headHalf).toBeGreaterThan(eyeHalf);
  });
});

// ---------------------------------------------------------------------------
// host gaze target
// ---------------------------------------------------------------------------

describe("host gaze target", () => {
  const FRAME_MS = 16;
  const TEN_S = timestamps(0, 10000 / FRAME_MS + 1, FRAME_MS);

  /**
   * Drive like {@link drive}, calling `host(idle, t)` before each update so a
   * test can set or clear the target at chosen times.
   */
  function driveHost(
    ts: number[],
    rng: () => number,
    host: (idle: IdleMotion, t: number) => void,
  ): Map<string, number[]> {
    const { sink, emissions } = makeSink();
    const idle = new IdleMotion(sink, { rng });
    for (const t of ts) {
      host(idle, t);
      idle.update(t);
    }
    return emissions;
  }

  /** The frame index of timestamp `ms` in a run starting at 0. */
  const at = (ms: number) => ms / FRAME_MS;

  it("pulls EyeballX/Y to the target and holds it across scheduled retargets", () => {
    for (const seed of [1, 7, 42]) {
      const held = driveHost(TEN_S, lcg(seed), (idle, t) => {
        if (t === 0) idle.setGazeTarget(0.3, -0.2);
      });
      const free = drive(TEN_S, lcg(seed));
      const xs = held.get(StandardParameter.EyeballX)!.slice(at(1008));
      const ys = held.get(StandardParameter.EyeballY)!.slice(at(1008));
      for (const v of xs) expect(v).toBeCloseTo(0.3, 5);
      for (const v of ys) expect(v).toBeCloseTo(-0.2, 5);
      // Over the same window the same rng retargets the free eyes.
      const freeXs = free.get(StandardParameter.EyeballX)!.slice(at(1008));
      expect(Math.max(...freeXs) - Math.min(...freeXs)).toBeGreaterThan(0.1);
    }
  });

  it("turns and nods the head by the follow gain, up to its full ±1 reach", () => {
    // Two runs on the same rng and opposite targets: the springs are linear,
    // so their difference is the follow alone, the noise cancelled out.
    const a = driveHost(TEN_S, lcg(3), (idle, t) => {
      if (t === 0) idle.setGazeTarget(1, 0.5);
    });
    const b = driveHost(TEN_S, lcg(3), (idle, t) => {
      if (t === 0) idle.setGazeTarget(-1, -0.5);
    });
    const last = (m: Map<string, number[]>, id: string) => m.get(id)!.at(-1)!;
    expect(
      last(a, StandardParameter.AngleX) - last(b, StandardParameter.AngleX),
    ).toBeCloseTo(2 * HEAD_FOLLOW_X_DEG, 3);
    expect(
      last(a, StandardParameter.AngleY) - last(b, StandardParameter.AngleY),
    ).toBeCloseTo(HEAD_FOLLOW_Y_DEG, 3);
    // The roll does not follow the gaze.
    expect(a.get(StandardParameter.AngleZ)).toEqual(
      b.get(StandardParameter.AngleZ),
    );
  });

  it("clamps each value to [-1, 1]", () => {
    const over = driveHost(TEN_S, lcg(5), (idle, t) => {
      if (t === 0) idle.setGazeTarget(3, -2);
    });
    const edge = driveHost(TEN_S, lcg(5), (idle, t) => {
      if (t === 0) idle.setGazeTarget(1, -1);
    });
    expect(over).toEqual(edge);
    expect(over.get(StandardParameter.EyeballX)!.at(-1)).toBeCloseTo(1, 5);
    expect(over.get(StandardParameter.EyeballY)!.at(-1)).toBeCloseTo(-1, 5);
  });

  it("ignores a pair with NaN or Infinity in it", () => {
    const bad: [number, number][] = [
      [NaN, 0.5],
      [0.5, Infinity],
      [-Infinity, NaN],
    ];
    // Over a set target: the target stays.
    const pelted = driveHost(TEN_S, lcg(9), (idle, t) => {
      if (t === 0) idle.setGazeTarget(0.3, 0.2);
      if (t === 2000) for (const [x, y] of bad) idle.setGazeTarget(x, y);
    });
    const kept = driveHost(TEN_S, lcg(9), (idle, t) => {
      if (t === 0) idle.setGazeTarget(0.3, 0.2);
    });
    expect(pelted).toEqual(kept);
    // With no target: none is set, the scheduled gaze runs on.
    const unset = driveHost(TEN_S, lcg(9), (idle, t) => {
      if (t === 0) for (const [x, y] of bad) idle.setGazeTarget(x, y);
    });
    expect(unset).toEqual(drive(TEN_S, lcg(9)));
  });

  it("on clear, the eyes go back to the scheduled pick at once and later picks drive them", () => {
    // Draws: blink at 6 s, first retarget at 3.3 s, three noise seeds, the
    // first breath (4.6 s), then the retarget's eye-contact coin (over the
    // odds = a look), x and y at the box corner (-0.8, -0.5), and the next wait
    // (3.3 s, so the pick holds to 6.6 s).
    const script = [1, 1, 0.3, 0.6, 0.9, 1, 0.99, 0, 0, 1];
    const ts = timestamps(0, 12000 / FRAME_MS + 1, FRAME_MS);
    const hosted = driveHost(ts, cyclingRng(script), (idle, t) => {
      if (t === 0) idle.setGazeTarget(1, 1);
      if (t === 4000) idle.clearGazeTarget();
    });
    const free = drive(ts, cyclingRng(script));
    const xs = hosted.get(StandardParameter.EyeballX)!;
    const ys = hosted.get(StandardParameter.EyeballY)!;
    // Held on the host target past the 3.3 s retarget, up to the clear.
    expect(xs[at(3984)]).toBeCloseTo(1, 5);
    expect(ys[at(3984)]).toBeCloseTo(1, 5);
    // 0.6 s after the clear, long before the next retarget, the eyes are on
    // the pick the schedule made while the host held them.
    expect(xs[at(4592)]).toBeCloseTo(-GAZE_X_MAX, 3);
    expect(ys[at(4592)]).toBeCloseTo(-GAZE_Y_MAX, 3);
    // From there on they track the run that never had a host target, through
    // the later retargets.
    const freeXs = free.get(StandardParameter.EyeballX)!;
    const freeYs = free.get(StandardParameter.EyeballY)!;
    for (let k = at(5008); k < xs.length; k++) {
      expect(xs[k]).toBeCloseTo(freeXs[k], 5);
      expect(ys[k]).toBeCloseTo(freeYs[k], 5);
    }
    expect(
      Math.max(...freeXs.slice(at(5008))) - Math.min(...freeXs.slice(at(5008))),
    ).toBeGreaterThan(0.1);
  });

  it("host calls draw nothing: after set and clear, every pick is drawn on the same frame", () => {
    // The frame being driven, read by the recording rngs.
    let frame = -1;
    /** An lcg that records the frame index of each draw. */
    function recording(seed: number): { rng: () => number; frames: number[] } {
      const next = lcg(seed);
      const frames: number[] = [];
      return {
        rng: () => {
          frames.push(frame);
          return next();
        },
        frames,
      };
    }
    const ts = timestamps(0, 20000 / FRAME_MS + 1, FRAME_MS);
    for (const seed of [1, 7, 42]) {
      const a = recording(seed);
      const b = recording(seed);
      frame = -1;
      const hosted = driveHost(ts, a.rng, (idle, t) => {
        frame = at(t);
        if (t === 1008) idle.setGazeTarget(-0.9, 0.7);
        if (t === 2000) idle.setGazeTarget(0.4, -0.6);
        if (t === 6000) idle.clearGazeTarget();
      });
      frame = -1;
      const free = driveHost(ts, b.rng, (_, t) => {
        frame = at(t);
      });
      expect(a.frames).toEqual(b.frames);
      // The draws ran on through the hold: picks were made inside it.
      const during = a.frames.filter((f) => f > at(1008) && f < at(6000));
      expect(during.length).toBeGreaterThan(0);
      // So, once the springs settle, the two runs write the same gaze.
      const xs = hosted.get(StandardParameter.EyeballX)!;
      const freeXs = free.get(StandardParameter.EyeballX)!;
      for (let k = at(7008); k < xs.length; k++) {
        expect(xs[k]).toBeCloseTo(freeXs[k], 5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// head sway
// ---------------------------------------------------------------------------

describe("head idle", () => {
  const SEEDS = [1, 2, 3, 7, 42, 99, 123, 2024];
  const FRAME_MS = 16;
  // Two minutes of 16 ms frames: dozens of noise lattice cells on every axis.
  const TWO_MIN = timestamps(0, 120000 / FRAME_MS + 1, FRAME_MS);
  const AXES = [
    [StandardParameter.AngleX, HEAD_X_MAX_DEG],
    [StandardParameter.AngleY, HEAD_Y_MAX_DEG],
    [StandardParameter.AngleZ, HEAD_Z_MAX_DEG],
  ] as const;
  const runs = new Map(SEEDS.map((seed) => [seed, drive(TWO_MIN, lcg(seed))]));

  /**
   * An idle on `seed` with its gaze held on the viewer, the head on its noise
   * alone: the seeded draws build it, then every draw while it runs is 0, so
   * each retarget is eye contact again.
   */
  function noiseOnlyMotion(
    seed: number,
    sink: (id: string, value: number) => void,
  ): IdleMotion {
    const seeded = lcg(seed);
    let running = false;
    const motion = new IdleMotion(sink, {
      rng: () => (running ? 0 : seeded()),
    });
    running = true;
    return motion;
  }
  const noiseOnly = SEEDS.map((seed) => {
    const { sink, emissions } = makeSink();
    const motion = noiseOnlyMotion(seed, sink);
    for (const t of TWO_MIN) motion.update(t);
    return emissions;
  });

  it("the noise alone stays within its own amplitude, give or take spring overshoot", () => {
    const NOISE_AXES = [
      [StandardParameter.AngleX, HEAD_NOISE_X_DEG],
      // The nod's breath lift is not gaze, so it stays in.
      [StandardParameter.AngleY, HEAD_NOISE_Y_DEG + BREATH_PITCH_DEG],
      [StandardParameter.AngleZ, HEAD_Z_MAX_DEG],
    ] as const;
    for (const emissions of noiseOnly) {
      for (const id of [
        StandardParameter.EyeballX,
        StandardParameter.EyeballY,
      ]) {
        expect(emissions.get(id)!.every((v) => v === 0)).toBe(true);
      }
      for (const [id, amp] of NOISE_AXES) {
        for (const v of emissions.get(id)!) {
          expect(Math.abs(v)).toBeLessThanOrEqual(amp * SPRING_OVERSHOOT);
        }
      }
    }
  });

  it("each axis stays within its amplitude, give or take spring overshoot", () => {
    for (const emissions of runs.values()) {
      for (const [id, amp] of AXES) {
        for (const v of emissions.get(id)!) {
          expect(Math.abs(v)).toBeLessThanOrEqual(amp * SPRING_OVERSHOOT);
        }
      }
    }
  });

  it("each axis visits both sides of center over two minutes", () => {
    for (const emissions of runs.values()) {
      for (const [id, amp] of AXES) {
        const series = emissions.get(id)!;
        expect(Math.max(...series)).toBeGreaterThan(amp / 4);
        expect(Math.min(...series)).toBeLessThan(-amp / 4);
      }
    }
  });

  it("pauses: every axis holds near-still for stretches, not one constant drift", () => {
    const STILL_DEG_PER_S = 0.1;
    const STILL_FRAMES = Math.ceil(300 / FRAME_MS);
    for (const emissions of runs.values()) {
      for (const [id] of AXES) {
        const series = emissions.get(id)!;
        let run = 0;
        let pauses = 0;
        for (let i = 1; i < series.length; i++) {
          const speed = Math.abs(series[i] - series[i - 1]) / (FRAME_MS / 1000);
          run = speed < STILL_DEG_PER_S ? run + 1 : 0;
          if (run === STILL_FRAMES) pauses++;
        }
        expect(pauses).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("never jumps between frames, even across a huge dt", () => {
    // The gaze follow's widest swing, 16° across the box, peaks near 50°/s:
    // under 1° a 16 ms frame.
    const MAX_JUMP_DEG = 1;
    for (const emissions of runs.values()) {
      for (const [id] of AXES) {
        const series = emissions.get(id)!;
        for (let i = 1; i < series.length; i++) {
          expect(Math.abs(series[i] - series[i - 1])).toBeLessThan(
            MAX_JUMP_DEG,
          );
        }
      }
    }
    // 60-second freeze mid-run: dt clamps to 100 ms, one spring step at most.
    // On the noise alone: mid gaze-follow swing, a 100 ms step may rightly
    // move the head several degrees, so this would pass by seed luck.
    const FREEZE_JUMP_DEG = 0.5;
    const { sink, emissions } = makeSink();
    const motion = noiseOnlyMotion(5, sink);
    for (let t = 0; t <= 5000; t += FRAME_MS) motion.update(t);
    const before = AXES.map(([id]) => emissions.get(id)!.at(-1)!);
    motion.update(65000);
    AXES.forEach(([id], i) => {
      const after = emissions.get(id)!.at(-1)!;
      expect(Math.abs(after - before[i])).toBeLessThan(FREEZE_JUMP_DEG);
    });
  });

  it("roll is the gentlest axis: it stays at or under the turn's envelope", () => {
    // A tilt of n degrees reads far larger than a turn of n degrees, so the
    // idle must never roll further than it may yaw.
    // The turn's own noise, that is: its gaze follow is a look, not a drift.
    expect(HEAD_Z_MAX_DEG).toBeLessThanOrEqual(HEAD_NOISE_X_DEG);
    for (const emissions of runs.values()) {
      for (const v of emissions.get(StandardParameter.AngleZ)!) {
        expect(Math.abs(v)).toBeLessThanOrEqual(HEAD_NOISE_X_DEG);
      }
    }
  });

  it("does not lurch on start: the first 2 s move no faster than the steady idle", () => {
    // The springs start at 0 and the noise rarely does; a head that snapped
    // to its first noise value would outrun everything after it. The gaze
    // follow's swings would hide that on the turn and nod, so the gaze is held
    // on the viewer.
    const START_FRAMES = 2000 / FRAME_MS;
    for (const emissions of noiseOnly) {
      for (const [id] of AXES) {
        const series = emissions.get(id)!;
        const speeds = series
          .slice(1)
          .map((v, i) => Math.abs(v - series[i]) / (FRAME_MS / 1000));
        const startPeak = Math.max(...speeds.slice(0, START_FRAMES));
        const steadyPeak = Math.max(...speeds.slice(START_FRAMES));
        expect(startPeak).toBeLessThanOrEqual(steadyPeak);
      }
    }
  });

  it("lifts the nod with each breath, up to its 1° pitch, behind the breath", () => {
    // Two runs on the same noise seeds with the gaze held on the viewer,
    // differing only in the first breath's length (3.2 s vs 4.6 s): the
    // springs are linear, so the AngleY difference is the response to the
    // breath difference alone, the noise cancelled out.
    function run(firstBreath: number): Map<string, number[]> {
      const seeded = lcg(11);
      let draws = 0;
      const { sink, emissions } = makeSink();
      // Draws: blink, gaze, three noise seeds, then the first breath; every
      // draw after that is 0 (eye contact, 3.2 s breaths) in both runs.
      const motion = new IdleMotion(sink, {
        rng: () => {
          draws++;
          if (draws <= 5) return seeded();
          return draws === 6 ? firstBreath : 0;
        },
      });
      for (const t of timestamps(0, 20000 / FRAME_MS + 1, FRAME_MS)) {
        motion.update(t);
      }
      return emissions;
    }
    const a = run(1);
    const b = run(0);
    const diff = (id: string) => {
      const sb = b.get(id)!;
      return a.get(id)!.map((v, i) => v - sb[i]);
    };
    const breath = diff(StandardParameter.Breath);
    const nod = diff(StandardParameter.AngleY);
    expect(Math.max(...breath.map(Math.abs))).toBeGreaterThan(0.9);
    // Full breath lifts the nod by about its pitch, give or take the spring.
    const peak = Math.max(...nod.map(Math.abs));
    expect(peak).toBeGreaterThan(0.8 * BREATH_PITCH_DEG);
    expect(peak).toBeLessThanOrEqual(BREATH_PITCH_DEG * SPRING_OVERSHOOT);
    // The nod rises and falls with the breath: same sign, a strong positive
    // correlation once the spring's lag (a few frames) is allowed for.
    const LAG = 8;
    const x = breath.slice(0, -LAG);
    const y = nod.slice(LAG);
    const mean = (v: number[]) => v.reduce((s, e) => s + e, 0) / v.length;
    const mx = mean(x);
    const my = mean(y);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// ambient sway
// ---------------------------------------------------------------------------

describe("ambient sway", () => {
  // 60 s at 50 ms: long enough for both sines to line up near a peak.
  const SIXTY_S = timestamps(0, 1201, 50);

  it("stays within -1..1 and reaches near both ends", () => {
    const series = drive(SIXTY_S, cyclingRng([0.5])).get(
      StandardParameter.AmbientSway,
    )!;
    for (const v of series) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    expect(Math.max(...series)).toBeGreaterThan(0.9);
    expect(Math.min(...series)).toBeLessThan(-0.9);
  });

  it("is a function of the clock alone: two different rngs write the same series", () => {
    // It takes no rng draw, which would shift the blink and gaze schedules.
    const a = drive(SIXTY_S, cyclingRng([0])).get(
      StandardParameter.AmbientSway,
    );
    const b = drive(SIXTY_S, cyclingRng([0.9, 0.3, 0.6])).get(
      StandardParameter.AmbientSway,
    );
    expect(a).toHaveLength(SIXTY_S.length);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// clamped pause / time base
// ---------------------------------------------------------------------------

describe("clamped pause / time base", () => {
  it("a huge dt pause does not produce out-of-range values", () => {
    const { sink, emissions } = makeSink();
    const motion = new IdleMotion(sink, { rng: cyclingRng([0.5]) });

    motion.update(0); // anchor
    motion.update(10); // normal step: capture pre-pause values
    const prePauseLeft = emissions.get(StandardParameter.EyeOpenLeft)!.at(-1)!;
    const prePauseBreath = emissions.get(StandardParameter.Breath)!.at(-1)!;

    // Simulate 60-second freeze (60000ms jump)
    motion.update(60010);

    const postPauseLeft = emissions.get(StandardParameter.EyeOpenLeft)!.at(-1)!;
    const postPauseBreath = emissions.get(StandardParameter.Breath)!.at(-1)!;

    // Values must remain in their valid ranges
    expect(postPauseLeft).toBeGreaterThanOrEqual(0);
    expect(postPauseLeft).toBeLessThanOrEqual(1);
    expect(postPauseBreath).toBeGreaterThanOrEqual(0);
    expect(postPauseBreath).toBeLessThanOrEqual(1);

    // Values must NOT teleport — should be close to pre-pause values because
    // dt was clamped to 100ms (only one normal step advanced the clock)
    expect(Math.abs(postPauseLeft - prePauseLeft)).toBeLessThan(0.3);
    expect(Math.abs(postPauseBreath - prePauseBreath)).toBeLessThan(0.2);
  });

  it("a backward time jump (non-monotonic) produces no out-of-range values", () => {
    const { sink, emissions } = makeSink();
    const motion = new IdleMotion(sink, { rng: cyclingRng([0.5]) });

    motion.update(1000);
    motion.update(1100);
    // Backward jump: raw dt is negative, clamped to 0 → no clock advance
    motion.update(500);

    const left = emissions.get(StandardParameter.EyeOpenLeft)!;
    const breath = emissions.get(StandardParameter.Breath)!;

    for (const v of left) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    for (const v of breath) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("two instances with identical rng + timestamps emit the same series", () => {
    const rngValues = [0, 0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.6, 0.4, 0.8];
    const ts = timestamps(0, 60, 33);

    const emissionsA = drive(ts, cyclingRng(rngValues), BROWS);
    const emissionsB = drive(ts, cyclingRng(rngValues), BROWS);

    for (const id of EMITTED_IDS_WITH_BROWS) {
      expect(emissionsA.get(id)).toEqual(emissionsB.get(id));
    }
  });
});
