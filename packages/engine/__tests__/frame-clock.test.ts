import { describe, expect, it } from "vitest";

import { FixedStepClock } from "../src/frame-clock";

// One fixed sub-step is 1/60 s; 20ms clears exactly one without tripping the
// float round-trip that `(1/60*1000)/1000 >= 1/60` fails on.
const OVER_ONE_STEP_MS = 20;

describe("FixedStepClock", () => {
  it("runs no steps on the seed frame, then one per elapsed step", () => {
    const clock = new FixedStepClock();
    expect(clock.isSeedFrame).toBe(true);
    expect(clock.advance(1000)).toBe(0);
    expect(clock.isSeedFrame).toBe(false);
    expect(clock.advance(1000 + OVER_ONE_STEP_MS)).toBe(1);
  });

  it("carries leftover time across frames instead of dropping it", () => {
    const clock = new FixedStepClock();
    clock.advance(0);
    // Two half-steps must add up to one whole step, not zero.
    expect(clock.advance(OVER_ONE_STEP_MS / 2)).toBe(0);
    expect(clock.advance(OVER_ONE_STEP_MS)).toBe(1);
  });

  it("caps catch-up so a long stall cannot spiral", () => {
    const clock = new FixedStepClock();
    clock.advance(0);
    expect(clock.advance(10_000)).toBe(6);
  });

  it("floors a non-monotonic timestamp rather than rewinding", () => {
    const clock = new FixedStepClock();
    clock.advance(1000);
    expect(clock.advance(500)).toBe(0);
  });

  // A NaN accumulator would make every `NaN >= FIXED_DT_S` false forever, so one
  // bad frame would freeze the rig with no way back.
  it("drops a non-finite frame and keeps integrating afterwards", () => {
    const clock = new FixedStepClock();
    clock.advance(1000);
    expect(clock.advance(NaN)).toBe(0);
    expect(clock.advance(1000 + OVER_ONE_STEP_MS)).toBe(1);
  });

  it("stays on the seed frame when the very first timestamp is non-finite", () => {
    const clock = new FixedStepClock();
    expect(clock.advance(NaN)).toBe(0);
    // Nothing was recorded, so the next good call is still the seed.
    expect(clock.isSeedFrame).toBe(true);
    expect(clock.advance(1000)).toBe(0);
    expect(clock.advance(1000 + OVER_ONE_STEP_MS)).toBe(1);
  });
});
