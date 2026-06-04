import type { IkiParameter } from "@iki/format";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
      this.values.set(param.id, clamp(param.default, param.min, param.max));
    }
  }

  /** Set a parameter's value, clamped to its range. Unknown ids are ignored. */
  set(id: string, value: number): void {
    const param = this.params.get(id);
    if (!param) return;
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
      this.values.set(param.id, clamp(param.default, param.min, param.max));
    }
  }

  list(): IkiParameter[] {
    return [...this.params.values()];
  }
}
