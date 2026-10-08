---
"@ikijs/format": minor
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

The full body's finishing pass 3: a second, drawn forearm swaps in at the
elbow, rocks, and gives the character a Wave.

- `@ikijs/format`: four `StandardParameter` ids. `ParamArmPoseL/R` (0..1) swap
  the hanging forearm for the drawn pose forearm, with a crossfade between;
  `ParamArmPoseAngleL/R` (−15..15 degrees) rock the pose forearm about the
  elbow, positive tipping the raised hand outward, mirrored per side.
- `@ikijs/editor`: the roles `forearm_pose_L` / `forearm_pose_R`, one meshless
  part each, drawn above the face and hair on `armPoseDeformer_X` hung from
  the arm's shoulder deformer at its elbow; a complementary opacity swap
  against the arm's forearm band and elbow cap; `forearmPoseGeometry` /
  `ForearmPoseGeometry` exported; the layer measurer leaves a
  rest-hidden layer out of the head's union; `defaultMotions` with a `Wave`
  (right hand, 2.2 s), attached only where its three parameters are declared.
- `@ikijs/mcp`: `forearm_pose.png` composed onto each arm's elbow (scaled from
  the elbow run, `mirrorParts`, `preview-pose.png` / `previewPose`), the pose
  checks in `measure_layers`, the tool descriptions and the four parameter
  entries.

**Four new `StandardParameter` ids are a pre-1.0 contract addition.** Only a
model with a pose forearm declares them; every other model is byte-identical.
`IKI_FORMAT_VERSION` is unchanged.
