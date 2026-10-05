#!/usr/bin/env bash
# gen-turn-reference.sh — generate the 30-degree head-turn reference image.
#
# Same shape as gen-images.sh --ref: one `codex exec -i <front>` job
# that draws the SAME character turned, using the already-generated front
# reference as the attachment.
#
# Three whys baked into this script:
#   -i <reference>       the attachment is what reproduces the character; a
#                         text-only prompt has nothing to redraw and drifts.
#   30 degrees, not 45   the angle is the rig's own ParamAngleX limit, so it is
#                         not a tunable parameter here — a 45-degree drawing
#                         over-asks a 30-degree rig by ~1.7x (measured, not
#                         derived: the feature slide a 45° drawing demands
#                         versus a 30° one).
#   no character detail  the prompt names no hairstyle, eye colour or outfit;
#                         the attached front reference already carries
#                         identity, so the prompt only has to describe the turn.
#
# Usage:
#   gen-turn-reference.sh <reference.png> <work_dir>
#
# Output: <work_dir>/reference-30.png. Per-job transcript in
# <work_dir>/.gen-logs/.

set -u -o pipefail

. "$(dirname "$0")/codex.sh"

[ $# -eq 2 ] || die "usage: gen-turn-reference.sh <reference.png> <work_dir>"

ref=$1
work_dir=$2
[ -f "$ref" ] || die "reference image not found: $ref"
ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")

[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

codex_preflight

out="reference-30.png"

echo "[info] reference: $ref"
echo "[info] work_dir:  $work_dir"
echo "[info] output:    $out"
echo "[info] model:     $CODEX_IMAGE_MODEL"
echo

codex_image_exec "$work_dir" "$log_dir/reference-30" "$ref" "$out" \
  "The attached image is the REFERENCE CHARACTER: a front-facing bust portrait.
Use the image generation tool to redraw the EXACT same character, same drawing
style, same line weight, same colours, same framing and crop, same square
canvas, same plain background colour, with ONE change: the head turned
about 30 degrees toward the viewer's left (the character's own right). This is
a modest turn, NOT a three-quarter view and NOT a profile: both eyes still
fully visible, the far (viewer's left) eye only slightly narrower than the
near eye, the nose tip shifted a little toward the near cheek, the far cheek
outline receding a touch, the near ear just starting to peek out under the
hair. The shoulders and torso stay facing the camera exactly as in the
reference; only the head rotates — the neck stays facing the camera with the
torso, as the rig keeps it. Same eye level and head size as the
reference so the two images can be overlaid. Keep every other attribute
exactly as in the attached image: hairstyle and hair colour, eye colour,
expression, clothing and accessories."
rc=$?

if [ $rc -eq 0 ] && [ -s "$work_dir/$out" ]; then
  echo "[ok]   $out  ($(wc -c <"$work_dir/$out" | tr -d ' ') bytes)"
  exit 0
fi
echo "[fail] $out  (rc=$rc) — see $log_dir/reference-30.stdout" >&2
exit 1
