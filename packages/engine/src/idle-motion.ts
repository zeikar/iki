import { type IkiParameter, StandardParameter } from "@ikijs/format";
import { MAX_DT_MS } from "./frame-clock";
import { clamp, lerp, smoothstep } from "./math";

// --- Module-internal timing/easing constants -----------------------------------
// These are intentionally private; tests assert observable behavior, not config.

const BLINK_INTERVAL_MIN_MS = 1500;
const BLINK_INTERVAL_MAX_MS = 6000;
// A blink closes fast and opens slower, with a moment shut in between. The
// human blink-kinematics literature has the down-phase at roughly a third of
// the whole and the up-phase decelerating into the open pose. These three are
// a judgement inside the 150–180 ms range.
const BLINK_CLOSE_MS = 60;
const BLINK_HOLD_MS = 20;
const BLINK_OPEN_MS = 100;
const BLINK_DURATION_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS; // 180
// Share of blinks followed by a second one, a short beat after the first
// reopens. The second never draws the coin, so a pair never runs to three.
const DOUBLE_BLINK_P = 0.18;
const DOUBLE_BLINK_GAP_MS = 70;
// How far the brows drop below their resting value (BrowLY/RY units) with the
// lids fully shut; the dip scales with how closed each eye is.
const BROW_BLINK_DIP = 0.06;

// A breath rises over the first 40 % of its cycle, falls by 88 %, and rests
// at empty for the rest: inhaling is quicker than exhaling, with a pause
// before the next. Each cycle draws its own length, so the rhythm never ticks.
const BREATH_IN_END = 0.4;
const BREATH_OUT_END = 0.88;
const BREATH_PERIOD_MIN_MS = 3200;
const BREATH_PERIOD_MAX_MS = 4600;
// Degrees the head lifts (AngleY) at full breath.
const BREATH_PITCH_DEG = 1;

// --- Tuning: gaze ----------------------------------------------------------------
// The eyes hold a point, then jump: each retarget comes after a uniform wait.
const GAZE_RETARGET_MIN_MS = 800;
const GAZE_RETARGET_MAX_MS = 3300;
// Share of retargets that come back to the viewer, (0, 0) exactly.
const GAZE_EYE_CONTACT_P = 0.4;
// Half-widths of the uniform box the other retargets land in, gaze units.
const GAZE_X_MAX = 0.8;
const GAZE_Y_MAX = 0.5;
// The eye springs: stiff, so a jump lands within ~0.3 s, and damped close to
// critical so it barely overshoots.
const EYE_SPRING_OMEGA = 16;
const EYE_SPRING_ZETA = 0.9;
// Degrees the head turns (X) and nods (Y) per unit of gaze target. The soft
// head spring chases the same target as the stiff eye one, so the eyes lead
// and the head follows. Same signs: + is the viewer's right and up for both.
const HEAD_FOLLOW_X_DEG = 10;
const HEAD_FOLLOW_Y_DEG = 10;

// --- Tuning: the head idle -----------------------------------------------------
// Retune these by eye. Each head axis is a soft spring chasing its own seeded
// noise, so the head drifts, settles and pauses instead of tracing a sine.
//
// Peak noise in degrees per axis — small against the ±30° standard AngleX/Y/Z
// range. Roll stays under the turn: a tilt reads much larger than a turn of
// the same degrees. The spring can overshoot these by a few percent.
const HEAD_NOISE_AMP_X_DEG = 6;
const HEAD_NOISE_AMP_Y_DEG = 4;
const HEAD_NOISE_AMP_Z_DEG = 4;
// Noise lattice points per second. Distinct rates so the axes never move in step.
const HEAD_NOISE_RATE_X_HZ = 0.18;
const HEAD_NOISE_RATE_Y_HZ = 0.15;
const HEAD_NOISE_RATE_Z_HZ = 0.12;
// Angular frequency (rad/s) and damping ratio of the head springs: soft enough
// to round off the noise, damped enough that a stop barely overshoots.
const HEAD_SPRING_OMEGA = 7.4;
const HEAD_SPRING_ZETA = 0.72;
// The springs start at 0 but the noise rarely does; fading the targets in over
// this long keeps the head from lurching to its first noise value on load.
// Under ~4 s the fade outruns the noise's own steady speed on some seeds.
const HEAD_NOISE_EASE_IN_MS = 4000;
// Longest spring integration slice. Semi-implicit Euler holds while ω·h stays
// well under 2, so 8 ms keeps even a stiff ω = 16 stable at the 100 ms dt cap.
const SPRING_SUBSTEP_MS = 8;

