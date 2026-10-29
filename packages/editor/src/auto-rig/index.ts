export {
  DEFAULT_TURN_TARGETS,
  LayerGeometryError,
  PatchError,
  TurnTargetError,
  type IrisStrand,
  type LayerInput,
  type PatchReport,
  type RigPatch,
  type StrandOverlap,
  type TurnDepths,
  type TurnSolveReport,
  type TurnTargets,
} from "./types";
export {
  RigPlanError,
  RIG_PLAN_FIELDS,
  styleRemovedMessage,
  type RigPlan,
  type RigPlanField,
  type RigPlanReport,
} from "./rig-plan";
export { armGeometry, type ArmGeometry } from "./arms";
export { forearmPoseGeometry, type ForearmPoseGeometry } from "./forearm-pose";
export {
  columnRuns,
  mouthFold,
  mouthOpening,
  mouthRestShift,
  LIP_ROLES,
  type LipRole,
  type Opening,
  type OpeningColumn,
} from "./mouth";
export {
  LIP_INSIDE_ROLES,
  SHUT_BY,
  isLipInsideRole,
  parseLayerRoles,
  partIdsOfRole,
  type LipInsideRole,
} from "./roles";
export { generateIkiFromLayerSet } from "./generate";
