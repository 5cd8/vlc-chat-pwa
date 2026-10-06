#!/bin/sh
# 4.4節のテスト動画（合成MKV）を作る。要 ffmpeg（libx264, libopus）。出力先は作業用ディレクトリ（コミットしない）。
# 使い方: sh gen-fixtures.sh /path/to/ffmpeg /path/to/outdir
F=${1:-ffmpeg}; OUT=${2:-.}
gen() { name=$1; br=$2; gop=$3; dur=$4
  "$F" -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30,noise=alls=40:allf=t" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" -t "$dur" -c:v libx264 -preset ultrafast \
    -b:v "$br" -minrate "$br" -maxrate "$br" -bufsize "$br" \
    -x264-params "nal-hrd=cbr:keyint=$gop:min-keyint=$gop:scenecut=0" -c:a libopus -b:a 128k "$OUT/$name.mkv"; }
gen b8_g5 8M 150 60        # 8Mbps, GOP 5秒
gen b8_g30 8M 900 120      # 8Mbps, GOP 30秒
gen b20_g10 20M 300 60     # 20Mbps, GOP 10秒
gen b20_g30 20M 900 120    # 20Mbps, GOP 30秒
gen b20_g60 20M 1800 180   # 20Mbps, GOP 60秒
# メタデータ増加の測定用（低ビットレート・長尺）
"$F" -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=60" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 900 -c:v libx264 -preset ultrafast -b:v 300k -x264-params "keyint=120:min-keyint=120:scenecut=0" -c:a libopus -b:a 32k "$OUT/low_900s.mkv"
