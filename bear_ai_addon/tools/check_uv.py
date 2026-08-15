"""モデルの箱とテクスチャの塗り分けが合っているかを見る。

make_textures.py は「この箱のこの面はここ」という前提で塗っている。
モデル(bear.geo.json)の uv や size を変えると、その前提が黙って崩れて
**目や鼻が体のどこかに現れる**（実機で見るまで気づけない）。

見るもの:
  1. geo の箱が、make_textures.py の CUBES と同じ uv / size か
  2. 展開した6面がテクスチャの中に収まっているか
  3. 別の箱の面と重なっていないか
  4. 実際に書き出された bear.png の大きさが geo の宣言と合っているか

使い方:
    python tools/check_uv.py
"""

from __future__ import annotations

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from make_textures import CUBES, TEX_H, TEX_W, box_faces  # noqa: E402

GEO = os.path.join(ROOT, "resource_packs", "bear_rp", "models", "entity", "bear.geo.json")
PNG = os.path.join(ROOT, "resource_packs", "bear_rp", "textures", "entity", "bear.png")

errors = []


def err(msg):
    errors.append(msg)


geo = json.load(io.open(GEO, encoding="utf-8"))
model = None
for g in geo["minecraft:geometry"]:
    if g["description"]["identifier"] == "geometry.bear":
        model = g
if model is None:
    print("  誤り  geometry.bear が無い")
    sys.exit(1)

desc = model["description"]
if (desc["texture_width"], desc["texture_height"]) != (TEX_W, TEX_H):
    err(f"テクスチャの大きさが違う: geo={desc['texture_width']}x{desc['texture_height']} / "
        f"make_textures={TEX_W}x{TEX_H}")

# --- geo の箱を集める --------------------------------------------------------

geo_cubes = []
for bone in model["bones"]:
    for cube in bone.get("cubes", []):
        geo_cubes.append((bone["name"], tuple(cube["uv"]), tuple(cube["size"])))

# make_textures 側の箱（耳と脚は同じ絵を2つで使い回すので、集合で見る）
tex_cubes = {(tuple(uv), tuple(size)) for _n, uv, size, _c in CUBES}
geo_set = {(uv, size) for _n, uv, size in geo_cubes}

for uv, size in sorted(geo_set - tex_cubes):
    err(f"geo にある箱が make_textures.py に無い: uv={list(uv)} size={list(size)}")
for uv, size in sorted(tex_cubes - geo_set):
    err(f"make_textures.py にある箱が geo に無い: uv={list(uv)} size={list(size)}")

# --- 展開した面がテクスチャに収まり、重なっていないか -------------------------

owner = {}
for name, uv, size in geo_cubes:
    for face, (x, y, w, h) in box_faces(uv, size).items():
        if x < 0 or y < 0 or x + w > TEX_W or y + h > TEX_H:
            err(f"{name} の {face} 面がテクスチャの外に出ている: "
                f"({x},{y})+{w}x{h} / {TEX_W}x{TEX_H}")
            continue
        for px in range(int(x), int(x + w)):
            for py in range(int(y), int(y + h)):
                k = (px, py)
                prev = owner.get(k)
                if prev and prev[0] != name:
                    # 耳や脚のように「同じ絵を使い回す」箱どうしは重なってよい
                    if (uv, size) != prev[1]:
                        err(f"テクスチャが重なっている: {name} と {prev[0]} が ({px},{py})")
                        owner[k] = (name, (uv, size))
                        break
                else:
                    owner[k] = (name, (uv, size))

# --- 書き出された画像 --------------------------------------------------------

if not os.path.isfile(PNG):
    err("bear.png が無い → python tools/make_textures.py で作る")
else:
    try:
        from PIL import Image

        with Image.open(PNG) as im:
            if im.size != (TEX_W, TEX_H):
                err(f"bear.png の大きさが違う: {im.size} / 期待 {(TEX_W, TEX_H)}")
    except ImportError:
        print("  注意  PIL が無いので画像の大きさは確かめていない")

# --- 結果 -------------------------------------------------------------------

used = len(owner)
print(f"箱 {len(geo_cubes)} 個 / 塗った面積 {used} / {TEX_W * TEX_H} 画素")
seen = set()
for e in errors:
    if e in seen:
        continue
    seen.add(e)
    print(f"  誤り  {e}")
if errors:
    print(f"\n失敗: 誤り {len(seen)} 件")
    sys.exit(1)
print("\n合格")
