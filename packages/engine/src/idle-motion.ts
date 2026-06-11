import { StandardParameter } from "@iki/format";

// --- Module-internal timing/easing constants -----------------------------------
// These are intentionally private; tests assert observable behavior, not config.

const MAX_DT_MS = 100; // clamp per-frame dt so a backgrounded tab can't snap state

const BLINK_INTERVAL_MIN_MS = 1500;
const BLINK_INTERVAL_MAX_MS = 6000;
const BLINK_DURATION_MS = 120; // full close+open cycle

const BREATH_PERIOD_MS = 3500;

const GAZE_RADIUS = 0.3;
const GAZE_RETARGET_MIN_MS = 1200;
const GAZE_RETARGET_MAX_MS = 3000;
// Fraction of the gap to close each millisecond of clamped dt.
// Chosen so a typical 16ms frame moves ~1.5 % of remaining distance.
const GAZE_EASE_RATE = 0.001;

// --- Small pure helpers -------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blink envelope: 1 at phase 0 and 1, 0 at the midpoint (triangle dip). */
function blinkEnvelope(phase: number): number {
  // phase in [0,1]; map to a symmetric triangle: 0→1, 0.5→0, 1→1
  return 2 * Math.abs(phase - 0.5);
}

/** Pick a random point within a disk of `radius` using the injected rng. */
function randomInDisk(rng: () => number, radius: number): [number, number] {
  // Rejection sample: try until inside the disk (≥ 78 % acceptance, fast).
  for (;;) {
    const x = (rng() * 2 - 1) * radius;
    const y = (rng() * 2 - 1) * radius;
    if (x * x + y * y <= radius * radius) return [x, y];
  }
}

// --- Public API ---------------------------------------------------------------

export interface IdleMotionOptions {
  /** Inject a deterministic rng for testing. Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Pure-logic idle-animation driver. Animates the five "life" parameters
 * (eyes, breath, gaze) on an internal clock so tab-backgrounding or
 * irregular frame delivery can't produce teleports or snap-close blinks.
 *
 * Usage:
 *   const idle = new IdleMotion(player.setParameter.bind(player));
 *   // inside your rAF loop:
 *   idle.update(performance.now());
 *
 * The host is responsible for scheduling; this class has no timers or rAF.
 */
export class IdleMotion {
  private readonly sink: (id: string, value: number) => void;
  private readonly rng: () => number;

  // Internal clock: advances by clamped dt, NOT by raw wall-clock jumps.
  // This is the only clock blink/breath/gaze scheduling reads.
  private clockMs = 0;
  private prevNowMs: number | undefined = undefined;

  // Blink state
  private nextBlinkAtMs: number;
  private blinkStartMs = -1; // -1 means not currently blinking

  // Gaze state
  private gazeCurrentX = 0;
  private gazeCurrentY = 0;
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private nextGazeRetargetMs: number;

  constructor(
    sink: (id: string, value: number) => void,
    options?: IdleMotionOptions,
  ) {
    this.sink = sink;
    // Math.random is the single allowed default reference; all other uses go
    // through this.rng so tests can inject a deterministic substitute.
    this.rng = options?.rng ?? Math.random;

    // Schedule the first blink and gaze retarget relative to clock zero.
    this.nextBlinkAtMs = lerp(
      BLINK_INTERVAL_MIN_MS,
      BLINK_INTERVAL_MAX_MS,
      this.rng(),
    );
    this.nextGazeRetargetMs = lerp(
      GAZE_RETARGET_MIN_MS,
      GAZE_RETARGET_MAX_MS,
      this.rng(),
    );
  }

