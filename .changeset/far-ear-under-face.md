---
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

The far ear goes partly under the face on a head turn, about half of an ear of the default layout's size (a narrower ear goes further under). An ear the face layer paints used to keep almost all of its width at a full turn: its outer edge moved half the plate's slide and the ear narrowed to 0.8. Its outer edge now holds (`earFar` 0) while the head slides over it, and it narrows to 0.9 of its width by a value of its own (`earFore` 0.1, no longer the eyes' `fore`). A model rigged again from the same layers turns differently at its ears. One more thing moves with it: a `turnTargets.silhouetteRatio` passed for a face drawn without hair and with ears is clamped less than before, since the head now only has to stay on the held ear, not to keep up with a moving one, so such a plate can narrow further.
