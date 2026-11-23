import { type IkiModel, StandardParameter } from "@ikijs/format";
import { ClipPlayer } from "./clip-player";
import { ExpressionPlayer } from "./expression-player";
import { MAX_DT_MS } from "./frame-clock";
import { HairChainMotion } from "./hair-chain-motion";
import { eyeSpring, IdleMotion } from "./idle-motion";
import { clamp } from "./math";
import { ParameterStore } from "./parameter-store";
import { PhysicsMotion } from "./physics-motion";

/** IdleMotion's head and gaze: what a declared Idle group replaces. */
const HEAD_AND_GAZE: ReadonlySet<string> = new Set([
  StandardParameter.AngleX,
  StandardParameter.AngleY,
  StandardParameter.AngleZ,
  StandardParameter.EyeballX,
  StandardParameter.EyeballY,
]);

/**
 * Below this on both axes, in parameter units and units per second, a
 * released host gaze is back on base and its stage stops writing.
 */
const GAZE_SETTLED = 1e-3;

/**
 * The host gaze under a declared Idle group, where idle's own eyes are
 * dropped. A spring per axis, as stiff as the idle eyes'. While the host
 * holds a target the spring carries the eyes' value, starting from base (the
 * Idle loop's EyeballX/Y, else rest), and chases the target, so the eyes stay
 * on it whatever an Idle eye curve under them does. Once the host lets go it
 * carries the eyes' offset from base and chases 0, so they come back to base
 * and, once there, follow an Idle eye curve exactly. Each switch converts at
 * the current base, so the eyes never jump.
 */
class HostGaze {
  target: { x: number; y: number } | undefined = undefined;
  /** From the first update with a target until the eyes are back on base. */
  private active = false;
  /** The springs carry the value (target held), else the offset from base. */
  private absolute = false;
  private readonly x = eyeSpring();
  private readonly y = eyeSpring();

  apply(
    dtMs: number,
    frame: Map<string, number>,
    rest: (id: string) => number,
  ): void {
    if (!this.target && !this.active) return;
    const baseX =
      frame.get(StandardParameter.EyeballX) ?? rest(StandardParameter.EyeballX);
    const baseY =
      frame.get(StandardParameter.EyeballY) ?? rest(StandardParameter.EyeballY);
    if (!this.active) {
      this.active = true;
      this.absolute = true;
      this.x.value = baseX;
      this.y.value = baseY;
    } else if (this.absolute !== (this.target !== undefined)) {
      const sign = this.absolute ? -1 : 1;
      this.x.value += sign * baseX;
      this.y.value += sign * baseY;
      this.absolute = !this.absolute;
    }

    if (this.target) {
      this.x.step(this.target.x, dtMs);
      this.y.step(this.target.y, dtMs);
      frame.set(StandardParameter.EyeballX, this.x.value);
      frame.set(StandardParameter.EyeballY, this.y.value);
      return;
    }

    this.x.step(0, dtMs);
    this.y.step(0, dtMs);
    const settled = (s: { value: number; velocity: number }): boolean =>
      Math.abs(s.value) < GAZE_SETTLED && Math.abs(s.velocity) < GAZE_SETTLED;
    if (settled(this.x) && settled(this.y)) {
      // One last write at base, as a one-shot's end does: an eye nothing else
      // writes rests at its default, not a hair off it.
      this.active = false;
      this.x.value = this.x.velocity = 0;
      this.y.value = this.y.velocity = 0;
      frame.set(StandardParameter.EyeballX, baseX);
      frame.set(StandardParameter.EyeballY, baseY);
      return;
    }
    frame.set(StandardParameter.EyeballX, baseX + this.x.value);
    frame.set(StandardParameter.EyeballY, baseY + this.y.value);
  }
}

