"""config.js と エンティティ定義の数値がずれていないかを見る。

統合版はエンティティ定義（bear.json）の数値をスクリプトから書き換えられない。
そのため体力・移動速度・素の攻撃力は**2か所に同じ数字が書いてある**。
片方だけ直すと、設定を変えたつもりで変わらない（あるいは半分だけ変わる）。
ここがその見張り番。

指示書で「外に出す」と決めた設定値が config.js に揃っているかも見る。

使い方:
    python tools/check_config.py
"""

from __future__ import annotations

import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BP = os.path.join(ROOT, "behavior_packs", "bear_bp")
CONFIG = os.path.join(BP, "scripts", "config.js")

errors = []


def err(msg):
    errors.append(msg)


def read_config():
    """config.js の export const を素朴に読む。数値・文字列・真偽・配列/オブジェクト。"""
    src = io.open(CONFIG, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r"^export const (\w+)\s*=\s*(.+?);?\s*$", src, re.M):
        name, raw = m.group(1), m.group(2).strip()
        if raw.endswith(";"):
            raw = raw[:-1]
        # 数値
        if re.fullmatch(r"-?\d+(\.\d+)?", raw):
            out[name] = float(raw) if "." in raw else int(raw)
            continue
        if raw in ("true", "false"):
            out[name] = raw == "true"
            continue
        m2 = re.fullmatch(r'"([^"]*)"', raw)
        if m2:
            out[name] = m2.group(1)
            continue
        # 複数行の配列・オブジェクトは、その名前から始まる塊を括弧の対応で取り出す
        start = m.start(2)
        if raw[0] in "[{":
            depth = 0
            for i in range(start, len(src)):
                if src[i] in "[{":
                    depth += 1
                elif src[i] in "]}":
                    depth -= 1
                    if depth == 0:
                        block = src[start : i + 1]
                        out[name] = parse_js(block)
                        break
    return out, src


def parse_js(block):
    """JSっぽい書き方をJSONに寄せて読む。読めなければ生の文字列を返す。"""
    s = re.sub(r"//[^\n]*", "", block)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r",(\s*[\]}])", r"\1", s)          # 末尾のカンマ
    s = re.sub(r"([{,]\s*)(\w+)\s*:", r'\1"\2":', s)  # 裸のキー
    s = s.replace("'", '"')
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        return block


cfg, cfg_src = read_config()
bear = json.load(io.open(os.path.join(BP, "entities", "bear.json"), encoding="utf-8"))
comps = bear["minecraft:entity"]["components"]
groups = bear["minecraft:entity"]["component_groups"]
events = bear["minecraft:entity"]["events"]

# --- 0. 版 -------------------------------------------------------------------
# 同じ名前のパックが何本も並ぶと、有効にしたのが直したあとの物か前の物か
# 分からなくなる。**パック名に版を入れて名乗らせる**のが唯一の見分け方なので、
# 番号が3か所（BP/RPのmanifest・config.js）でずれていないかを見る。

rp_manifest = json.load(io.open(
    os.path.join(ROOT, "resource_packs", "bear_rp", "manifest.json"), encoding="utf-8"))
bp_manifest = json.load(io.open(os.path.join(BP, "manifest.json"), encoding="utf-8"))

bp_ver = ".".join(str(v) for v in bp_manifest["header"]["version"])
rp_ver = ".".join(str(v) for v in rp_manifest["header"]["version"])

if bp_ver != rp_ver:
    err(f"BPとRPの版が違う: BP {bp_ver} / RP {rp_ver}（片方だけ上げると古い見た目が残る）")
if cfg.get("VERSION") != bp_ver:
    err(f"版がずれている: config.js VERSION={cfg.get('VERSION')} / manifest {bp_ver}"
        "（ゲームの中で名乗る番号が実際と食い違う）")
for label, man, ver in (("BP", bp_manifest, bp_ver), ("RP", rp_manifest, rp_ver)):
    name = man["header"]["name"]
    if f"v{ver}" not in name:
        err(f"{label} のパック名に版が入っていない: {name!r}（"
            f"パック一覧で同名が並び、どれが最新か分からなくなる。'v{ver}' を入れる）")

# --- 1. 二重に書いてある数値 -------------------------------------------------

health = comps["minecraft:health"]
if cfg.get("BEAR_HEALTH") != health.get("value"):
    err(f"体力がずれている: config.js BEAR_HEALTH={cfg.get('BEAR_HEALTH')} / "
        f"bear.json health.value={health.get('value')}")
if health.get("max") not in (None, health.get("value")):
    err(f"bear.json の health の value と max が違う: {health}")

speed = comps["minecraft:movement"]["value"]
if abs(cfg.get("BEAR_SPEED", -1) - speed) > 1e-9:
    err(f"移動速度がずれている: config.js BEAR_SPEED={cfg.get('BEAR_SPEED')} / "
        f"bear.json movement.value={speed}")

