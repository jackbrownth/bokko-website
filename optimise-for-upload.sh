#!/usr/bin/env bash
# BOKKO — prepare clips for upload.
#
# Converts every video in a folder to web-ready H.264 MP4 and puts the
# results in a "web-ready" subfolder. Upload those, not the originals.
#
#   chmod +x optimise-for-upload.sh          (once)
#   ./optimise-for-upload.sh ~/Desktop/BanyanTreeShoot
#
# Needs ffmpeg:  brew install ffmpeg   (macOS)
#                winget install Gyan.FFmpeg   (Windows, use Git Bash)

set -euo pipefail

SRC="${1:-.}"
OUT="$SRC/web-ready"
mkdir -p "$OUT"

shopt -s nullglob nocaseglob
FILES=("$SRC"/*.{mp4,mov,m4v,avi,mkv,webm})
shopt -u nocaseglob

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No video files found in $SRC"
  exit 1
fi

echo "${#FILES[@]} file(s) to convert → $OUT"
echo

for f in "${FILES[@]}"; do
  name="$(basename "${f%.*}")"
  dest="$OUT/$name.mp4"
  [ -f "$dest" ] && { echo "skip  $name (already done)"; continue; }

  # Portrait clips get a 1080 width, landscape gets a 1080 height.
  H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f")
  W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$f")
  if [ "$H" -ge "$W" ]; then SCALE="scale=1080:-2"; else SCALE="scale=-2:1080"; fi

  echo -n "conv  $name … "
  ffmpeg -y -loglevel error -i "$f" \
    -vf "$SCALE,fps=30" \
    -c:v libx264 -preset veryfast -crf 23 \
    -pix_fmt yuv420p -profile:v high \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    "$dest"

  before=$(du -m "$f"    | cut -f1)
  after=$(du -m "$dest" | cut -f1)
  echo "${before}MB → ${after}MB"
done

echo
echo "Done. Upload the files in: $OUT"
