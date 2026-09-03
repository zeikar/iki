import type { IkiParameter } from "@ikijs/format";
import { clamp } from "./math";

/**
 * Resting value for a parameter: its declared default clamped into range.
 *
 * A non-finite default falls back to the mid-range-safe `clamp(0, min, max)`
 * rather than propagating NaN. `parseIkiModel` already requires a finite
 * default, so this only bites a host that builds a store from unvalidated
 * descriptors — but without it `reset()` would re-install NaN after any number
 * of good writes, quietly undoing the guard on {@link ParameterStore.set}.
 */
function restOf(param: IkiParameter): number {
  const base = Number.isFinite(param.default) ? param.default : 0;
  return clamp(base, param.min, param.max);
}

/**
 * Holds the live value of every model parameter, clamped to its declared
 * range. This is the single surface a host drives (lip-sync, gaze, blink) and
 * the engine reads each frame to evaluate bindings.
 */
export class ParameterStore {
  private readonly params = new Map<string, IkiParameter>();
  private readonly values = new Map<string, number>();

  constructor(parameters: IkiParameter[]) {
    for (const param of parameters) {
      this.params.set(param.id, param);
      this.values.set(param.id, restOf(param));
    }
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

  /** Reset every parameter to its declared default. */
  reset(): void {
    for (const param of this.params.values()) {
      this.values.set(param.id, restOf(param));
    }
  }

  list(): IkiParameter[] {
    return [...this.params.values()];
  }
}
