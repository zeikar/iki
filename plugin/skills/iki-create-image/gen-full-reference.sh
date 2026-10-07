#!/usr/bin/env bash
# gen-full-reference.sh — generate the full-body reference image.
#
# Same shape as gen-turn-reference.sh: one `codex exec -i <front>` job that
# draws the SAME character, using the already-generated front reference (the
# bust) as the attachment.
#
# Four whys baked into this script:
#   -i <reference>       the bust is the master: the face and hair parts and
#                         the turn reference are drawn from it, so the full
#                         body must carry the same character over, and a
#                         text-only prompt has nothing to carry it from.
#   a 1:3 portrait       the body and arm parts are drawn against this image
#                         and placed by its proportions, so the whole figure
#                         has to fit head to toe with margin; the image tool
#                         returns ~1.57 Mpx at the aspect the prompt asks for.
#   not the turn prompt  that one asks for the same framing on the same square
#                         canvas, and gets a bust back; this one asks for a new
#                         framing and keeps only the character, its style and
#                         the background colour. Like it, the prompt names no
#                         hairstyle or eye colour: the attached bust carries
#                         them.
#   an outfit sentence   the bust shows no lower body, and unnamed the model
#                         invents it (a tee-only bust came back with a yellow
#                         skirt and loafers), so the optional third argument
#                         names what the frame cuts off. And "hair at its full
#                         length" turned a ponytail into hip-length hair, so
#                         the hair is kept as drawn.
#
# Usage:
#   gen-full-reference.sh <reference.png> <work_dir> [outfit]
#   outfit: one sentence naming the bottoms, socks and shoes the bust cannot
#   show. Without it the prompt only says to continue the outfit.
#
# Output: <work_dir>/reference-full.png. Per-job transcript in
# <work_dir>/.gen-logs/.

set -u -o pipefail

. "$(dirname "$0")/codex.sh"

{ [ $# -eq 2 ] || [ $# -eq 3 ]; } || die "usage: gen-full-reference.sh <reference.png> <work_dir> [outfit]"

ref=$1
work_dir=$2
outfit=${3:-}
[ -f "$ref" ] || die "reference image not found: $ref"
ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")

[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

codex_preflight

out="reference-full.png"

echo "[info] reference: $ref"
echo "[info] work_dir:  $work_dir"
echo "[info] output:    $out"
echo "[info] model:     $CODEX_IMAGE_MODEL"
echo "[info] outfit:    ${outfit:-(not given)}"
echo

if [ -n "$outfit" ]; then
  outfit_line="$outfit"
else
  outfit_line="Continue the outfit down to the shoes in the same palette."
fi

codex_image_exec "$work_dir" "$log_dir/reference-full" "$ref" "$out" \
  "The attached image is the REFERENCE CHARACTER: a front-facing bust portrait.
Use the image generation tool to draw the EXACT same character, same outfit,
same colours, same line weight and same drawing style, now FULL BODY, head to
toe. $outfit_line Keep the hair exactly as drawn: tied hair (a ponytail, a bun,
a braid) keeps its length and place, and only loose hair the bust's frame cuts
off continues down. The whole figure front-facing and level, the head
looking straight at the viewer, the shoulders squared. Arms hanging relaxed at
the sides in a slight A-pose, each arm angled a little away from the body so
there is a clear gap between the arm and the torso all the way down, hands open
and relaxed. Legs straight, with a clear gap between them from the crotch down,
both feet flat on the ground. The whole figure inside the image, from the top
of the hair to the soles of the shoes, with margin on every side. The same
plain background colour as the reference. A portrait image three times as tall
as it is wide. Keep every other attribute exactly as in the attached image:
hairstyle and hair colour, eye colour, expression, clothing and accessories."
rc=$?

if [ $rc -eq 0 ] && [ -s "$work_dir/$out" ]; then
  echo "[ok]   $out  ($(wc -c <"$work_dir/$out" | tr -d ' ') bytes)"
  exit 0
fi
echo "[fail] $out  (rc=$rc) — see $log_dir/reference-full.stdout" >&2
exit 1
