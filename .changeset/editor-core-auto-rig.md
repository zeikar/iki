---
"@iki/editor-core": minor
---

Add the auto-rig layer-set generator: `generateIkiFromLayerSet` turns a labelled set of canvas-sized layer descriptors (role + alpha bbox + crop dims) into a valid, standard-rigged `.iki` model — parts placed at their source positions with a head-turn warp, neck pivot, and per-role blink/gaze/mouth/breath bindings. Also exports the `parseLayerRoles` filename→role helper and the `LayerInput` type. The editor app consumes these to import a named PNG layer set into a rigged model (roadmap #6 first slice).
