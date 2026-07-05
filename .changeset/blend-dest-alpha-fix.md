---
"@iki/engine": patch
---

Fix semi-transparent parts rendering darker than specified. The renderer now
uses a consistent premultiplied-alpha pipeline (shader premultiplies rgb by
alpha, `ONE / ONE_MINUS_SRC_ALPHA` blending, `premultipliedAlpha: true`
context). Previously, SRC_ALPHA blending into a straight-alpha canvas eroded
the framebuffer alpha and composited the page background through
semi-transparent parts.
