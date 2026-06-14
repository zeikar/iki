---
"@iki/format": minor
---

Add clip masks to the `.iki` schema: `IkiPart.clip = { masks: string[] }`. A part is rendered only inside the (union of the) alpha coverage of the referenced mask parts — e.g. an iris clipped to the eye sclera so it never spills past the eye at extreme gaze. The validator enforces reference integrity (each mask id exists, no self-clip, no duplicate refs, mask must carry a `mesh`, masks are flat with no nesting) and now also rejects duplicate part ids so clip references resolve unambiguously. Additive, non-breaking — no `IKI_FORMAT_VERSION` bump (v1 is still pre-release).
