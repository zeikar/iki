---
"@ikijs/engine": patch
---

Textures are now uploaded premultiplied (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`),
and the fragment shader no longer premultiplies a second time. Sampled
straight, LINEAR filtering at an alpha edge blended a texel's rgb with
whatever rgb its transparent neighbour carried — black, or the palette entry a
quantized atlas stored there — so hair strands drew a speckled fringe and a
part whose edge sits on skin (the nose the composer now cuts out of the face)
drew a one-pixel outline of that colour. Premultiplied, a transparent texel
contributes nothing. Rendering is otherwise unchanged; the tint's alpha still
scales the colour.
