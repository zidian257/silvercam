#!/bin/bash
# 从视频抽降采样帧供 agent 看画面：frame.sh <video> <out_dir> <t1> [t2 ...]
# 每个时间点产一张 960 宽 jpeg：<out_dir>/f_<t>s.jpg（t 支持小数/时分秒以外只认秒）
set -euo pipefail

video="${1:?用法: frame.sh <video> <out_dir> <t1> [t2 ...]}"
out_dir="${2:?缺 out_dir}"
shift 2
[ $# -ge 1 ] || { echo "至少一个时间点（秒）" >&2; exit 2; }

mkdir -p "$out_dir"
for t in "$@"; do
  out="$out_dir/f_$(echo "$t" | tr '.' '_')s.jpg"
  ffmpeg -hide_banner -loglevel error -y -ss "$t" -i "$video" -frames:v 1 -vf scale=960:-2 -q:v 3 "$out"
  echo "$out"
done