box = comps["minecraft:collision_box"]
if abs(cfg.get("BEAR_WIDTH", -1) - box.get("width", -2)) > 1e-9:
    err(f"当たり判定の幅がずれている: config.js BEAR_WIDTH={cfg.get('BEAR_WIDTH')} / "
        f"bear.json collision_box.width={box.get('width')}")
if abs(cfg.get("BEAR_HEIGHT", -1) - box.get("height", -2)) > 1e-9:
    err(f"当たり判定の高さがずれている: config.js BEAR_HEIGHT={cfg.get('BEAR_HEIGHT')} / "
        f"bear.json collision_box.height={box.get('height')}")

# 幅1以上の実体は幅1のドアや路地を通れない。統合版は食い込んだ実体を押し出さないので、
# 入口に食い込んだまま一歩も動けなくなる（実機で「詰まって動けない」と見えた真因）。
# 指示書の「家侵入」はドアを通ることが前提なので、ここは 1.0 未満でなければならない。
if box.get("width", 0) >= 1.0:
    err(f"bear.json の collision_box.width が {box.get('width')}。"
        "1.0 以上だと幅1のドアを通れず、入口に食い込んで動けなくなる。1.0未満にすること")

# 場面ごとの速さ。config.js と bear.json の両方に同じ数字がある。
SPEED_KEYS = {
    "bear:mode_roam": ("ROAM_SPEED", "minecraft:behavior.move_towards_target", "徘徊"),
    "bear:mode_flee": ("FLEE_SPEED", "minecraft:behavior.move_towards_target", "逃走"),
    "bear:mode_hunt": ("ATTACK_SPEED", "minecraft:behavior.melee_attack", "突進"),
}
for group, (name, comp, label) in SPEED_KEYS.items():
    got = groups.get(group, {}).get(comp, {}).get("speed_multiplier")
    want = cfg.get(name)
    if got is None:
        err(f"bear.json の {group} に {comp} の speed_multiplier が無い")
    elif want is None:
        err(f"config.js に {name} が無い")
    elif abs(got - want) > 1e-9:
        err(f"{label}の速さがずれている: config.js {name}={want} / bear.json {group}={got}")

# **突進が徘徊より速くないと「襲われても速くならない」。**
# 1.3 倍で作ってあったときは徘徊 1.0 との差が3割しかなく、体感できなかった。
if cfg.get("ATTACK_SPEED", 0) < cfg.get("ROAM_SPEED", 0) * 1.4:
    err(f"ATTACK_SPEED({cfg.get('ATTACK_SPEED')}) が ROAM_SPEED({cfg.get('ROAM_SPEED')}) の"
        "1.4倍未満。襲われても速くなったように見えない")
if cfg.get("FLEE_SPEED", 0) < cfg.get("ATTACK_SPEED", 0):
    err(f"FLEE_SPEED({cfg.get('FLEE_SPEED')}) が ATTACK_SPEED({cfg.get('ATTACK_SPEED')}) より遅い。"
        "逃げる熊が追う熊より遅いと、逃走が成立しない")

base_attack = comps["minecraft:attack"]["damage"]
if base_attack != 1:
    err(f"bear.json の minecraft:attack.damage は 1 にしておくこと（今 {base_attack}）。"
        "スクリプトは『素の1を差し引いた残り』を上乗せする作りなので、"
        "ここを変えると打撃数が狂う（bear.js の attackDamage を参照）")

# --- 2. スクリプトが使うモードが定義されているか ------------------------------

bear_js = io.open(os.path.join(BP, "scripts", "bear.js"), encoding="utf-8").read()
modes = set(re.findall(r'setMode\(bear, rec, "(\w+)"\)', bear_js))
if not modes:
    err("bear.js から setMode の呼び出しが読み取れなかった（検査が空回りしている）")
for mode in sorted(modes):
    name = f"bear:mode_{mode}"
    if name not in groups:
        err(f"bear.json に component_group {name} が無い（切り替えが効かない）")
    if name not in events:
        err(f"bear.json に event {name} が無い（triggerEvent が無視される）")

# 逆に、定義してあるのに誰も使わないモードが無いか
for name in groups:
    m = re.fullmatch(r"bear:mode_(\w+)", name)
    if m and m.group(1) not in modes:
        err(f"component_group {name} を使うコードが無い（消し忘れ）")

# events が指す component_groups が実在するか
for ev_name, ev in events.items():
    for key in ("add", "remove"):
        for g in (ev.get(key) or {}).get("component_groups", []):
            if g not in groups:
                err(f"event {ev_name} の {key} が無い component_group を指している: {g}")

# --- 3. 指示書で「外に出す」と決めた設定値 ------------------------------------

