---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

**Every model rigged from this release on turns, nods, rolls, blinks and
sways differently, and models rigged earlier are untouched until they are
rigged again.** The auto-rig (`generateIkiFromLayerSet`, and so
`auto_rig_from_layers`) is rewritten to reproduce a Live2D default rig,
measured on the Cubism sample models and described in
[`packages/editor/AUTO-RIG.md`](packages/editor/AUTO-RIG.md). There is no
`.iki` format change.

What moves:

- The parallax turn: the face plate translates, the chin and features lead
  it, the front hair rides the face and holds the outline it draws, and the
  back hair counter-drifts.
- The face layer's neck and ears become islands: the neck stays, the chin's
  shade slides over it, and the ears lag.
- AngleZ rolls the head about 10° around the chin.
- `body` only breathes; it no longer takes AngleX.
- Gaze, blink, mouth, brow, breath and sway amplitudes come from the profile.

Model structure a host may notice: `faceWarp` and `blushWarp_L/R` are no
longer emitted. The face, blush and both hair layers carry their own
AngleX/AngleY keyforms under `headDeformer`. `eyeWarp_L/R`, `browWarp_L/R`,
`noseWarp` and `mouthWarp` remain. Turn and nod keyforms sit at 0 and ±30
only.

API changes:

- `DEFAULT_TURN_TARGETS.farEyeRatio` goes from 0.67 to 0.78. `eyeShift` 0.22
  and `silhouetteRatio` 1 are unchanged. With no `turnTargets`, the rig
  renders the profile, and the report says what the cues read.
- A passed `eyeShift` is fitted by the turn's amount, up to 3×, so a small
  one is fitted rather than refused. The "every silhouetteRatio in
  [0.5, 1.5]" refusal is gone.
- `clamped` names the turn (passed, or the profile's own) where the art's
  room cut it, and a profile `noseShift` / `mouthShift` past its room.
- `strandEdges` without `hair_front` now throws `TurnTargetError`.
- `TurnSolveReport.radius` and `depths` keep their fields, with new meanings
  documented on the types.

Input changes (0.x, so no bump, but a call that worked before can now be
refused):

- Signed `eyeShift` / `noseShift` / `mouthShift` are still accepted, as
  before; the magnitude is used.
- A face layer under 24 px is refused, naming the file.
- An unknown `style` or `turnTargets` key is refused, and so is a `style` or
  `turnTargets` that is not a plain object. In `@ikijs/mcp`, `autoRigFromLayers`
  returns all of these, and a `turnTargets.headHalfWidth` (which the tool
  measures off the layers), as an `INVALID` result instead of dropping them or
  rigging on the defaults. Over MCP, the tool's input schema still rejects a
  non-object before the tool runs, which the SDK answers with an `isError`
  "Input validation error" result.
- `parseLayerRoles` keeps its name normalisation; directory prefixes are
  still not accepted.

New API:

- `options.style` and the exported `RigStyle`: six knobs (`turn`,
  `featureLead`, `hairFollow`, `outlineFollow`, `blink`, `sway`) with
  defaults and ranges. A knob out of range throws `TurnTargetError` naming
  `style.<knob>`. `style.turn` is ignored under a caller `eyeShift`.
- `LayerInput.jawRows`, measured by `createLayerSetMeasurer`.
- `@ikijs/mcp`: the `style` input on `auto_rig_from_layers`, and the
  rewritten tool text. The result shape is unchanged.

The playground hero was re-rigged as an example.