// Ambient sway: the drift hair physics follows in idle, where the head idle
// alone barely moves it. Two near-coprime periods (29:43) inside 2.5–5 s; the
// breath draws a new length each cycle, so the two never stay in step. The
// amplitudes sum to exactly ±1, the parameter's range. Zero phase, so the resting pose writes 0
// and it takes no rng draw (the blink and gaze schedules keep their sequence).
const AMBIENT_AMP_A = 0.6;
const AMBIENT_PERIOD_A_MS = 2900;
const AMBIENT_AMP_B = 0.4;
const AMBIENT_PERIOD_B_MS = 4300;

// --- Small pure helpers -------------------------------------------------------

/**
 * Eye-open value over one blink, `phase` ∈ [0, 1]: 1 at both ends, 0 across the
 * hold. Close is a smoothstep (soft start, soft landing on the lid); open is a
 * quadratic ease-out (the lid leaves the hold at speed and settles). Exported
 * for the shape tests; not part of the package entry.
 */
export function blinkEnvelope(phase: number): number {
  const ms = phase * BLINK_DURATION_MS;
  if (ms <= 0) return 1;
  if (ms < BLINK_CLOSE_MS) return 1 - smoothstep(ms / BLINK_CLOSE_MS);
  if (ms <= BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0; // inclusive: the close point is exactly 0 for any retune
  if (ms < BLINK_DURATION_MS) {
    const t = (ms - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
    return 1 - (1 - t) * (1 - t);
  }
  return 1;
}

/**
 * Breath value over one cycle, `phase` ∈ [0, 1]: a smoothstep rise from 0 to 1
 * by BREATH_IN_END, a smoothstep fall back to 0 by BREATH_OUT_END, then 0.
 * Exported for the shape tests; not part of the package entry.
 */
export function breathEnvelope(phase: number): number {
  if (phase < BREATH_IN_END) return smoothstep(phase / BREATH_IN_END);
  return (
    1 - smoothstep((phase - BREATH_IN_END) / (BREATH_OUT_END - BREATH_IN_END))
  );
}

/** Draw a 32-bit integer seed from a [0, 1) rng. */
function drawSeed(rng: () => number): number {
  return Math.floor(rng() * 0x100000000) | 0;
}

/** Lattice value in [-1, 1) for integer `i`, a fixed integer mix of seed and index. */
function latticeValue(seed: number, i: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0x80000000 - 1;
}

/**
 * 1D value noise in [-1, 1): lattice values eased with smoothstep, so the
 * slope is zero at every lattice point — the head eases into each one.
 */
function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  return lerp(
    latticeValue(seed, i),
    latticeValue(seed, i + 1),
    smoothstep(x - i),
  );
}

/**
 * Two octaves of value noise, the second at double rate and half amplitude,
 * divided by the summed amplitudes so the result stays within ±1. Every
 * first-octave lattice point is also a second-octave one, so both slopes
 * vanish together there and the head comes to a real pause.
 */
function fbm(seed: number, x: number): number {
  return (
    (valueNoise(seed, x) + 0.5 * valueNoise(seed ^ 0x5bd1e995, 2 * x)) / 1.5
  );
}

/** A damped spring chasing a moving target. */
class Spring {
  value = 0;
  velocity = 0;

  constructor(
    private readonly omega: number,
    private readonly zeta: number,
  ) {}

  /** Advance `dtMs` toward `target` by semi-implicit Euler in short slices. */
  step(target: number, dtMs: number): void {
    const slices = Math.ceil(dtMs / SPRING_SUBSTEP_MS);
    const h = dtMs / slices / 1000;
    for (let s = 0; s < slices; s++) {
      const accel =
        this.omega * this.omega * (target - this.value) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
  }
}

// --- Public API ---------------------------------------------------------------

export interface IdleMotionOptions {
  /** Inject a deterministic rng for testing. Defaults to Math.random. */
  rng?: () => number;
  /**
   * The model's declared parameters. When they include BrowLeftY or
   * BrowRightY, that brow dips a little below its resting value (the default,
   * clamped into range) with each blink; otherwise idle writes no brow.
   */
  parameters?: readonly IkiParameter[];
}

/**
 * Pure-logic idle-animation driver. Animates the nine "life" parameters
 * (eyes, breath, gaze, head, ambient sway), plus the brows' blink dip when
 * the model declares them, on an internal clock so tab-backgrounding or
 * irregular frame delivery can't produce teleports or snap-close blinks.
 * Some blinks come in quick pairs. The brow dip follows idle's blink, not
 * the eye shown: under an expression that holds the eyes shut, the brows
 * still dip a little on each idle blink. The
 * eyes hold a point, then jump to the next, or back to the viewer, on stiff
 * springs. The head is one soft spring per axis chasing a seeded two-octave
 * noise, so it drifts, settles and pauses; on the turn and nod it also follows the gaze, behind the eyes.
 * The nod also lifts a little with each breath; that lift is part of the
 * head channel, so a declared `Idle` motion group drops it with the rest of
 * the head (see IkiMotion), while Breath itself stays. Each breath rises
 * faster than it falls, then rests, and draws its own cycle length. The noise
 * seeds are drawn from the rng once, in the constructor; the gaze targets as
 * it jumps; each breath's length as the one before it ends.
 * A host can hold the gaze on a point of its own (a pointer, a face tracker)
 * with {@link setGazeTarget}; the scheduled jumps resume on
 * {@link clearGazeTarget}.
 *
 * Usage:
 *   const idle = new IdleMotion(player.setParameter.bind(player), {
 *     parameters: model.parameters, // for the brows' blink dip
 *   });
 *   // inside your rAF loop:
 *   idle.update(performance.now());
 *
 * The host is responsible for scheduling; this class has no timers or rAF.
 */
export class IdleMotion {
  /**
   * Every parameter id {@link update} and `emitRestingPose` write, in write
   * order. Published so a host (or IkiMotion) can restore them after it
   * stops driving — keep in step with those two methods; the test suite
   * pins this list to the actual emissions.
   */
  readonly drivenParameterIds: readonly string[];
  private readonly sink: (id: string, value: number) => void;
  private readonly rng: () => number;
  /** The declared brow Y ids the blink dip writes, with their resting values. */
  private readonly brows: readonly { id: string; rest: number }[];

  // Internal clock: advances by clamped dt, NOT by raw wall-clock jumps.
  // This is the only clock blink/breath/gaze scheduling reads.
  private clockMs = 0;
  private prevNowMs: number | undefined = undefined;

  // Blink state
  private nextBlinkAtMs: number;
  private blinkStartMs = -1; // -1 means not currently blinking
  // Whether the blink scheduled (or running) is the second of a pair.
  private blinkIsSecond = false;

  // Gaze state: the scheduled pick starts at eye contact, (0, 0), until the
  // first retarget. A host target, while set, replaces the pick as what the
  // eyes and head chase; the schedule keeps picking underneath it.
  private readonly eyeX = new Spring(EYE_SPRING_OMEGA, EYE_SPRING_ZETA);
  private readonly eyeY = new Spring(EYE_SPRING_OMEGA, EYE_SPRING_ZETA);
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private nextGazeRetargetMs: number;
  private hostGaze: { x: number; y: number } | undefined = undefined;

  // Breath state: the current cycle's start and length on the internal clock.
  private breathStartMs = 0;
  private breathPeriodMs: number;

  // Head state: one noise seed and one spring per axis (X turn, Y nod, Z roll).
  private readonly headSeedX: number;
  private readonly headSeedY: number;
  private readonly headSeedZ: number;
  private readonly headX = new Spring(HEAD_SPRING_OMEGA, HEAD_SPRING_ZETA);
  private readonly headY = new Spring(HEAD_SPRING_OMEGA, HEAD_SPRING_ZETA);
  private readonly headZ = new Spring(HEAD_SPRING_OMEGA, HEAD_SPRING_ZETA);

  constructor(
    sink: (id: string, value: number) => void,
    options?: IdleMotionOptions,
  ) {
    this.sink = sink;
    // Math.random is the single allowed default reference; all other uses go
    // through this.rng so tests can inject a deterministic substitute.
    this.rng = options?.rng ?? Math.random;
    this.brows = [StandardParameter.BrowLeftY, StandardParameter.BrowRightY]
      .map((id) => options?.parameters?.find((p) => p.id === id))
      .filter((p) => p !== undefined)
      .map((p) => ({ id: p.id, rest: clamp(p.default, p.min, p.max) }));
    this.drivenParameterIds = [
      StandardParameter.EyeOpenLeft,
      StandardParameter.EyeOpenRight,
      ...this.brows.map((b) => b.id),
      StandardParameter.Breath,
      StandardParameter.EyeballX,
      StandardParameter.EyeballY,
      StandardParameter.AngleX,
      StandardParameter.AngleY,
      StandardParameter.AngleZ,
      StandardParameter.AmbientSway,
    ];

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
    // Drawn after the blink and gaze schedules so those keep their draws.
    this.headSeedX = drawSeed(this.rng);
    this.headSeedY = drawSeed(this.rng);
    this.headSeedZ = drawSeed(this.rng);
    // Last, so every draw above keeps its place in the sequence.
    this.breathPeriodMs = this.drawBreathPeriod();
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
    // Host-supplied timestamp, same boundary rule as FixedStepClock.advance and
    // ParameterStore.set: drop the frame, touch nothing. `clockMs += NaN` would
    // stick, and every blink/gaze schedule reads clockMs — the face would go
    // still permanently. A host driving from media time hands you NaN through an
    // ordinary path (`duration * pct` before metadata loads).
    if (!Number.isFinite(nowMs)) return;
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
    // Each brow follows its own eye's openness; the unified blink makes the
    // two the same. Written as dip × (eye − 1) so an open eye adds +0.
    for (const { id, rest } of this.brows) {
      this.sink(id, rest + BROW_BLINK_DIP * (eyeVal - 1));
    }

    const breath = this.advanceBreath();
    this.advanceGaze(dt);

    this.sink(StandardParameter.Breath, breath);
    this.sink(StandardParameter.EyeballX, this.eyeX.value);
    this.sink(StandardParameter.EyeballY, this.eyeY.value);

    // The head idle keeps the character (and any hair physics reading
    // AngleX/Y/Z) from freezing solid between blinks. Models without these
    // parameters ignore the writes (ParameterStore drops unknown ids).
    this.advanceHead(dt, breath);
    this.sink(StandardParameter.AngleX, this.headX.value);
    this.sink(StandardParameter.AngleY, this.headY.value);
    this.sink(StandardParameter.AngleZ, this.headZ.value);
    this.sink(StandardParameter.AmbientSway, this.ambientSway());
  }

  /**
   * Hold the gaze on (`x`, `y`), in EyeballX/Y units (+ is the viewer's right
   * and up), until {@link clearGazeTarget}: the eyes chase it on their stiff
   * springs and the head follows it on the turn and nod, as it follows a
   * scheduled pick. Each value is clamped to [-1, 1], so the follow can reach
   * past the scheduled picks' ±0.8 / ±0.5 box. A pair with a non-finite value
   * is ignored and changes nothing, the same boundary rule as
   * ParameterStore.set.
   *
   * The scheduled retargets keep running and drawing from the rng while a host
   * target is set, so the rng sequence does not depend on host calls.
   */
  setGazeTarget(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.hostGaze = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }

  /**
   * Drop the host target: the eyes and head turn back to the current
   * scheduled pick at once (a pointer leaving does not leave the eyes frozen
   * until the next retarget), and later picks drive them as before.
   */
  clearGazeTarget(): void {
    this.hostGaze = undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitRestingPose(): void {
    this.sink(StandardParameter.EyeOpenLeft, 1);
    this.sink(StandardParameter.EyeOpenRight, 1);
    for (const { id, rest } of this.brows) this.sink(id, rest);
    // Breath at phase 0: the start of an inhale, empty.
    this.sink(StandardParameter.Breath, 0);
    this.sink(StandardParameter.EyeballX, 0);
    this.sink(StandardParameter.EyeballY, 0);
    // The head springs start at rest at 0 — the head starts centered.
    this.sink(StandardParameter.AngleX, 0);
    this.sink(StandardParameter.AngleY, 0);
    this.sink(StandardParameter.AngleZ, 0);
    this.sink(StandardParameter.AmbientSway, 0);
  }

  /** Returns the current eye-open value (0..1) and advances blink state. */
  private advanceBlink(): number {
    const { clockMs } = this;

    // If a blink is in progress, evaluate the envelope.
    if (this.blinkStartMs >= 0) {
      const phase = (clockMs - this.blinkStartMs) / BLINK_DURATION_MS;
      if (phase >= 1) {
        // Blink finished — schedule the next one on the internal clock: the
        // second of a pair after a short beat, else after the usual interval.
        // Only a first blink draws the coin.
        this.blinkStartMs = -1;
        this.blinkIsSecond = !this.blinkIsSecond && this.rng() < DOUBLE_BLINK_P;
        this.nextBlinkAtMs =
          clockMs +
          (this.blinkIsSecond
            ? DOUBLE_BLINK_GAP_MS
            : lerp(BLINK_INTERVAL_MIN_MS, BLINK_INTERVAL_MAX_MS, this.rng()));
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

  /**
   * Returns the breath value (0..1), starting the next cycle, with a freshly
   * drawn length, once the current one has run out. One clamped dt (≤ 100 ms)
   * is far shorter than any cycle, so a step crosses at most one boundary.
   */
  private advanceBreath(): number {
    if (this.clockMs - this.breathStartMs >= this.breathPeriodMs) {
      this.breathStartMs += this.breathPeriodMs;
      this.breathPeriodMs = this.drawBreathPeriod();
    }
    return breathEnvelope(
      (this.clockMs - this.breathStartMs) / this.breathPeriodMs,
    );
  }

  private drawBreathPeriod(): number {
    return lerp(BREATH_PERIOD_MIN_MS, BREATH_PERIOD_MAX_MS, this.rng());
  }

  /**
   * Step each head spring toward its axis noise at the internal clock, plus,
   * on the turn and nod, the gaze target scaled to degrees, and on the nod the
   * breath's lift. Only the noise fades in: the scheduled pick starts at
   * (0, 0), so it has no start value to lurch to, and its first jump is no
   * larger than any later one; the breath starts empty, at 0.
   */
  private advanceHead(dt: number, breath: number): void {
    const seconds = this.clockMs / 1000;
    const easeIn = smoothstep(this.clockMs / HEAD_NOISE_EASE_IN_MS);
    this.headX.step(
      easeIn *
        HEAD_NOISE_AMP_X_DEG *
        fbm(this.headSeedX, seconds * HEAD_NOISE_RATE_X_HZ) +
        HEAD_FOLLOW_X_DEG * (this.hostGaze?.x ?? this.gazeTargetX),
      dt,
    );
    this.headY.step(
      easeIn *
        HEAD_NOISE_AMP_Y_DEG *
        fbm(this.headSeedY, seconds * HEAD_NOISE_RATE_Y_HZ) +
        HEAD_FOLLOW_Y_DEG * (this.hostGaze?.y ?? this.gazeTargetY) +
        BREATH_PITCH_DEG * breath,
      dt,
    );
    this.headZ.step(
      easeIn *
        HEAD_NOISE_AMP_Z_DEG *
        fbm(this.headSeedZ, seconds * HEAD_NOISE_RATE_Z_HZ),
      dt,
    );
  }

  /** Ambient sway (-1..1), pure function of the internal clock. */
  private ambientSway(): number {
    const t = 2 * Math.PI * this.clockMs;
    return (
      AMBIENT_AMP_A * Math.sin(t / AMBIENT_PERIOD_A_MS) +
      AMBIENT_AMP_B * Math.sin(t / AMBIENT_PERIOD_B_MS)
    );
  }

  /**
   * Step the eye springs toward the gaze target, the host's while set, else
   * the scheduled pick; retarget on the internal clock either way.
   */
  private advanceGaze(dt: number): void {
    // Retarget check reads clockMs so a clamped pause can't skip retargets.
    if (this.clockMs >= this.nextGazeRetargetMs) {
      if (this.rng() < GAZE_EYE_CONTACT_P) {
        this.gazeTargetX = 0;
        this.gazeTargetY = 0;
      } else {
        this.gazeTargetX = lerp(-GAZE_X_MAX, GAZE_X_MAX, this.rng());
        this.gazeTargetY = lerp(-GAZE_Y_MAX, GAZE_Y_MAX, this.rng());
      }
      this.nextGazeRetargetMs =
        this.clockMs +
        lerp(GAZE_RETARGET_MIN_MS, GAZE_RETARGET_MAX_MS, this.rng());
    }
    this.eyeX.step(this.hostGaze?.x ?? this.gazeTargetX, dt);
    this.eyeY.step(this.hostGaze?.y ?? this.gazeTargetY, dt);
  }
}
