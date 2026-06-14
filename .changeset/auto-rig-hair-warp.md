---
"@iki/editor-core": minor
---

Auto-rig: front hair (`hair_front`) now rides the face warp (as a mesh part) so it follows the head-turn curvature together with the face, instead of staying a rigid blob that detaches on turn. Its bbox joins the faceWarp grid union so the grid covers it. `hair_back` stays rigid (per-layer depth parallax is a later slice).