for name in ["BEAR_HEALTH", "BEAR_DAMAGE", "CHEST_RANGE", "HOUSE_RANGE",
             "ESCAPE_THRESHOLD", "ESCAPE_TIME", "BREAK_CHANCE"]:
    if name not in cfg:
        err(f"指示書が求める設定値 {name} が config.js に無い")

# --- 4. 値の筋が通っているか -------------------------------------------------

tick = cfg.get("TICK_INTERVAL")
if not (10 <= tick <= 20):
    err(f"TICK_INTERVAL は 10〜20 にすること（指示書の探索間隔）。今 {tick}")

chest_range = cfg.get("CHEST_RANGE")
if not (16 <= chest_range <= 32):
    err(f"CHEST_RANGE は 16〜32 にすること（指示書）。今 {chest_range}")

for name in ("BREAK_CHANCE", "DOOR_BREAK_CHANCE"):
    v = cfg.get(name)
    if not (0 <= v <= 1):
        err(f"{name} は 0〜1 の確率。今 {v}")

dmg = cfg.get("BEAR_DAMAGE")
if isinstance(dmg, dict):
    if not (1 <= dmg.get("minHits", 0) <= dmg.get("maxHits", 0)):
        err(f"BEAR_DAMAGE は 1 <= minHits <= maxHits にすること。今 {dmg}")
else:
    err("BEAR_DAMAGE が読めない（{ minHits, maxHits } の形にする）")

if cfg.get("ESCAPE_THRESHOLD", 0) <= 0:
    err("ESCAPE_THRESHOLD は 0 より大きくすること（0だと1発で必ず逃げる）")

# 誘導体は熊が狙える距離の内側に置かれること。
# ここが逆転すると、目印を置いても熊が気づかず一歩も動かない。
lure_radius = groups["bear:mode_roam"]["minecraft:behavior.nearest_attackable_target"]["within_radius"]
leg = cfg.get("LEG_DISTANCE")
if isinstance(leg, dict) and leg.get("max", 0) > lure_radius:
    err(f"LEG_DISTANCE.max({leg.get('max')}) が熊の目印を見つける距離({lure_radius})より遠い"
        "（熊が目印に気づかず動かなくなる）")

# 目印は**ワールドが動かしている範囲(ticking area)の内側**に置くこと。
# その外に置くと目印が動かず、熊の索敵に映らないまま「詰まった」を出し続ける。
# 統合版のシミュレーション距離の既定は4チャンク＝64m。熊が動く余地を見て 32m 以下。
TICKING_SAFE = 32
wp = cfg.get("WAYPOINT_MAX")
if wp is None:
    err("WAYPOINT_MAX が config.js に無い（目印を置く距離の上限）")
elif wp > TICKING_SAFE:
    err(f"WAYPOINT_MAX({wp}) が {TICKING_SAFE} より遠い。"
        "ワールドが動かしている範囲の外に目印が出て、熊が気づかなくなる")
elif wp > lure_radius:
    err(f"WAYPOINT_MAX({wp}) が熊の目印を見つける距離({lure_radius})より遠い")

# scan_interval が 10 未満だと統合版が毎回 [Json][error] を吐き、動作も重くなる。
for gname, g in groups.items():
    nat = g.get("minecraft:behavior.nearest_attackable_target")
    if not nat:
        continue
    si = nat.get("scan_interval")
    if si is not None and si < 10:
        err(f"{gname} の scan_interval が {si}。10未満は統合版が毎回エラーを出す"
            "（ログが埋まって本当の失敗が見えなくなる）")

follow = comps["minecraft:follow_range"]["value"]
if isinstance(leg, dict) and leg.get("max", 0) > follow:
    err(f"LEG_DISTANCE.max({leg.get('max')}) が follow_range({follow})より遠い")

# --- 5. ブロック・アイテムIDの体裁 -------------------------------------------

for name in ("DOOR_BLOCKS", "CHEST_BLOCKS", "FOREST_BLOCKS", "WATER_BLOCKS",
             "FARM_BLOCKS", "ROAD_BLOCKS", "FOOD_ITEMS"):
    ids = cfg.get(name)
    if not isinstance(ids, list) or not ids:
        err(f"{name} が一覧として読めない")
        continue
    for i in ids:
        if not isinstance(i, str) or not i.startswith("minecraft:"):
            err(f"{name} に名前空間の無いIDがある: {i}")
    if len(set(ids)) != len(ids):
        dup = sorted({i for i in ids if ids.count(i) > 1})
        err(f"{name} に重複がある: {dup}")

# --- 結果 -------------------------------------------------------------------

print(f"読んだ設定値: {len(cfg)} 個")
for e in errors:
    print(f"  誤り  {e}")
if errors:
    print(f"\n失敗: 誤り {len(errors)} 件")
    sys.exit(1)
print("\n合格")
