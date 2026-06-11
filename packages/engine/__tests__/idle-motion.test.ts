import { describe, expect, it } from "vitest";
import { StandardParameter } from "@iki/format";
import { IdleMotion } from "@iki/engine";

// Local timing literals matching the impl's intent — NOT imported from impl.
const BLINK_DURATION_MS = 120;
const BREATH_PERIOD_MS = 3500;
const GAZE_RADIUS = 0.3;

const FIVE_IDS = new Set([
  StandardParameter.EyeOpenLeft,
  StandardParameter.EyeOpenRight,
  StandardParameter.Breath,
  StandardParameter.EyeballX,
  StandardParameter.EyeballY,
]);

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
function drive(timestamps: number[], rng: () => number): Map<string, number[]> {
  const { sink, emissions } = makeSink();
  const motion = new IdleMotion(sink, { rng });
  for (const t of timestamps) {
    motion.update(t);
  }
  return emissions;
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

describe("sink-only contract", () => {
  it("emits exactly the 5 standard parameter ids", () => {
    const emissions = drive(timestamps(0, 10, 100), cyclingRng([0.5]));
    expect(new Set(emissions.keys())).toEqual(FIVE_IDS);
  });

  it("first update emits resting pose: eyes=1, breath=0.5, gaze=0,0", () => {
    const { sink, emissions } = makeSink();
    const motion = new IdleMotion(sink, { rng: cyclingRng([0.5]) });
    motion.update(1000);
    expect(emissions.get(StandardParameter.EyeOpenLeft)![0]).toBe(1);
    expect(emissions.get(StandardParameter.EyeOpenRight)![0]).toBe(1);
    expect(emissions.get(StandardParameter.Breath)![0]).toBe(0.5);
    expect(emissions.get(StandardParameter.EyeballX)![0]).toBe(0);
    expect(emissions.get(StandardParameter.EyeballY)![0]).toBe(0);
  });

  it("every update (including first) emits exactly all 5 ids", () => {
    // Verify counts are equal across all 5 params after N updates.
    const N = 20;
    const emissions = drive(timestamps(0, N, 100), cyclingRng([0.5]));
    const counts = [...emissions.values()].map((v) => v.length);
    expect(counts.every((c) => c === N)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// blink
// ---------------------------------------------------------------------------

describe("blink", () => {
  /**
   * With rng()[0]=0: nextBlinkAtMs = lerp(1500, 6000, 0) = 1500.
   * With rng()[1]=1: nextGazeRetargetMs = lerp(1200, 3000, 1) = 3000 (safely after blink).
   * dt is clamped to 100ms, so advancing clock by 1500ms needs 15 steps.
   * After the first (anchor) update: prevNowMs = 0, clockMs stays 0.
   * Then 15 updates of 100ms → clockMs = 1500 → blink triggers.
   *
   * During blink: clockMs ∈ [1500, 1620]. Fine-step through it.
   */
  it("eye values dip near 0 at mid-blink and return to 1 after", () => {
    const { sink, emissions } = makeSink();
    // rng call order: [0]=blinkAt (0→1500ms), [1]=gazeAt (1→3000ms, past our test window)
    // [2]=next blinkAt after blink ends (0.5→safe interval)
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

    // Fine-step through the 120ms blink window at ~20ms each
    for (let ms = 1520; ms <= 1620; ms += 20) {
      motion.update(ms);
    }

    const leftSeries = emissions.get(StandardParameter.EyeOpenLeft)!;
    const rightSeries = emissions.get(StandardParameter.EyeOpenRight)!;

    // Both eye series must be identical at every step
    expect(leftSeries).toEqual(rightSeries);

    // Updates during blink are indices 15 (clockMs=1500) through 21 (clockMs=1620)
    const blinkSlice = leftSeries.slice(15); // from clock=1500 onward
    // The dip must sit at the MIDDLE of the envelope, not the edges: at
    // blink start (phase 0) the eye is still open, at phase 0.5 it is shut.
    // An inverted envelope (closed at the edges) fails both assertions.
    expect(blinkSlice[0]).toBeCloseTo(1, 5); // clockMs=1500, phase=0 → open
    expect(blinkSlice[3]).toBeLessThan(0.1); // clockMs=1560, phase=0.5 → shut

    // After blink completes (last sample in blinkSlice), eyes return to 1
    const lastInSlice = blinkSlice[blinkSlice.length - 1];
    expect(lastInSlice).toBe(1);
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

// ---------------------------------------------------------------------------
// breath
// ---------------------------------------------------------------------------

describe("breath", () => {
  it("all emitted values are in [0, 1]", () => {
    // Step 50ms to get dense coverage over 3500ms (70+ updates)
    const emissions = drive(timestamps(0, 80, 50), cyclingRng([0.5]));
    const breathSeries = emissions.get(StandardParameter.Breath)!;
    for (const v of breathSeries) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("breath spans a full cycle within one period (min ≈ 0, max ≈ 1)", () => {
    // Drive for 2 full breath periods + some extra, 50ms steps
    const steps = Math.ceil((2 * BREATH_PERIOD_MS) / 50) + 10;
    const emissions = drive(timestamps(0, steps, 50), cyclingRng([0.5]));
    const breathSeries = emissions.get(StandardParameter.Breath)!;

    const min = Math.min(...breathSeries);
    const max = Math.max(...breathSeries);

    // With 50ms resolution the extremes land within ~1% of theoretical 0 and 1
    expect(min).toBeLessThan(0.05);
    expect(max).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
// gaze
// ---------------------------------------------------------------------------

describe("gaze", () => {
  it("every (x, y) gaze emission stays within radius 0.3 + small tolerance", () => {
    const eps = 0.01;
    const emissions = drive(
      timestamps(0, 200, 16), // ~200 frames at ~60fps equivalent
      cyclingRng([0, 0.5]), // triggers retargets
    );
    const xs = emissions.get(StandardParameter.EyeballX)!;
    const ys = emissions.get(StandardParameter.EyeballY)!;

    for (let i = 0; i < xs.length; i++) {
      const r = Math.hypot(xs[i], ys[i]);
      expect(r).toBeLessThanOrEqual(GAZE_RADIUS + eps);
    }
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

    const emissionsA = drive(ts, cyclingRng(rngValues));
    const emissionsB = drive(ts, cyclingRng(rngValues));

    for (const id of FIVE_IDS) {
      expect(emissionsA.get(id)).toEqual(emissionsB.get(id));
    }
  });
});
