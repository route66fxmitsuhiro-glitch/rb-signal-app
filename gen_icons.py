# -*- coding: utf-8 -*-
# PWAアイコン(192x192, 512x512)を生成する。
# ダーク背景+アンバー色のローソク足風グリフ(既存アーティファクトの配色に合わせる)。
from PIL import Image, ImageDraw
import os

BG = (20, 22, 27, 255)       # #14161b
ACCENT = (220, 174, 96, 255)  # #dcae60
POSITIVE = (124, 187, 154, 255)  # #7cbb9a

def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # maskableアイコン用に安全マージン(全体の10%)を確保しつつ角丸の背景
    pad = int(size * 0.06)
    radius = int(size * 0.22)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=BG)

    # ローソク足3本(上昇トレンドを示す配置)
    safe = size * 0.08
    usable_w = size - safe * 2
    n = 3
    gap = usable_w * 0.12
    bar_w = (usable_w - gap * (n - 1)) / n
    base_y = size - safe - size * 0.10
    heights = [0.28, 0.44, 0.62]
    colors = [POSITIVE, ACCENT, ACCENT]
    for i in range(n):
        x0 = safe + i * (bar_w + gap)
        x1 = x0 + bar_w
        h = size * heights[i]
        y0 = base_y - h
        y1 = base_y
        r = bar_w * 0.28
        d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=colors[i])
        # ヒゲ(ローソク足らしさを出す簡易ライン)
        wick_w = max(2, int(bar_w * 0.10))
        cx = (x0 + x1) / 2
        d.line([(cx, y0 - h * 0.18), (cx, y0)], fill=colors[i], width=wick_w)

    return img

os.makedirs("icons", exist_ok=True)
for sz in (192, 512):
    icon = draw_icon(sz)
    icon.save(f"icons/icon-{sz}.png")
    print(f"saved icons/icon-{sz}.png")