  /**
   * Advance the idle animation to the given wall-clock timestamp (milliseconds).
   *
   * On the first call: record prevNowMs, emit the resting pose, and return —
   * no animation advance happens so there is no jump from time 0.
   *
   * On subsequent calls: compute dt = clamp(nowMs - prevNowMs, 0, MAX_DT_MS)
   * and advance the internal clock by dt. A non-monotonic nowMs produces a
   * negative raw delta that the clamp floors to 0 — no rewind.
   */
  update(nowMs: number): void {
    if (this.prevNowMs === undefined) {
      this.prevNowMs = nowMs;
      // Emit resting pose so the host mirror stays in sync from frame 1.
      this.emitRestingPose();
      return;
    }

    // Clamp dt so a backgrounded tab or long GC pause advances the internal
    // clock by at most MAX_DT_MS — blink can't snap shut, gaze can't teleport.
    const rawDt = nowMs - this.prevNowMs;
    const dt = clamp(rawDt, 0, MAX_DT_MS);
    this.prevNowMs = nowMs;
    this.clockMs += dt;

    // Both eyes always carry the identical value (unified blink).
    const eyeVal = this.advanceBlink();
    this.sink(StandardParameter.EyeOpenLeft, eyeVal);
    this.sink(StandardParameter.EyeOpenRight, eyeVal);

    const breath = this.advanceBreath();
    this.advanceGaze(dt);

    this.sink(StandardParameter.Breath, breath);
    this.sink(StandardParameter.EyeballX, this.gazeCurrentX);
    this.sink(StandardParameter.EyeballY, this.gazeCurrentY);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitRestingPose(): void {
    this.sink(StandardParameter.EyeOpenLeft, 1);
    this.sink(StandardParameter.EyeOpenRight, 1);
    // Breath at phase 0: sin(0) = 0 → 0.5 + 0.5*0 = 0.5
    this.sink(StandardParameter.Breath, 0.5);
    this.sink(StandardParameter.EyeballX, 0);
    this.sink(StandardParameter.EyeballY, 0);
  }

  /** Returns the current eye-open value (0..1) and advances blink state. */
  private advanceBlink(): number {
    const { clockMs } = this;

    // If a blink is in progress, evaluate the envelope.
    if (this.blinkStartMs >= 0) {
      const phase = (clockMs - this.blinkStartMs) / BLINK_DURATION_MS;
      if (phase >= 1) {
        // Blink finished — schedule the next one on the internal clock.
        this.blinkStartMs = -1;
        this.nextBlinkAtMs =
          clockMs +
          lerp(BLINK_INTERVAL_MIN_MS, BLINK_INTERVAL_MAX_MS, this.rng());
        return 1;
      }
      return blinkEnvelope(phase);
    }

    // Check if it is time to start a new blink.
    if (clockMs >= this.nextBlinkAtMs) {
      this.blinkStartMs = clockMs;
      // Return the first envelope sample (exactly 1 at phase 0).
      return blinkEnvelope(0);
    }

    // Between blinks: eyes fully open.
    return 1;
  }

  private advanceBreath(): number {
    return (
      0.5 + 0.5 * Math.sin((2 * Math.PI * this.clockMs) / BREATH_PERIOD_MS)
    );
  }

  /** Ease gaze current toward target; pick a new target on the internal clock. */
  private advanceGaze(dt: number): void {
    // Retarget check reads clockMs so a clamped pause can't skip retargets.
    if (this.clockMs >= this.nextGazeRetargetMs) {
      const [tx, ty] = randomInDisk(this.rng, GAZE_RADIUS);
      this.gazeTargetX = tx;
      this.gazeTargetY = ty;
      this.nextGazeRetargetMs =
        this.clockMs +
        lerp(GAZE_RETARGET_MIN_MS, GAZE_RETARGET_MAX_MS, this.rng());
    }

    // Exponential ease toward target. The ease factor is derived from the
    // CLAMPED dt so a paused tab moves at most one normal step, never a teleport.
    const factor = 1 - Math.pow(1 - GAZE_EASE_RATE, dt);
    this.gazeCurrentX = lerp(this.gazeCurrentX, this.gazeTargetX, factor);
    this.gazeCurrentY = lerp(this.gazeCurrentY, this.gazeTargetY, factor);
  }
}
