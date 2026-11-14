---
"@ikijs/format": minor
---

Add `IkiPart.occlusion`: a part can be hidden where named parts cover it, by an amount keyed linearly on a parameter (`{ by, parameter, stops }`, the types `IkiOcclusion` and `IkiOcclusionStop`). The validator refuses an occluder that is the part itself, repeated, undeclared, without a mesh, clipped or itself occluded, a part that is both clipped and occluded, an occlusion on a part that is a clip mask, and a key that is a physics output. The format version stays 1. An engine before 0.11.0 or a validator before 0.11.0 drops the field without a word and draws the part unhidden.
