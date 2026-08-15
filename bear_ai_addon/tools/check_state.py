"""状態機械の整合を見る。

指示書の状態と優先順位を、コードが本当にその形で持っているかを確かめる。
状態名の打ち間違いは実機では**何も言わずに素通り**し、
その状態の熊が永久に固まる形で出る（気づくのが遅れる）。

使い方:
    python tools/check_state.py
"""

from __future__ import annotations

import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPTS = os.path.join(ROOT, "behavior_packs", "bear_bp", "scripts")

errors = []


def err(msg):
    errors.append(msg)


src = io.open(os.path.join(SCRIPTS, "bear.js"), encoding="utf-8").read()

# 指示書の状態
REQUIRED = [
    "IDLE", "PATROL", "SEARCH_HOUSE", "ENTER_HOUSE", "SEARCH_CHEST", "LOOT",
    "ATTACK", "ESCAPE", "RETURN",
]

# --- 1. STATES と STATE_LABEL -----------------------------------------------

m = re.search(r"export const STATES = \[(.*?)\];", src, re.S)
states = re.findall(r'"(\w+)"', m.group(1)) if m else []
if sorted(states) != sorted(REQUIRED):
    err(f"STATES が指示書と違う: {states}")

m = re.search(r"export const STATE_LABEL = \{(.*?)\};", src, re.S)
labels = re.findall(r"(\w+):", m.group(1)) if m else []
missing = [s for s in states if s not in labels]
if missing:
    err(f"STATE_LABEL に表示名が無い状態がある: {missing}（画面に英語のまま出る）")

# --- 2. go() が使う状態名 ----------------------------------------------------

used = set(re.findall(r'go\(bear, rec, "(\w+)"', src))
if not used:
    err("go() の呼び出しが読み取れなかった（検査が空回りしている）")
for s in sorted(used):
    if s not in states:
        err(f'go() が STATES に無い状態へ移ろうとしている: "{s}"')

# 逆に、どこからも遷移してこない状態が無いか（IDLEは初期状態なので除く）
for s in states:
    if s == "IDLE":
        continue
    if s not in used:
        err(f"状態 {s} へ移る道が無い（コードから到達できない）")

# --- 3. 各状態に処理があるか -------------------------------------------------

cases = set(re.findall(r'case "(\w+)":', src))
# ATTACK と ESCAPE は switch の前で割り込み処理をするので case が無くてよい
for s in states:
    if s in ("ATTACK", "ESCAPE"):
        continue
    if s not in cases:
        err(f"switch に case \"{s}\" が無い（その状態になった熊が固まる）")

# --- 4. 優先順位 ------------------------------------------------------------
# 指示書: ESCAPE > ATTACK > LOOT > ENTER_HOUSE > SEARCH_HOUSE > PATROL
# 逃走と攻撃は switch の前で割り込む。その順番が逆だと、撃たれても
# プレイヤーに向かい続ける（＝逃走が成立しない）。

update = src[src.index("export function update("):]
update = update[: update.index("\n// ---")] if "\n// ---" in update else update

pos_flee = update.find("rec.fleeUntil > now")
pos_prey = update.find("findPrey(bear, rec)")
pos_switch = update.find("switch (rec.state)")

if pos_flee < 0 or pos_prey < 0 or pos_switch < 0:
    err("update() の中の 逃走判定 / 攻撃判定 / switch が見つからない")
else:
    if not (pos_flee < pos_prey < pos_switch):
        err("優先順位が指示書と違う。update() の中は "
            "逃走判定 → 攻撃判定 → 各状態の処理 の順でなければならない")

# --- 5. モードの切り替え -----------------------------------------------------

modes = set(re.findall(r'setMode\(bear, rec, "(\w+)"\)', src))
for m2 in ("roam", "hunt", "flee", "still"):
    if m2 not in modes:
        err(f"setMode(\"{m2}\") がどこからも呼ばれていない")

# 逃走中は必ず flee、攻撃中は必ず hunt になっていること
if 'setMode(bear, rec, "flee")' not in src:
    err("逃走で flee に切り替えていない（速く走らない）")
if 'setMode(bear, rec, "hunt")' not in src:
    err("攻撃で hunt に切り替えていない（プレイヤーを狙わない）")

# --- 6. 走査の返事を受けるところで、消えた熊を触っていないか -------------------

callbacks = list(re.finditer(r"(\(pos\)|onDone: \(hits\))\s*=>\s*\{", src))
if not callbacks:
    err("走査の返事を受けるコールバックが読み取れなかった（検査が空回りしている）")
for cb in callbacks:
    head = src[cb.end() : cb.end() + 260]
    if "rec.gone" not in head or "alive(bear)" not in head:
        err("走査の返事を受けた直後に rec.gone / alive(bear) を見ていないコールバックがある"
            "（返事は数tick遅れて届くので、その間に熊が消えていることがある）: "
            + head.strip().splitlines()[0][:60])

# --- 結果 -------------------------------------------------------------------

print(f"状態 {len(states)} 個 / 遷移 {len(used)} 種 / モード {len(modes)} 種")
for e in errors:
    print(f"  誤り  {e}")
if errors:
    print(f"\n失敗: 誤り {len(errors)} 件")
    sys.exit(1)
print("\n合格")
