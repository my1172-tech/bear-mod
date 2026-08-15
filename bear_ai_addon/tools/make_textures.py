"""熊の見た目に必要な画像を作る。

作るもの:
  resource_packs/bear_rp/textures/entity/bear.png       128x64 熊の毛皮
  resource_packs/bear_rp/textures/entity/bear_lure.png   16x16 透明(誘導体は見えない)
  behavior_packs/bear_bp/pack_icon.png                   64x64 パックのアイコン
  resource_packs/bear_rp/pack_icon.png                   64x64 同上

UVの位置は models/entity/bear.geo.json の uv と厳密に対応している。
**モデルの uv や size を変えたら、ここの FACES も直すこと。**
tools/check_uv.py が両者のずれを検出する。

使い方:
    python tools/make_textures.py
"""

from __future__ import annotations

import os
import random

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RP = os.path.join(ROOT, "resource_packs", "bear_rp")
BP = os.path.join(ROOT, "behavior_packs", "bear_bp")

TEX_W, TEX_H = 128, 64

# 毛色。ヒグマ(茶熊)。上から順に 明るい毛先 / 地の色 / 影
FUR_LIGHT = (138, 98, 56)
FUR_BASE = (107, 74, 43)
FUR_DARK = (78, 53, 32)
LEG_DARK = (63, 43, 24)
NOSE = (32, 24, 20)
EYE = (24, 18, 14)
EYE_LIGHT = (196, 176, 150)


def box_faces(uv, size):
    """立方体の uv 起点と大きさから、6面の矩形(x, y, w, h)を返す。

    統合版(Java版と同じ)の展開:
        up   = (u+d,     v    ) w×d
        down = (u+d+w,   v    ) w×d
        east = (u,       v+d  ) d×h
        north= (u+d,     v+d  ) w×h   ← 前(=-Z、顔の向き)
        west = (u+d+w,   v+d  ) d×h
        south= (u+d+w+d, v+d  ) w×h
    """
    u, v = uv
    w, h, d = size
    return {
        "up": (u + d, v, w, d),
        "down": (u + d + w, v, w, d),
        "east": (u, v + d, d, h),
        "north": (u + d, v + d, w, h),
        "west": (u + d + w, v + d, d, h),
        "south": (u + d + w + d, v + d, w, h),
    }


# geo の各箱。(名前, uv, size, 基本色)
CUBES = [
    ("skull", (0, 0), (8, 8, 6), FUR_BASE),
    ("snout", (30, 0), (5, 4, 3), FUR_DARK),
    ("ear", (48, 0), (2, 2, 1), FUR_DARK),
    ("body", (0, 20), (12, 12, 20), FUR_BASE),
    ("hump", (64, 0), (10, 3, 8), FUR_LIGHT),
    ("leg_hind", (64, 16), (4, 10, 5), LEG_DARK),
    ("leg_front", (88, 16), (4, 10, 5), LEG_DARK),
]


def shade(rgb, k):
    return tuple(max(0, min(255, int(c * k))) for c in rgb)


def fill_fur(img, rect, base, rng, grain=0.13):
    """毛皮らしいざらつきを付けて矩形を塗る。"""
    x, y, w, h = rect
    px = img.load()
    for j in range(y, y + h):
        # 下へ行くほど暗く（脚や腹に影が落ちる）
        depth = 1.0 - 0.18 * ((j - y) / max(1, h - 1))
        for i in range(x, x + w):
            k = depth * (1.0 + rng.uniform(-grain, grain))
            px[i, j] = shade(base, k) + (255,)


def draw_bear(path):
    rng = random.Random(20260814)  # 毎回同じ絵になるよう種を固定
    img = Image.new("RGBA", (TEX_W, TEX_H), (0, 0, 0, 0))

    for name, uv, size, color in CUBES:
        for face, rect in box_faces(uv, size).items():
            c = color
            if face == "down":
                c = shade(color, 0.72)  # 腹側は影
            elif face == "up":
                c = shade(color, 1.12)  # 背中は日が当たる
            fill_fur(img, rect, c, rng)

    d = ImageDraw.Draw(img)

    # --- 顔 -----------------------------------------------------------------
    fx, fy, fw, fh = box_faces((0, 0), (8, 8, 6))["north"]
    # 目（左右）。1px の黒に 1px の光を入れると生き物らしくなる
    for ex in (fx + 1, fx + 5):
        d.rectangle([ex, fy + 3, ex + 1, fy + 4], fill=EYE + (255,))
        d.point((ex, fy + 3), fill=EYE_LIGHT + (255,))
    # 鼻筋（顔の下半分を少し明るく＝マズル）
    d.rectangle([fx + 2, fy + 5, fx + 5, fy + 7], fill=shade(FUR_DARK, 1.15) + (255,))

    # 鼻先（snout の前面）を黒くする
    sx, sy, sw, sh = box_faces((30, 0), (5, 4, 3))["north"]
    d.rectangle([sx + 1, sy, sx + sw - 2, sy + 2], fill=NOSE + (255,))
    d.point((sx + 2, sy + 2), fill=shade(NOSE, 1.6) + (255,))

    # 耳の中（ear の前面）
    ex, ey, ew, eh = box_faces((48, 0), (2, 2, 1))["north"]
    d.rectangle([ex, ey, ex + ew - 1, ey + eh - 1], fill=shade(FUR_DARK, 0.75) + (255,))

    # --- 胴 -----------------------------------------------------------------
    # 胸元を少し明るくして「月の輪」ではない茶熊らしい濃淡を付ける
    bx, by, bw, bh = box_faces((0, 20), (12, 12, 20))["north"]
    d.rectangle([bx + 3, by + 6, bx + 8, by + 11], fill=shade(FUR_LIGHT, 0.95) + (255,))

    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    return img


def draw_blank(path):
    """誘導体用。完全に透明な 16x16。"""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def draw_icon(path):
    """パックのアイコン。正面から見た熊の顔。"""
    s = 64
    img = Image.new("RGBA", (s, s), (26, 20, 14, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([6, 6, 24, 24], fill=FUR_DARK + (255,))       # 左耳
    d.ellipse([40, 6, 58, 24], fill=FUR_DARK + (255,))      # 右耳
    d.ellipse([10, 12, 54, 56], fill=FUR_BASE + (255,))     # 顔
    d.ellipse([24, 34, 40, 50], fill=shade(FUR_LIGHT, 1.05) + (255,))  # マズル
    d.ellipse([28, 38, 36, 44], fill=NOSE + (255,))         # 鼻
    for ex in (21, 39):
        d.ellipse([ex - 3, 26, ex + 3, 32], fill=EYE + (255,))
        d.point((ex - 1, 27), fill=EYE_LIGHT + (255,))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def main():
    bear = os.path.join(RP, "textures", "entity", "bear.png")
    draw_bear(bear)
    draw_blank(os.path.join(RP, "textures", "entity", "bear_lure.png"))
    draw_icon(os.path.join(RP, "pack_icon.png"))
    draw_icon(os.path.join(BP, "pack_icon.png"))
    print("書き出した:")
    print(" ", bear)
    print(" ", os.path.join(RP, "textures", "entity", "bear_lure.png"))
    print(" ", os.path.join(RP, "pack_icon.png"))
    print(" ", os.path.join(BP, "pack_icon.png"))


if __name__ == "__main__":
    main()
