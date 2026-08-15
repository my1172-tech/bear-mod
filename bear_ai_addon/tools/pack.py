"""配布用の .mcaddon を作る。

.mcaddon は「BPとRPを両方入れたzip」を拡張子だけ変えたもの。
これをダブルクリックすれば、統合版が両方まとめて取り込む
（BPだけ渡すと見た目が出ない）。

入れないもの: tools/ 一式・机上試験・__pycache__・.mcaddon 自身。

**ファイル名に版が入る**（熊AI_v0.2.0.mcaddon）。同じ名前で作り続けると、
手元にあるのが直したあとの物か前の物か分からなくなるため。
**古い .mcaddon は消す**（dist に残るのは常に1つだけ）。二つ並んでいると
古いほうを取り込んでしまう。

使い方:
    python tools/pack.py
    python tools/pack.py --name 熊AI_試作     # 版は自動で付く
    python tools/pack.py --keep-old           # 古いものを消さない
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist")

INCLUDE = [
    ("behavior_packs/bear_bp", "behavior_packs/bear_bp"),
    ("resource_packs/bear_rp", "resource_packs/bear_rp"),
]

SKIP_DIRS = {"__pycache__", "node_modules", ".git"}
SKIP_EXT = {".pyc", ".mcaddon", ".zip"}


def pack_version():
    """ビヘイビアパックの版を "0.2.0" の形で返す。"""
    path = os.path.join(ROOT, "behavior_packs", "bear_bp", "manifest.json")
    head = json.load(io.open(path, encoding="utf-8"))["header"]["version"]
    return ".".join(str(v) for v in head)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="熊AI", help="出力ファイル名（版は自動で付く）")
    ap.add_argument("--keep-old", action="store_true", help="古い .mcaddon を消さない")
    args = ap.parse_args()

    # 定義が壊れたまま配ると、実機で無言で動かない。必ず先に検査を通す。
    sys.path.insert(0, HERE)
    import subprocess

    for tool in ("validate.py", "check_config.py", "check_state.py"):
        r = subprocess.run([sys.executable, "-X", "utf8", os.path.join("tools", tool)],
                           cwd=ROOT, text=True, encoding="utf-8", errors="replace",
                           capture_output=True)
        if r.returncode != 0:
            print(f"検査 {tool} が通らないので梱包を中止する:\n{r.stdout}{r.stderr}")
            return 1

    os.makedirs(DIST, exist_ok=True)
    version = pack_version()
    out = os.path.join(DIST, f"{args.name}_v{version}.mcaddon")

    # **古いものは消す。** dist に二つ並んでいると、どちらが最新か分からないまま
    # 古いほうをダブルクリックしてしまう（直したはずが直っていない、の元）。
    removed = []
    if not args.keep_old:
        for name in sorted(os.listdir(DIST)):
            if not name.endswith(".mcaddon"):
                continue
            full = os.path.join(DIST, name)
            if os.path.abspath(full) == os.path.abspath(out):
                continue
            try:
                os.remove(full)
                removed.append(name)
            except OSError as e:
                print(f"  古い物を消せなかった: {name} ({e})")

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, dst in INCLUDE:
            base = os.path.join(ROOT, src.replace("/", os.sep))
            if not os.path.isdir(base):
                print(f"入れるものが無い: {src}")
                return 1
            for dirpath, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for name in files:
                    if os.path.splitext(name)[1] in SKIP_EXT:
                        continue
                    full = os.path.join(dirpath, name)
                    inner = os.path.relpath(full, base).replace("\\", "/")
                    z.write(full, f"{dst}/{inner}")
                    count += 1

    size = os.path.getsize(out) / 1024
    print(f"作った: {out}")
    print(f"  版 {version} / ファイル {count} 個 / {size:.1f} KB")
    for name in removed:
        print(f"  古い物を消した: {name}")
    print("  ダブルクリックで統合版に取り込める（BPとRPの両方が入る）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
