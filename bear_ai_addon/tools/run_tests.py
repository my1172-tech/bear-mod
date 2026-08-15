"""検査をまとめて走らせる。**実機に入れる前に必ずこれを通す。**

  静的検査(Python)  … 定義の整合・設定値のずれ・状態機械・テクスチャのUV
  机上試験(Node)    … 本物のスクリプトを偽のマイクラで動かし、筋道を確かめる

机上試験は Node が必要（この端末では v24 で確認済み）。Node が無ければ
静的検査だけを走らせて、その旨を出す。

使い方:
    python tools/run_tests.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEST = os.path.join(HERE, "test")

STATIC = ["validate.py", "check_config.py", "check_state.py", "check_uv.py"]
NODE_TESTS = ["test_flow.mjs", "test_runtime.mjs", "test_inverse.mjs"]

results = []


def run(label, args, cwd):
    print(f"\n===== {label} =====")
    r = subprocess.run(args, cwd=cwd, text=True, encoding="utf-8",
                       errors="replace", capture_output=True)
    out = (r.stdout or "") + (r.stderr or "")
    # 熊の独り言(debug ログ)は多いので、判定に関わる行だけ出す
    for line in out.splitlines():
        if line.startswith("[bear"):
            continue
        print(line)
    results.append((label, r.returncode == 0))
    return r.returncode == 0


for tool in STATIC:
    run(tool, [sys.executable, "-X", "utf8", os.path.join("tools", tool)], ROOT)

node = shutil.which("node")
if not node:
    print("\n注意: node が見つからないので机上試験は飛ばした")
    results.append(("机上試験(Node)", False))
else:
    for t in NODE_TESTS:
        run(t, [node, "--import", "./hook.mjs", t], TEST)

print("\n===== まとめ =====")
for label, ok in results:
    print(f"  {'合格' if ok else '失敗'}  {label}")

if all(ok for _l, ok in results):
    print("\nすべて合格。実機に入れてよい。")
    print("  .mcaddon を作る: python tools/pack.py")
    sys.exit(0)

print("\n失敗あり。直してからもう一度。")
sys.exit(1)
