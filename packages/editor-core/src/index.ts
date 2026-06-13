export {
  EditorDocument,
  type AtlasAssignment,
  type ApplyAtlasInput,
} from "./document";
export {
  AddDeformer,
  AddPart,
  CaptureGridKeyform,
  DeleteDeformer,
  DeletePart,
  SetDeformerBindings,
  SetDeformerParent,
  SetDeformerPivot,
  SetDeformerPivotX,
  SetDeformerPivotY,
  SetDeformerTransform,
  SetPartBindings,
  SetPartColor,
  SetPartDeformer,
  SetPartMesh,
  SetPartHeight,
  SetPartOrder,
  SetPartTransform,
  SetPartWidth,
  type DeformerTransformChannel,
  type EditCommand,
  type EditTransformChannel,
} from "./commands";
export { captureBindingEndpoint } from "./binding-capture";
export {
  computeGridOffsets,
  interpolateGridOffsets,
  upsertGridKeyform,
} from "./grid-keyform";
export {
  packAtlas,
  uvRectFor,
  ATLAS_PADDING,
  UV_INSET_PX,
  type AtlasSource,
  type AtlasPlacement,
  type AtlasLayout,
} from "./atlas";
export {
  validateDeformerDelete,
  validateDeformerReparent,
  validatePartAttach,
} from "./reparent";
export {
  createDefaultPart,
  createDefaultMatrixDeformer,
  createDefaultWarpDeformer,
  createGridMesh,
} from "./factories";
export {
  generateIkiFromLayerSet,
  parseLayerRoles,
  bboxToTransform,
  ROLE_TABLE,
  type LayerInput,
  type RoleSpec,
} from "./auto-rig";
