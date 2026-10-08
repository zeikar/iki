#!/usr/bin/env bash
# gen-wave-reference.sh — generate the waving full-body reference image.
#
# Same shape as gen-full-reference.sh: one `codex exec -i <full-body>` job that
# draws the SAME figure, using the already-generated full-body reference as the
# attachment, with the character's right hand raised in a wave.
#
# Two whys baked into this script:
#   -i <full-body>       the figure, outfit and framing carry over from the
#                         full-body reference, so the only change is the arm:
#                         what the pose forearm is drawn against and what the
#                         critic judges it by must be the same character.
#   a raised forearm     the pose forearm (forearm_pose.png) is drawn against
#                         this image, where arm.png's reference shows a
#                         hanging arm the model tends to redraw hanging, and
#                         reference-full.png shows no raised forearm at all:
#                         the sleeve's cuff, the skin, the line and the
#                         hand's pose at the figure's proportions all come
#                         from here.
#
# Usage:
#   gen-wave-reference.sh <reference-full.png> <work_dir>
#
# Output: <work_dir>/reference-wave.png. Per-job transcript in
# <work_dir>/.gen-logs/.

set -u -o pipefail

. "$(dirname "$0")/codex.sh"

[ $# -eq 2 ] || die "usage: gen-wave-reference.sh <reference-full.png> <work_dir>"

ref=$1
work_dir=$2
[ -f "$ref" ] || die "reference image not found: $ref"
ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")

[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

codex_preflight

out="reference-wave.png"

echo "[info] reference: $ref"
echo "[info] work_dir:  $work_dir"
echo "[info] output:    $out"
echo "[info] model:     $CODEX_IMAGE_MODEL"
echo

codex_image_exec "$work_dir" "$log_dir/reference-wave" "$ref" "$out" \
  "The attached image is the REFERENCE CHARACTER: a front-facing full-body
figure. Use the image generation tool to draw the EXACT same figure, same
framing, same outfit, same colours, same line weight and same drawing style,
with the character's RIGHT hand (on the viewer's LEFT) raised in a friendly
wave: the upper arm beside the torso as in the attached image, the forearm
folded up from the elbow to vertical, the open hand at about chin height, palm
toward the viewer, fingers together and relaxed, the thumb toward the body.
Everything else identical to the attached image: the other arm hanging as
drawn, the legs, the head looking straight at the viewer, the plain
background. A portrait image three times as tall as it is wide."
rc=$?

if [ $rc -eq 0 ] && [ -s "$work_dir/$out" ]; then
  echo "[ok]   $out  ($(wc -c <"$work_dir/$out" | tr -d ' ') bytes)"
  exit 0
fi
echo "[fail] $out  (rc=$rc) — see $log_dir/reference-wave.stdout" >&2
exit 1
