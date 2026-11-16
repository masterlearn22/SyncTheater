#!/usr/bin/env bash
# ==============================================================================
# SyncTheater - Skrip Remux Cepat MKV (AC3/EAC3/DTS) ke MP4 (AAC Stereo 192kbps)
# Menyalin stream video 100% utuh (-c:v copy) tanpa re-encode agar selesai dalam
# hitungan detik dan menjamin audio terdengar di semua browser.
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Penggunaan: ./prep-movie.sh <input_video.mkv> [output_video.mp4]"
    exit 1
fi

INPUT_FILE="$1"
if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: File '$INPUT_FILE' tidak ditemukan."
    exit 1
fi

if [ "$#" -ge 2 ]; then
    OUTPUT_FILE="$2"
else
    BASENAME="${INPUT_FILE%.*}"
    OUTPUT_FILE="${BASENAME}_siap_nobar.mp4"
fi

echo "[SyncTheater] Memulai remux video tanpa penurunan kualitas..."
echo "  Input  : $INPUT_FILE"
echo "  Output : $OUTPUT_FILE"

ffmpeg -y -i "$INPUT_FILE" \
    -map 0:v:0 -map 0:a:0 \
    -c:v copy \
    -c:a aac -b:a 192k -ac 2 \
    -movflags +faststart \
    "$OUTPUT_FILE"

echo "[SyncTheater] Selesai! File siap diputar di folder --media-dir: $OUTPUT_FILE"
