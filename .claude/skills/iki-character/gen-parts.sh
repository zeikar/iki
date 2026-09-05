#!/usr/bin/env bash
# gen-parts.sh — generate Iki part PNGs with a REFERENCE IMAGE attached.
#
# Same shape as the global codex-image batch script, plus `codex exec -i <ref>`
# so every part is drawn while the model is looking at one reference character.
# That shared anchor is the point: parts generated independently drift in hue,
# line weight and rendering style (one run came back with a photoreal iris on a
# flat cel-shaded face), and no amount of prompt wording fixes drift that has no
# common target.
#
# Usage:
#   gen-parts.sh <reference.png> <work_dir> "<prompt>::<out.png>" [more...]
#
# Outputs land in <work_dir>/; per-job transcripts in <work_dir>/.gen-logs/.
#
# NOTE: `-i` puts the reference in front of the model, which then writes the
# image_generation prompt. Whether that carries pixel-level style through to the
# generated part is UNVERIFIED (codex quota ran out before it could be tested).
# If parts come back ignoring the reference, fall back to the text style-bible
# in SKILL.md and treat `-i` as a bonus rather than the mechanism.

set -u -o pipefail

readonly MAX_PARALLEL=5

die() { echo "[error] $*" >&2; exit 1; }

[ $# -ge 3 ] || die "usage: gen-parts.sh <reference.png> <work_dir> \"<prompt>::<out.png>\" [more...]"

ref=$1; shift
[ -f "$ref" ] || die "reference image not found: $ref"
ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")

work_dir=$1; shift
[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

command -v codex >/dev/null 2>&1 || die "codex CLI not found in PATH"
codex login status >/dev/null 2>&1 || die "codex not logged in — run: codex login"

prompts=() outputs=()
for item in "$@"; do
  case "$item" in *"::"*) ;; *) die "item missing '::' separator: $item" ;; esac
  prompt=${item%%::*}
  output=${item#*::}
  [ -n "$prompt" ] && [ -n "$output" ] || die "empty prompt or output: $item"
  for seen in ${outputs[@]+"${outputs[@]}"}; do
    [ "$seen" = "$output" ] && die "duplicate output filename: $output"
  done
  prompts+=("$prompt")
  outputs+=("$output")
done

total=${#prompts[@]}
echo "[info] reference:   $ref"
echo "[info] work_dir:    $work_dir"
echo "[info] total jobs:  $total"
echo

run_one() {
  local idx=$1 prompt=$2 output=$3
  local tag; tag=$(printf '%03d' "$idx")

  codex exec \
    --sandbox workspace-write \
    --skip-git-repo-check \
    --cd "$work_dir" \
    -i "$ref" \
    -o "$log_dir/$tag.md" \
    "The attached image is the REFERENCE CHARACTER. Study its hair colour and strand
shapes, eye shape and iris colour, line weight, shading style and palette.

Use the image generation tool to draw: '$prompt'

It must read as the SAME character and the SAME drawing style as the reference —
match the colours and line weight exactly. Save it to ./$output.
Reply with only the file path on one line." \
    >"$log_dir/$tag.stdout" 2>&1
  local rc=$?

  if [ $rc -eq 0 ] && [ -s "$work_dir/$output" ]; then
    echo "  [ok]   #$idx  $output  ($(wc -c <"$work_dir/$output" | tr -d ' ') bytes)"
    return 0
  fi
  echo "  [fail] #$idx  $output  (rc=$rc) — see $log_dir/$tag.stdout"
  return 1
}

overall_start=$(date +%s)
batch_no=1
i=0
while [ $i -lt $total ]; do
  end=$(( i + MAX_PARALLEL ))
  [ $end -gt $total ] && end=$total

  echo "=== batch $batch_no — jobs $(( i + 1 ))..$end ==="
  pids=()
  for (( j = i; j < end; j++ )); do
    run_one "$(( j + 1 ))" "${prompts[$j]}" "${outputs[$j]}" &
    pids+=($!)
  done

  failed=0
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=$(( failed + 1 ))
  done
  echo "    failed $failed"
  echo

  i=$end
  batch_no=$(( batch_no + 1 ))
done

echo "[done] total $(( $(date +%s) - overall_start ))s"
echo "[done] outputs: $work_dir"
