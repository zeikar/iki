---
"@ikijs/mcp": minor
---

New `measure_turn_reference` tool: measures how far a head turns between two
images of the same character — one facing front, one turned — and reports it as
three ratios, so a rigged turn can be compared against a reference turn (or an
earlier rig) without registering the images (framing divides out; compare at
like sizes, since the iris close radius and the eye-row band are pixel-fixed). `farEyeRatio` is the
turned far/near iris width over that same ratio at rest, `eyeShift` is how far
the eye pair slides across the head in units of the FRONT head half-width
(negative = toward the image's left), and `silhouetteRatio` is the head
half-width turned over front; the raw per-image numbers come back alongside
them, and `debugDir` writes an overlay per image with the iris boxes and head
edges drawn. The irises are found through a colour window (violet by default,
overridable through `iris`), and the head silhouette through one of two
foreground rules picked per image: alpha alone for an engine render, a
colour-keyed backdrop for opaque reference art.