/**
 * Bundles the model's motion into the one loop every host otherwise
 * hand-builds: the procedural {@link IdleMotion}, the model's motion clips and
 * expressions, then {@link PhysicsMotion} and {@link HairChainMotion} — stepped
 * in the order physics and chains depend on, with a record of what they write.
 *
 * Usage:
 *   const motion = new IkiMotion(
 *     model,
 *     (id) => player.getParameter(id),
 *     (id, value) => player.setParameter(id, value),
 *   );
 *   motion.playExpression("smile");
 *   motion.playMotion("Nod", 0);
 *   // inside your rAF loop:
 *   motion.update(performance.now());
 *   // then the signals the host owns, e.g. lip-sync:
 *   player.setParameter(StandardParameter.MouthOpen, mouth);
 *
 * The model is the catalog: a host lists what it can play from
 * `model.expressions` (ids) and `model.motions` (group names and clip
 * indices). There are no getters for them here.
 *
 * Clips and expressions compose over a base, never over the store's current
 * value: an id's base is the value an earlier stage put in this update's
 * frame (for the one-shot: the procedural idle and the `Idle` loop; for an
 * expression: those and the one-shot), else its resting value
 * `clamp(default, min, max)`. So an `add` on a brow cannot accumulate across
 * frames, and an expression composes with the blink and a clip-driven head.
 * When an expression's stop completes or a one-shot ends, the ids it drove
 * are written once more at base and then dropped; so are the ids only a
 * replaced clip or expression held, once the one replacing it finishes its
 * fade-in. A parameter nothing else writes therefore rests at its default.
 *
 * Idle replacement: when the model declares an `Idle` motion group, its clips
 * loop in place of the procedural head and gaze — IdleMotion's AngleX/Y/Z
 * and EyeballX/Y writes are dropped, and with the head its breath pitch and
 * its follow of the gaze. A head or gaze parameter the Idle clips don't
 * animate is left unwritten by idle and rests where it is (a one-shot or an
 * expression can still drive it); {@link setGazeTarget} still moves the eyes,
 * but not the head. Blink (EyeOpen L/R), Breath and the ambient sway stay
 * procedural: the format rejects an Idle curve on them. The brows' blink dip
 * stays too, as part of the blink; an Idle curve on a brow is written over
 * it. Without an `Idle` group the procedural idle runs whole.
 *
 * The host schedules; this class has no timers, rAF, DOM, or Date.now.
 *
 * Stopping is the host's too: stop calling update(). The drivers leave the
 * pose where it was — a host that wants it back writes its own resting values
 * to `drivenParameterIds`.
 */
export class IkiMotion {
  /**
   * Everything {@link update} may write, deduplicated, in this order: idle ids
   * (without head and gaze when the model declares an `Idle` group, with
   * EyeballX/Y then listed after them for {@link setGazeTarget}), the curve
   * parameters of every motion group, expression parameters, rig outputs,
   * then chain-segment outputs. May name ids the model lacks (idle writes the
   * standard ids regardless, and the player silently drops writes to unknown
   * ids) — intersect with the model's parameters if you mirror into your own
   * store.
   */
  readonly drivenParameterIds: readonly string[];
  private readonly sink: (id: string, value: number) => void;
  private readonly idle: IdleMotion;
  private readonly clips: ClipPlayer;
  private readonly expressions: ExpressionPlayer;
  private readonly physics: PhysicsMotion;
  private readonly chains: HairChainMotion;
  /** The host gaze's own eye stage; only under a declared Idle group. */
  private readonly hostGaze: HostGaze | undefined;
  /** Resting value per id; 0 for an undeclared id. */
  private readonly rest: (id: string) => number;
  /** This update's idle, clip and expression writes, in first-write order. */
  private readonly frame = new Map<string, number>();
  /** Bound once: `Map.forEach` hands it each entry without a tuple per id. */
  private readonly flush = (value: number, id: string): void =>
    this.sink(id, value);
  private prevNowMs: number | undefined = undefined;

  constructor(
    model: IkiModel,
    read: (id: string) => number,
    sink: (id: string, value: number) => void,
  ) {
    const rigs = model.physics ?? [];
    const chains = model.physicsChains ?? [];
    // A store nobody writes holds every parameter at rest, resolved the way
    // the player's store resolves it (a non-finite default rests at 0,
    // clamped), and reads 0 for an undeclared id.
    const restPose = new ParameterStore(model.parameters);
    this.sink = sink;
    this.rest = (id) => restPose.get(id);
    this.clips = new ClipPlayer(model.motions, model.parameters);
    this.expressions = new ExpressionPlayer(
      model.expressions,
      model.parameters,
    );
    const idleKeeps: (id: string) => boolean = this.clips.hasIdleLoop
      ? (id) => !HEAD_AND_GAZE.has(id)
      : () => true;
    this.idle = new IdleMotion(
      (id, value) => {
        if (idleKeeps(id)) this.frame.set(id, value);
      },
      { parameters: model.parameters },
    );
    this.hostGaze = this.clips.hasIdleLoop ? new HostGaze() : undefined;
    this.physics = new PhysicsMotion(rigs, model.parameters, read, sink);
    this.chains = new HairChainMotion(
      chains,
      model.parameters,
      model.deformers ?? [],
      read,
      sink,
    );
    this.drivenParameterIds = [
      ...new Set([
        ...this.idle.drivenParameterIds.filter(idleKeeps),
        ...(this.hostGaze
          ? [StandardParameter.EyeballX, StandardParameter.EyeballY]
          : []),
        ...this.clips.parameterIds,
        ...this.expressions.parameterIds,
        ...this.physics.drivenParameterIds,
        ...this.chains.drivenParameterIds,
      ]),
    ];
  }

  /**
   * Make expression `id` active, fading it in over its `fadeIn` from the
   * current pose: it replaces the active one and blends from that one's
   * current output, as {@link playMotion} does, so nothing dips toward base on
   * the way. Returns false, and changes nothing, for an id the model does not
   * declare. Playing the active id again changes nothing and returns true; an
   * expression never stacks on itself.
   */
  playExpression(id: string): boolean {
    return this.expressions.play(id);
  }

