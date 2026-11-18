#!/usr/bin/env python3
"""
mask-screenshot.py — 抹掉截图/录屏里的登录邮箱等身份信息。

功能: 从 ffmpeg 原始帧流里，逐帧把指定矩形区域填成「同帧参考区的中位色」。
      为什么要同帧取色而不是固定色: 平台 UI 有弹窗时会给背景加半透明遮罩，
      同一位置在不同时刻底色会变（实测 #0e141c ↔ #1a222e）。固定色块在变暗的
      帧上会露出矩形边界，反而更扎眼。同帧取色填块 = 像素级无缝。

用法:
  ffmpeg -i in.mov -f rawvideo -pix_fmt rgb24 - | \
    python3 scripts/mask-screenshot.py --width 1918 --height 854 \
      --mask "1725,13,1822,29" --mask "48,805,145,821" \
      --ref "1710,3,1725,12" --ref "150,802,171,822" \
    | ffmpeg -f rawvideo -pix_fmt rgb24 -s 1918x854 -i - ... out.gif

参数:
  --mask X0,Y0,X1,Y1   要覆盖的矩形 (闭区间)。可重复多次。
  --ref  X0,Y0,X1,Y1   取色参考矩形 (该区域必须是无文字的纯背景)。
                       --mask 与 --ref 按出现顺序一一配对。
  --width/--height     帧尺寸。

关注点: 纯 Python 逐像素处理，1918x854 单帧约 4.9MB；长录屏建议分段跑。
        参考区若被 UI 元素（按钮/图标）压住，中位色会被带偏 —— 挑空白处取。
"""

import sys
import argparse


def parse_rect(s):
    parts = [int(v) for v in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"矩形格式应为 X0,Y0,X1,Y1，收到 {s!r}")
    x0, y0, x1, y1 = parts
    if x1 < x0 or y1 < y0:
        raise argparse.ArgumentTypeError(f"矩形坐标顺序错: {s!r}")
    return x0, y0, x1, y1


def median_color(buf, width, rect):
    """取矩形内每通道的中位数 —— 对少量异常像素（抗锯齿边缘）鲁棒。"""
    x0, y0, x1, y1 = rect
    chans = ([], [], [])
    for y in range(y0, y1 + 1):
        base = y * width * 3
        for x in range(x0, x1 + 1):
            i = base + x * 3
            chans[0].append(buf[i])
            chans[1].append(buf[i + 1])
            chans[2].append(buf[i + 2])
    return tuple(sorted(c)[len(c) // 2] for c in chans)


def apply_mask(buf, width, mask_rect, color):
    x0, y0, x1, y1 = mask_rect
    r, g, b = color
    for y in range(y0, y1 + 1):
        base = y * width * 3
        for x in range(x0, x1 + 1):
            i = base + x * 3
            buf[i] = r
            buf[i + 1] = g
            buf[i + 2] = b


def main():
    ap = argparse.ArgumentParser(description="逐帧同色遮罩")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--mask", action="append", default=[], help="X0,Y0,X1,Y1（可重复）")
    ap.add_argument("--ref", action="append", default=[], help="X0,Y0,X1,Y1（可重复，与 mask 一一对应）")
    args = ap.parse_args()

    masks = [parse_rect(m) for m in args.mask]
    refs = [parse_rect(r) for r in args.ref]
    if len(masks) != len(refs):
        sys.exit(f"--mask 给 {len(masks)} 个，--ref 给 {len(refs)} 个，数量必须一致")

    frame_size = args.width * args.height * 3
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    frames = 0
    while True:
        buf = bytearray(stdin.read(frame_size))
        if len(buf) < frame_size:
            break
        for mrect, rrect in zip(masks, refs):
            color = median_color(buf, args.width, rrect)
            apply_mask(buf, args.width, mrect, color)
        stdout.write(buf)
        frames += 1
    stdout.flush()
    sys.stderr.write(f"mask-screenshot: 处理 {frames} 帧\n")


if __name__ == "__main__":
    main()
