---
"@ikijs/editor": minor
---

**Every model rigged from this release with a `hair_front` moves its front hair differently.** Its cap's top now rises with the face looking up. Where the layer measurer gives the hair layers' opaque runs, its outer edge also rides with the face on the turn, and its top slides with the face on the nod, as far as back hair is painted behind them. Models rigged earlier are untouched until they are rigged again, and the `.iki` format does not change.

- `createLayerSetMeasurer` records `LayerInput.rowRuns` for `hair_front` and `hair_back`: each crop row's opaque runs (alpha ≥ 128) as canvas columns. It is a new optional field, validated like `rowHalfWidths`. A layer set without it keeps today's turn and down-nod; only the up-nod change applies.
- **Turn.** On each row, the front hair's outer edge rides with the face only as far as the back hair's connected run behind that edge reaches, at every angle of the turn, up to the front hair's own follow there (over the far eye, as far as that eye's corner goes). A row nothing covers keeps the hold the profile's `outlineFollow` gives.
- **Nod.** The cap's top slides with the face as one value for the whole cap: up to 0.174 hh looking down (the Live2D samples' median, 1.215× the plate's mid-height nod) and 0.035 hh looking up. The down value is capped so that no crown column bares more than 0.01 hh of rows the back hair leaves empty, beyond what the back hair's own 0.025 nod already bares. A back hair that falls short of the cap's top near the crown, such as at a parting dip, holds the slide near 0.025; one drawn up past the front hair's top earns the full slide.
