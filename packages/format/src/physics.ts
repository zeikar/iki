import type { IkiPhysics, IkiPhysicsInput } from "./types";

/**
 * Every input of a physics rig, whichever form it declares — the one accessor
 * the engine, the validator and the editor read a rig's inputs through. The
 * non-null assertion rests on the validator: a parsed rig carries exactly one of
 * `input` and a non-empty `inputs`.
 */
export function physicsInputs(rig: IkiPhysics): readonly IkiPhysicsInput[] {
  return rig.inputs ?? [rig.input!];
}