  /** Fade the active expression, if any, back to base over its `fadeOut`. */
  stopExpression(): void {
    this.expressions.stop();
  }

  /**
   * Start clip `index` of motion group `group` at once. A running one-shot
   * stops, and the new clip fades in from the old one's last pose. Returns
   * false, and changes nothing, for a group the model does not declare or an
   * index that is not an integer in range. Any group plays one-shot, `Idle`
   * included; there is no queue.
   */
  playMotion(group: string, index: number): boolean {
    return this.clips.play(group, index);
  }

  /**
   * The one-shot {@link playMotion} started, while it runs: null before any
   * and from the {@link update} that carries it past its duration on. It runs
   * on the clips' clock, which advances at most `MAX_DT_MS` per update, so
   * after a long frame gap it is still reported until it has really played
   * out. A rejected playMotion leaves it as it was. The engine only reports;
   * which clip may interrupt which is the host's call.
   */
  activeMotion(): { group: string; index: number } | null {
    return this.clips.active();
  }

  /**
   * Hold the gaze on (`x`, `y`), in EyeballX/Y units, until
   * {@link clearGazeTarget}. Each value is clamped to [-1, 1]; a pair with a
   * non-finite value is ignored and changes nothing.
   *
   * Without an `Idle` motion group the idle gaze holds it: the eyes go there
   * and the head follows on the turn and nod, as
   * {@link IdleMotion.setGazeTarget} describes.
   *
   * Under a declared `Idle` group the eyes go there on springs as stiff as
   * the idle eyes', and the head stays the Idle clips'. While a target is
   * set it wins over any EyeballX/Y the Idle clips animate; a one-shot or an
   * expression still composes over it, as over any base. With no target the
   * Idle clips' eyes play untouched.
   */
  setGazeTarget(x: number, y: number): void {
    this.idle.setGazeTarget(x, y);
    if (this.hostGaze && Number.isFinite(x) && Number.isFinite(y)) {
      this.hostGaze.target = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    }
  }

  /**
   * Drop the host gaze target; the idle's own gaze resumes. Under a declared
   * `Idle` group the eyes spring back to what the Idle clips write, else to
   * their resting values, and are left there: nothing of the target stays in
   * the store.
   */
  clearGazeTarget(): void {
    this.idle.clearGazeTarget();
    if (this.hostGaze) this.hostGaze.target = undefined;
  }

  /**
   * Advance everything to the same wall-clock timestamp (milliseconds), in
   * this order:
   *
   * 1. Idle writes blink, the declared brows' blink dip, breath, the ambient
   *    sway (and head and gaze, unless replaced) into this update's frame.
   * 2. The clip stage writes the `Idle` loop, then, under a declared `Idle`
   *    group, the host gaze's eyes ({@link setGazeTarget}), then the one-shot
   *    over both.
   * 3. The expression stage writes the active expression, fading in from the
   *    pose it replaced, or a stop fading back to base.
   * 4. The frame goes to `sink`, each id exactly once, in the order its first
   *    writer gave it: an expression on EyeOpenL is flushed in idle's slot.
   * 5. Physics, then chains. They read their inputs through `read`, so the
   *    springs lag the head this update put on screen (idle sway or clips),
   *    and a chain resolves its anchor from that same pose (which may include
   *    a physics output). Physics outputs are physics-owned: a clip or
   *    expression that writes one is overwritten here.
   *
   * The host writes the signals it owns (lip-sync MouthOpen, brows it drives
   * itself) AFTER update(); the last write wins. That is how lip-sync beats
   * an expression that opens the mouth, and how a host's brow beats idle's
   * blink dip. A host pointer goes through {@link setGazeTarget} instead, so
   * the head follows it (the eyes alone under an `Idle` group).
   *
   * The clips and expressions advance by `clamp(now − prev, 0, MAX_DT_MS)`,
   * 0 on the first update. A non-finite `nowMs` is a dropped frame: idle and
   * both players write nothing and do not advance (physics and chains re-emit
   * their outputs unchanged), and the next finite frame measures from the
   * last finite one, as IdleMotion does.
   */
  update(nowMs: number): void {
    this.frame.clear();
    this.idle.update(nowMs);
    if (Number.isFinite(nowMs)) {
      const dtS =
        this.prevNowMs === undefined
          ? 0
          : clamp(nowMs - this.prevNowMs, 0, MAX_DT_MS) / 1000;
      this.prevNowMs = nowMs;
      this.clips.applyLoop(dtS, this.frame);
      this.hostGaze?.apply(dtS * 1000, this.frame, this.rest);
      this.clips.applyOneShot(dtS, this.frame, this.rest);
      this.expressions.apply(dtS, this.frame, this.rest);
    }
    this.frame.forEach(this.flush);
    this.physics.update(nowMs);
    this.chains.update(nowMs);
  }
}
