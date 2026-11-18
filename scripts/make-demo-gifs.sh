#!/usr/bin/env bash
# 功能: 把平台录屏 (.mov) 切成 README 用的 GIF，顺带抹掉账号邮箱等身份信息。
# 关注点: 遮罩走 scripts/mask-screenshot.py —— 逐帧取「同帧参考区中位色」填充，
#         而不是固定色块。平台 UI 弹窗会给背景加半透明遮罩，同一位置底色随时在变
#         (实测 #0e141c ↔ #1a222e)，固定色块会在变暗帧上露出矩形边界，反而扎眼。
#         用 delogo 也不行 —— 它会把字糊开，那就是我们要消灭的"虚影"。
#        降帧必须在管道第一段做 (fps 滤镜)。后面再写 -r 只是给 rawvideo 标播放帧率，
#        不会真的丢帧 —— 那样会得到 60fps 的巨无霸 GIF (实测 1800 帧 / 6MB)。
#        遮罩坐标按 1918x854 录屏分辨率标定；分辨率不同必须重新量。
#
# 用法:
#   bash scripts/make-demo-gifs.sh <录屏.mov> [输出目录]
# 默认输出到 docs/gifs/，文件名与 README 引用的保持一致。

set -euo pipefail

SRC="${1:?用法: make-demo-gifs.sh <录屏.mov> [输出目录]}"
OUT_DIR_ARG="${2:-docs/gifs/}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$OUT_DIR_ARG" in
  /*) OUT_DIR="$OUT_DIR_ARG" ;;
  *)  OUT_DIR="$REPO_ROOT/$OUT_DIR_ARG" ;;
esac

command -v ffmpeg >/dev/null || { echo "需要 ffmpeg" >&2; exit 1; }

mkdir -p "$OUT_DIR"

SRC_W=1918
SRC_H=854

# 遮罩区 (X0,Y0,X1,Y1) 与取色参考区 (X0,Y0,X1,Y1) 一一配对：
#   顶栏右侧登录邮箱 / 参考 = 邮箱左侧空白底色
#   左下角侧栏登录邮箱 / 参考 = 邮箱右侧空白底色
#   顶栏搜索框内容 /   参考 = 搜索框下沿空白底色
MASKS=(
  "1725,12,1822,30|1710,3,1725,11"
  "48,804,145,822|150,802,171,821"
  "1484,12,1600,30|1610,32,1650,38"
)

# make_gif <输出名> <起始秒> <时长秒> <宽> <帧率> <调色板色数>
make_gif() {
  local name="$1" start="$2" dur="$3" width="$4" fps="$5" colors="$6"
  local height=$(( SRC_H * width / SRC_W ))
  echo "→ $name  (${start}s +${dur}s, ${width}x${height}, ${fps}fps)"

  local mask_args=()
  local pair mask_rect ref_rect
  for pair in "${MASKS[@]}"; do
    mask_rect="${pair%%|*}"
    ref_rect="${pair##*|}"
    mask_args+=(--mask "$mask_rect" --ref "$ref_rect")
  done

  # 三段管道: ①降帧(保持原始分辨率，遮罩坐标才对得上) → ②逐帧遮罩 → ③缩放+调色板两遍法(颜色稳定不闪)
  # 注意: 注释不能插在续行中间，否则管道断开
  ffmpeg -hide_banner -loglevel error -y -ss "$start" -t "$dur" -i "$SRC" \
    -vf "fps=${fps}" -f rawvideo -pix_fmt rgb24 - \
  | python3 "$REPO_ROOT/scripts/mask-screenshot.py" \
      --width "$SRC_W" --height "$SRC_H" "${mask_args[@]}" \
  | ffmpeg -hide_banner -loglevel error -y \
      -f rawvideo -pix_fmt rgb24 -s "${SRC_W}x${SRC_H}" -r "$fps" -i - \
      -vf "scale=${width}:${height}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
      -loop 0 "$OUT_DIR/$name"

  ls -lh "$OUT_DIR/$name"
}

# 定时任务创建 + 资源池 + 用量统计
make_gif "01-schedule-and-usage.gif" 0  30 900 12 192
# 任务详情：preflight 自检 → 实时输出 → 信息面板 → Fork 弹窗
make_gif "02-task-running.gif"      33 37 840 10 160

echo
echo "完成。文件在 $OUT_DIR —— 提交前确认 README 里引用的文件名对得上。"
