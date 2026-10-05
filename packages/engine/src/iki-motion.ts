import { type IkiModel, StandardParameter } from "@ikijs/format";
import { ClipPlayer } from "./clip-player";
import { ExpressionPlayer } from "./expression-player";
import { MAX_DT_MS } from "./frame-clock";
import { HairChainMotion } from "./hair-chain-motion";
import { IdleMotion } from "./idle-motion";
import { clamp } from "./math";
import { ParameterStore } from "./parameter-store";
import { PhysicsMotion } from "./physics-motion";

/** IdleMotion's head sway and gaze: what a declared Idle group replaces. */
const HEAD_AND_GAZE: ReadonlySet<string> = new Set([
  StandardParameter.AngleX,
  StandardParameter.AngleY,
  StandardParameter.AngleZ,
  StandardParameter.EyeballX,
  StandardParameter.EyeballY,
]);

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
 * When an expression's release completes or a one-shot ends, the ids it drove
 * are written once more at base and then dropped; so are the ids only a
 * replaced clip held, once the clip replacing it finishes its fade-in. A
 * parameter nothing else writes therefore rests at its default.
 *
 * Idle replacement: when the model declares an `Idle` motion group, its clips
 * loop in place of the procedural head sway and gaze — IdleMotion's AngleX/Y/Z
 * and EyeballX/Y writes are dropped. A head or gaze parameter the Idle clips
 * don't animate is left unwritten by idle and rests where it is (a one-shot or
 * an expression can still drive it). Blink (EyeOpen L/R) and Breath stay
 * procedural: the format rejects an Idle curve on them. Without an `Idle`
 * group the procedural idle runs whole.
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
   * (without head and gaze when the model declares an `Idle` group), the curve
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
    this.expressions = new ExpressionPlayer(model.expressions);
    const idleKeeps: (id: string) => boolean = this.clips.hasIdleLoop
      ? (id) => !HEAD_AND_GAZE.has(id)
      : () => true;
    this.idle = new IdleMotion((id, value) => {
      if (idleKeeps(id)) this.frame.set(id, value);
    });
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
        ...this.clips.parameterIds,
        ...this.expressions.parameterIds,
        ...this.physics.drivenParameterIds,
        ...this.chains.drivenParameterIds,
      ]),
    ];
  }

  /**
   * Make expression `id` active, fading it in over its `fadeIn` and releasing
   * the active one over that one's `fadeOut`. Returns false, and changes
   * nothing, for an id the model does not declare. Playing the active id
   * again changes nothing and returns true; playing one still fading out
   * brings that same entry back from its current weight, so it never stacks.
   */
  playExpression(id: string): boolean {
    return this.expressions.play(id);
  }

  /** Release the active expression, if any, over its `fadeOut`. */
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
   * Advance everything to the same wall-clock timestamp (milliseconds), in
   * this order:
   *
   * 1. Idle writes blink, breath (and head and gaze, unless replaced) into
   *    this update's frame.
   * 2. The clip stage writes the `Idle` loop, then the one-shot over it.
   * 3. The expression stage writes released expressions oldest first, then
   *    the active one.
   * 4. The frame goes to `sink`, each id exactly once, in the order its first
   *    writer gave it: an expression on EyeOpenL is flushed in idle's slot.
   * 5. Physics, then chains. They read their inputs through `read`, so the
   *    springs lag the head this update put on screen (idle sway or clips),
   *    and a chain resolves its anchor from that same pose (which may include
   *    a physics output). Physics outputs are physics-owned: a clip or
   *    expression that writes one is overwritten here.
   *
   * The host writes the signals it owns (lip-sync MouthOpen, gaze overrides)
   * AFTER update(); the last write wins. That is how lip-sync beats an
   * expression that opens the mouth.
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
      this.clips.apply(dtS, this.frame, this.rest);
      this.expressions.apply(dtS, this.frame, this.rest);
    }
    this.frame.forEach(this.flush);
    this.physics.update(nowMs);
    this.chains.update(nowMs);
  }
}
