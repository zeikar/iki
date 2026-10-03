---
"@ikijs/editor": minor
---

**Every model rigged from this release with a `hair_front` turns its front hair's crown differently wherever the layer measurer gives the hair layers' runs.** Models rigged earlier are untouched until they are rigged again, the `.iki` format does not change, and a layer set whose hair layers carry no `rowRuns` rigs exactly as before (one with hair runs but none for the face falls back to the face's crop box).

- `createLayerSetMeasurer` now records `rowRuns` for the face as well as the hair layers.
- On the head turn, the front hair's crown rides with the face as far as back hair is painted behind its edges and its gaps, at every angle of the turn and across the nod, with no crown row riding further than the one under it. It never rides where the face lies behind a gap, so no skin is bared. Elsewhere it eases to the back hair's motion as before.
- The cap's outline turns with the face only where the back hair reaches past the front hair's edge by the cap's motion relative to it — about 0.16 hh, more on the crown's rows. A front hair drawn about face-wide over a back hair of the hairstyle's natural size leaves that room; a front hair as wide as the whole hairstyle holds its outline still.
