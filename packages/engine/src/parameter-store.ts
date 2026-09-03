import type { IkiParameter } from "@ikijs/format";
import { clamp } from "./math";

/**
 * Holds the live value of every model parameter, clamped to its declared
 * range. This is the single surface a host drives (lip-sync, gaze, blink) and
 * the engine reads each frame to evaluate bindings.
 */
export class ParameterStore {
  private readonly params = new Map<string, IkiParameter>();
  private readonly values = new Map<string, number>();
  /**
   * Resting value per id: the declared default clamped into range, resolved
   * ONCE here so `reset()` is a straight copy and a malformed descriptor is
   * reported once rather than on every reset.
   */
  private readonly defaults = new Map<string, number>();

  constructor(parameters: IkiParameter[]) {
    for (const param of parameters) {
      this.params.set(param.id, param);
      // A non-finite default would survive `clamp` and poison every read, so it
      // falls back to the neutral in-range value — but say so rather than
      // repairing a broken descriptor silently. `parseIkiModel` requires a
      // finite default, so this only reaches a host that skipped the validator.
      if (!Number.isFinite(param.default)) {
        console.error(
          `Iki: parameter "${param.id}" has a non-finite default; resting at the neutral in-range value instead`,
        );
      }
      const base = Number.isFinite(param.default) ? param.default : 0;
      this.defaults.set(param.id, clamp(base, param.min, param.max));
    }
    for (const [id, value] of this.defaults) this.values.set(id, value);
  }

  /**
   * Set a parameter's value, clamped to its range. Unknown ids are ignored, as
   * are non-finite values: this is the boundary a host drives with live signals,
   * and `clamp` cannot filter NaN (`Math.max(min, Math.min(max, NaN))` is NaN),
   * so one bad lip-sync/gaze frame would otherwise poison every binding that
   * reads the parameter. A dropped write holds the last good pose.
   */
  set(id: string, value: number): void {
    const param = this.params.get(id);
    if (!param) return;
    if (!Number.isFinite(value)) return;
    this.values.set(id, clamp(value, param.min, param.max));
  }

  /** Current value, or 0 if the id is unknown. */
  get(id: string): number {
    return this.values.get(id) ?? 0;
  }

  /** Position of a parameter within its range, 0..1. */
  normalized(id: string): number {
    const param = this.params.get(id);
    if (!param || param.max === param.min) return 0;
    return (this.get(id) - param.min) / (param.max - param.min);
  }

  /** Reset every parameter to its resting value (see `defaults`). */
  reset(): void {
    for (const [id, value] of this.defaults) this.values.set(id, value);
  }

  list(): IkiParameter[] {
    return [...this.params.values()];
  }
}
