# @ikijs/editor

> Part of [Iki](https://github.com/zeikar/iki), the open Live2D alternative that AI can build — free and MIT-licensed, with an open `.iki` format and a [Claude Code plugin](https://github.com/zeikar/iki/tree/main/plugin) that draws and rigs characters.

**Headless** editing core for [`.iki`](https://github.com/zeikar/iki/tree/main/packages/format) models — a document with
undo/redo, invertible edit commands, atlas layout + UV math, and the auto-rigger.

This package ships no UI. It is the model and command layer an editor is built
_on_, not an editor you can mount.

Everything here is pure logic — no DOM, no canvas, no WebGL. It depends only on
[`@ikijs/format`](https://github.com/zeikar/iki/tree/main/packages/format), so the same core backs this repo's
browser editor app (`examples/editor`), the Node MCP server
([`@ikijs/mcp`](https://github.com/zeikar/iki/tree/main/packages/mcp)), and tests.

## Install

```bash
npm install @ikijs/editor @ikijs/format
```

## Usage

```ts
import { EditorDocument, SetPartWidth } from "@ikijs/editor";

const doc = new EditorDocument(model);

doc.execute(new SetPartWidth("mouth", 160));
doc.undo();
doc.redo();

const exported = doc.toIkiModel(); // validated via parseIkiModel, or throws
```

Every command captures its prior value on the first `apply`, so `undo` always
restores the original even after a `redo`. Commands that could produce an
invalid model validate a candidate **before** mutating, so a rejected edit
leaves the document untouched.

## API

| Area               | Exports                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Document           | `EditorDocument`, `EditCommand`                                                                                                                                          |
| Part edits         | `AddPart`, `DeletePart`, `SetPartColor`, `SetPartWidth`, `SetPartHeight`, `SetPartOrder`, `SetPartTransform`, `SetPartBindings`, `SetPartMesh`, `SetPartDeformer`        |
| Deformer edits     | `AddDeformer`, `DeleteDeformer`, `SetDeformerParent`, `SetDeformerTransform`, `SetDeformerBindings`, `SetDeformerPivot` (+ `X`/`Y`), `CaptureGridKeyform`                |
| Physics edits      | `AddPhysicsRig`, `SetPhysicsRig`, `DeletePhysicsRig`                                                                                                                     |
| Referential guards | `validateDeformerReparent`, `validateDeformerDelete`, `validatePartAttach`                                                                                               |
| Atlas              | `packAtlas`, `uvRectFor`, `ATLAS_PADDING`, `UV_INSET_PX`                                                                                                                 |
| Grid keyforms      | `computeGridOffsets`, `interpolateGridOffsets`, `upsertGridKeyform`                                                                                                      |
| Factories          | `createDefaultPart`, `createDefaultMatrixDeformer`, `createDefaultWarpDeformer`, `createGridMesh`                                                                        |
| Pixels             | `detectAlphaBbox`, `ALPHA_BBOX_THRESHOLD`, `AlphaBbox`, `ALPHA_OPAQUE`, `HEAD_BAND`, `SPECK_CORE_FRACTION`, `denseCoreOf`, `isSpeckCore`, `foregroundSpan`, `headHalfOf` |
| Auto-rig           | `generateIkiFromLayerSet`, `parseLayerRoles`, `createLayerSetMeasurer`, `TurnTargets`, `DEFAULT_TURN_TARGETS`, `TurnSolveReport`, `RigStyle`                             |
| Bindings           | `captureBindingEndpoint`                                                                                                                                                 |

## Auto-rig

`generateIkiFromLayerSet` turns role-named layers (`face`, `eye_L`, `eye_R`,
`mouth`, plus optional `iris_*`, `brow_*`, `lash_*`, `lash_lower_*`, `hair_front`, `hair_back`,
…) into a rigged model that blinks, gazes, opens its mouth, turns its head over
a torso that breathes, and emotes with its brows — including a
hair-sway physics rig when a `hair_front` layer is present. With a `blush_*`
layer it declares `ParamCheek`, which fades the blush from faint at rest to
as drawn. Every rigged model also declares six default expressions (smile,
laugh, angry, sad, surprised, shy) and the head motions Nod, Shake and Tilt,
each with a description a host picks by, the expressions keeping only the
parameters the model declares (`AUTO-RIG.md`).

The rig turns the head by parallax, not a reshaped face, with values of our
own picked by eye (`auto-rig/profile.ts`, `AUTO-RIG.md`). The face plate
translates, the chin leading it; the features lead the plate by their depth
(the nose most, then the eyes, brows and mouth), the eyes foreshortening mildly
about their own centres; the front hair rides the face where it lies over it and holds the head's
outline where it draws it — though on its cap the turn never carries its outer
edge further outside the back hair painted behind it than the nod alone does —
and the back hair stays behind; the neck and the
ears the face layer paints are cut off into islands of the plate's own mesh,
drawn behind the head — the neck stays (only the chin's shade slides across
it), the ears lag the face, the far one narrowing. AngleZ rolls the head 14° about the chin; the torso only
breathes.

On a layer set with a `nose`, `options.turnTargets` — the cues a 30° reference
measures (how far the eye pair slides, how much the far eye foreshortens,
whether the silhouette holds) — are **fitted** each by the one knob it reads:
the turn's amount, the eyes' foreshortening, the hair's width, a feature's own
shift. With none given the profile itself renders (`DEFAULT_TURN_TARGETS`
expresses it in the cues' units). `options.style` tunes a character from the
profile: the whole turn, the
features' lead, the front hair's follow and its outline's, the blink and the
hair sway. The turn
is bounded by the art: the far eye stays inside the plate's outline and, given
`options.strandEdges`, the far iris may not slide under the bangs' side strand
any further than it is painted — best effort, never a refusal. The report's
`strandOverlap` gives, per side whose far iris the bangs' run still covers at
some far stop, the covered width: how much of the iris's painted row the run
covers at the stop where that is largest, in px and head half-widths, next to
how much it covers at rest, and whether the bound held.
[`AUTO-RIG.md`](./AUTO-RIG.md) describes the model, the fit and the limits.

An `eyeShift` you passed that runs past the room the art leaves the far eye —
the face plate's edge, or the bangs' strand — is **clamped** and the rig is
built, since that room is a fact about these layers, not about the reference;
so is the profile's own turn where the art has less room than it needs, and
a `silhouetteRatio` that would narrow a plate drawn without hair too far for
its head to cover the far ear's slide (see AUTO-RIG.md). Every other target
you passed that this layer set cannot reach **throws**, naming the field and
the range it could have had: a `farEyeRatio` or `silhouetteRatio`
out of the rig's reach, or a `noseShift` / `mouthShift` outside what that
feature can reach. Pass `options.onTurnSolved` to see what the turn settled on
and which targets were clamped.

`turnTargets.headHalfWidth` is what the shift targets are fractions of, when a
caller has measured the actual head (the face plate stands in otherwise).
Alongside it, `options.headEdges` names, per side, every layer with an opaque
pixel at the eye row and its own rest x there — a companion to a measured
`headHalfWidth`, absent otherwise — so the solver can land each candidate
through its OWN part's deformation (the bangs ride the face, the back hair
stays behind it, a face-plate edge slides) rather than assume the head
is centred on the face plate or that whichever part drew furthest out at rest
is still the furthest out after it turns.

`options.strandEdges` gives, per side, that side's iris and the `hair_front`
run it would slide under on the turn, as real pixel edges on the row holding
the iris's centre (`IrisStrand`: the iris's opaque span, and the run's outer
and face-side ends). One shape covers a strand outward of a clear iris, a run
over the iris centre that clears on the face side, and a fringe spanning the
face, whose `runFace` is `null` because it has no face-side end on that side.
`createLayerSetMeasurer` measures it off the RGBA a host decoded. It is always
validated against the layers, but like `headEdges` it is only read by the turn
solve, so it has no effect on the rig without a `nose`; absent or `{}`, the rig
is exactly the one built without it.

It takes **already-decoded** layer geometry (`LayerInput`), never pixels, which
is what keeps this package free of any image dependency: the editor app decodes
with canvas, `@ikijs/mcp` decodes with `sharp`, and both hand the RGBA they
decoded to `createLayerSetMeasurer` (below) and feed what it measures to the
same pure function — including the optional `rowHalfWidths` (one entry per crop
row, half that row's opaque span in canvas px), measured for the face so the
plate turns on a radius that varies by row; absent, it turns on one constant
radius. It also takes the optional `denseCore`, the tight box of a layer's alpha
≥ 128 pixels in image coords, not grown, measured for the nose: its centre and
width are the nose's turn landmark, so a shaded nose is fitted by its drawing
rather than its soft feather, and its top edge at its centre x is the bridge top
the nose tilts 6° about on the turn, its tip toward the far side; absent, the
crop stands in for both. And it takes the optional `rowRuns` (per crop row, the
row's alpha ≥ 128 runs as a flat list of canvas columns `[start, end, …]`, each
end exclusive), measured for `face`, `hair_front` and `hair_back` so the turn
and the nod can tell where back hair is painted behind the front hair; absent,
the front hair keeps its outline hold and its crown's ease to the back hair on
the turn, and that ease looking down on the nod.

`createLayerSetMeasurer(canvas)` measures all of it — `rowHalfWidths`,
`rowRuns`, `denseCore`, `headHalfWidth`, `headEdges` and `strandEdges` — off
the RGBA a host decoded, one layer at a time: `add` each layer while its pixels
are in memory (it keeps no reference to them), then `finish` for the
`LayerInput`s and the `turnOptions` to pass the generator. A caller's own
`turnTargets` go underneath `turnOptions.turnTargets`: spread the caller's
targets first, then the measured ones.

`*_L` / `*_R` are the **character's** sides — `eye_L` is the character's left
eye, which appears on the viewer's right.

## License

MIT © Zeikar
