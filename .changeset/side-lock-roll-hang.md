---
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

Side locks hang under a roll. A `hair_side_L` / `hair_side_R` lock is now turned back toward plumb about the point where it leaves the bangs, by 45 % of the roll: none on the root the bangs hide, all of it past the root band, the lock below keeping its length and width. Before, its hang developed over a head height below the chin, so a lock ending near the chin or the collar rolled with the head almost rigidly (about 3 px at the tip of one reaching the collar, now about 35). A rigged model with side locks changes at `ParamAngleZ`; one without them rigs byte-identically.
