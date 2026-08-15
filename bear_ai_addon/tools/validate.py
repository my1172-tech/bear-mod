"""アドオンの整合性検査。

**実機に入れる前にこれを通すこと。** 統合版は定義の書き間違いを
無言で流すことが多く（エンティティが消える・見た目が出ない・音が鳴らない）、
エラーが出ないことは正しさの証明にならない。

見るもの:
  1. すべてのJSONが読めるか
  2. 定義JSONに "//" のコメントキーが混じっていないか
     （バニラも既存MODも使っていない書き方なので、無視される保証が無い）
  3. manifest のUUID・依存関係・スクリプトの入口
  4. RP が指している実体・モデル・アニメ・描画制御・テクスチャが実在するか
  5. BP のスクリプトの import 先が実在するか
  6. .mcfunction が投げる scriptevent が main.js に実装されているか

使い方:
    python tools/validate.py
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
RP = os.path.join(ROOT, "resource_packs", "bear_rp")

errors: list[str] = []
warns: list[str] = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warns.append(msg)


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def load(path):
    try:
        with io.open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        err(f"JSONが読めない {rel(path)}: {e}")
        return None


def all_json(root):
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".json"):
                out.append(os.path.join(dirpath, name))
    return out


def walk_keys(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield path, k
            yield from walk_keys(v, f"{path}/{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk_keys(v, f"{path}[{i}]")


# ---------------------------------------------------------------------------
# 1〜2. JSONとコメントキー
# ---------------------------------------------------------------------------

docs = {}
for path in all_json(BP) + all_json(RP):
    d = load(path)
    if d is None:
        continue
    docs[path] = d
    for _parent, key in walk_keys(d):
        if key.startswith("//"):
            err(f'コメントキー "{key}" が残っている {rel(path)}'
                "（定義JSONにコメントは書かない。説明は docs/ に置く）")

# ---------------------------------------------------------------------------
# 3. manifest
# ---------------------------------------------------------------------------

bp_manifest = docs.get(os.path.join(BP, "manifest.json"))
rp_manifest = docs.get(os.path.join(RP, "manifest.json"))

if not bp_manifest:
    err("BP の manifest.json が無い")
if not rp_manifest:
    err("RP の manifest.json が無い")

if bp_manifest and rp_manifest:
    uuids = []
    for m in (bp_manifest, rp_manifest):
        uuids.append(m["header"]["uuid"])
        for mod in m.get("modules", []):
            uuids.append(mod["uuid"])
    dup = {u for u in uuids if uuids.count(u) > 1}
    if dup:
        err(f"UUIDが重複している: {sorted(dup)}")

    deps = [d.get("uuid") for d in bp_manifest.get("dependencies", [])]
    if rp_manifest["header"]["uuid"] not in deps:
        err("BP の dependencies に RP の header UUID が入っていない"
            "（RPが自動で付いてこないので、見た目が出ない）")

    script_mods = [m for m in bp_manifest.get("modules", []) if m.get("type") == "script"]
    if not script_mods:
        err("BP に script モジュールが無い")
    for m in script_mods:
        entry = os.path.join(BP, m["entry"].replace("/", os.sep))
        if not os.path.isfile(entry):
            err(f"スクリプトの入口が無い: {m['entry']}")
        if not any(d.get("module_name") == "@minecraft/server"
                   for d in bp_manifest.get("dependencies", [])):
            err("dependencies に @minecraft/server が無い（スクリプトが動かない）")

    if bp_manifest["header"].get("min_engine_version") != rp_manifest["header"].get("min_engine_version"):
        warn("BPとRPの min_engine_version が違う")

# ---------------------------------------------------------------------------
# 4. BPの実体と、RPが指しているもの
# ---------------------------------------------------------------------------

bp_entities = {}
for path, d in docs.items():
    if os.path.dirname(path) != os.path.join(BP, "entities"):
        continue
    if not isinstance(d, dict):
        continue
    ident = d.get("minecraft:entity", {}).get("description", {}).get("identifier")
    if not ident:
        err(f"identifier が無い {rel(path)}")
    else:
        bp_entities[ident] = (path, d)

for ident in ("bear:bear", "bear:lure"):
    if ident not in bp_entities:
        err(f"BP に {ident} の定義が無い")

# 体力が無いと読み込み時に無言で間引かれる（重機MODで実証済み）
for ident, (path, d) in bp_entities.items():
    comps = d["minecraft:entity"].get("components", {})
    if "minecraft:health" not in comps:
        err(f"{ident} に minecraft:health が無い（保存して開き直すと無言で消える） {rel(path)}")

# モデル・アニメ・描画制御・テクスチャの登録簿を作る
geometries = set()
animations = set()
controllers = set()
renderers = set()

for path, d in docs.items():
    if not isinstance(d, dict):
        continue  # texts/languages.json のような配列のファイル
    if "minecraft:geometry" in d:
        for g in d["minecraft:geometry"]:
            ident = g.get("description", {}).get("identifier")
            if ident:
                geometries.add(ident)
    for key in d:
        if key.startswith("geometry."):
            geometries.add(key)
    animations |= set(d.get("animations", {}).keys()) if isinstance(d.get("animations"), dict) else set()
    controllers |= set(d.get("animation_controllers", {}).keys()) if isinstance(d.get("animation_controllers"), dict) else set()
    renderers |= set(d.get("render_controllers", {}).keys()) if isinstance(d.get("render_controllers"), dict) else set()

client_entities = {}
for path, d in docs.items():
    if not isinstance(d, dict):
        continue
    ce = d.get("minecraft:client_entity")
    if not ce:
        continue
    desc = ce.get("description", {})
    ident = desc.get("identifier")
    client_entities[ident] = (path, desc)

    if ident not in bp_entities:
        err(f"RP が BP に無い実体を指している: {ident} {rel(path)}")

    for name, geo in (desc.get("geometry") or {}).items():
        if geo not in geometries:
            err(f"{ident}: モデル {geo} が見つからない（{name}） {rel(path)}")

    # アニメは client_entity の animations に書いた名前を、
    # animation_controllers から短い名前で呼ぶ。両方を突き合わせる。
    anim_map = desc.get("animations") or {}
    for short, full in anim_map.items():
        pool = controllers if full.startswith("controller.") else animations
        if full not in pool:
            err(f"{ident}: アニメ {full} が見つからない（{short}） {rel(path)}")

    # **client_entity の description に animation_controllers は書けない。**
    # 統合版は "child 'animation_controllers' not valid here." と出して丸ごと捨てる
    # (実機ログで踏んだ)。アニメ制御は animations に短い名前で登録し、
    # scripts.animate で回す。ここを間違えると**エラーもなく脚が動かない**。
    if "animation_controllers" in desc:
        err(f"{ident}: description に animation_controllers がある {rel(path)}"
            "（統合版はこのキーを受け付けない。animations に登録して "
            "scripts.animate で回すこと。脚が動かなくなる）")

    # animations に登録した制御が、scripts.animate から回されているか。
    # 登録しただけでは**一度も動かない**（無言。エラーも警告も出ない）。
    animate = (desc.get("scripts") or {}).get("animate") or []
    animated = set()
    for a in animate:
        animated |= set(a.keys()) if isinstance(a, dict) else {a}
    for short, full in anim_map.items():
        if full.startswith("controller.") and short not in animated:
            err(f"{ident}: アニメ制御 {short}({full}) が scripts.animate に無い {rel(path)}"
                "（登録しただけでは一度も動かない。脚が止まったまま滑る）")
    for short in animated:
        if short not in anim_map:
            err(f"{ident}: scripts.animate の {short} が animations に無い {rel(path)}")
    if anim_map and not animate:
        err(f"{ident}: scripts.animate が無い {rel(path)}"
            "（アニメを1つも回していない。実機で棒立ちのまま滑る）")

    for rc in desc.get("render_controllers") or []:
        name = rc if isinstance(rc, str) else list(rc.keys())[0]
        if name not in renderers:
            err(f"{ident}: 描画制御 {name} が見つからない {rel(path)}")

    for name, tex in (desc.get("textures") or {}).items():
        png = os.path.join(RP, tex.replace("/", os.sep) + ".png")
        if not os.path.isfile(png):
            err(f"{ident}: テクスチャ {tex}.png が無い（{name}）"
                "  → python tools/make_textures.py で作る")

for ident in bp_entities:
    if ident not in client_entities:
        err(f"RP に {ident} の見た目が無い（実機で描画されない）")

# アニメ制御が呼んでいる短い名前が、client_entity の animations にあるか
for path, d in docs.items():
    if not isinstance(d, dict):
        continue
    for name, ctrl in (d.get("animation_controllers") or {}).items():
        used = set()
        for _state, body in (ctrl.get("states") or {}).items():
            for a in body.get("animations", []):
                used |= set(a.keys()) if isinstance(a, dict) else {a}
        for ident, (cpath, desc) in client_entities.items():
            have = set((desc.get("animations") or {}).keys())
            if name not in (desc.get("animations") or {}).values():
                continue
            missing = used - have
            if missing:
                err(f"{ident}: アニメ制御 {name} が使う {sorted(missing)} が "
                    f"client_entity の animations に無い {rel(cpath)}")

# スポーンルール
for path, d in docs.items():
    if not isinstance(d, dict):
        continue
    sr = d.get("minecraft:spawn_rules")
    if not sr:
        continue
    ident = sr.get("description", {}).get("identifier")
    if ident not in bp_entities:
        err(f"スポーンルールが BP に無い実体を指している: {ident} {rel(path)}")

# 音
sounds = docs.get(os.path.join(RP, "sounds.json"))
if sounds:
    for ident in (sounds.get("entity_sounds", {}).get("entities", {}) or {}):
        if ident not in bp_entities:
            err(f"sounds.json が BP に無い実体を指している: {ident}")

# ---------------------------------------------------------------------------
# 5. スクリプトの import
# ---------------------------------------------------------------------------

scripts_dir = os.path.join(BP, "scripts")
script_files = sorted(
    os.path.join(scripts_dir, n) for n in os.listdir(scripts_dir) if n.endswith(".js")
)
IMPORT_RE = re.compile(r'^\s*import\s+(?:[^"\']*?\sfrom\s+)?["\']([^"\']+)["\']', re.M)
EXPORT_RE = re.compile(r"^\s*export\s+(?:const|let|function|class)\s+(\w+)", re.M)

exports = {}
sources = {}
for path in script_files:
    with io.open(path, encoding="utf-8") as f:
        src = f.read()
    sources[path] = src
    exports[os.path.basename(path)] = set(EXPORT_RE.findall(src))

for path, src in sources.items():
    for spec in IMPORT_RE.findall(src):
        if spec.startswith("@minecraft/"):
            continue
        if not spec.startswith("./"):
            err(f"{rel(path)}: 相対パスでない import: {spec}")
            continue
        target = os.path.join(scripts_dir, spec[2:])
        if not os.path.isfile(target):
            err(f"{rel(path)}: import 先が無い: {spec}")

    # { a, b } from "./x.js" の名前が x.js に export されているか
    for names, spec in re.findall(r"import\s+\{([^}]*)\}\s+from\s+[\"']\./([^\"']+)[\"']", src):
        have = exports.get(spec, set())
        for name in [n.strip().split(" as ")[0].strip() for n in names.split(",")]:
            if name and name not in have:
                err(f"{rel(path)}: {spec} に {name} が export されていない")

# 誰も呼んでいない export が無いか。
#
# **「書いたのに繋いでいない」は実機で無言の不具合になる。** 実際、区間を繋ぐ
# reachedWaypoint() を書いたまま呼び忘れ、熊が途中の目印で止まっていた
# （実機ログの [bear] 489 行中 202 行が「詰まった」だった）。
# 検査は全部通っていた。**通ることは動くことではない。**

ALLOW_UNUSED = {                  # 使い道が決まっていて、今は呼び先が無いもの
    "cancelScan",                 # 走査の打ち切り。外から止めるための口
}

# 検査道具(tools/*.py)が名前で見ている定数は「使われている」。
# BEAR_HEALTH のように、コードは読まないが bear.json との突き合わせに使う値がある。
tool_src = ""
for name in sorted(os.listdir(HERE)):
    if name.endswith(".py"):
        with io.open(os.path.join(HERE, name), encoding="utf-8") as f:
            tool_src += f.read()

for path, src in sources.items():
    name = os.path.basename(path)
    for sym in sorted(exports[name]):
        # 自分のファイルの中での定義行を除いて、どこかで名前が出てくるか
        others = "".join(s for p, s in sources.items() if p != path)
        if re.search(rf"\b{re.escape(sym)}\b", others):
            continue
        # 同じファイルの中だけで使っているものも良しとする
        body = re.sub(rf"^\s*export\s+(?:const|let|function|class)\s+{re.escape(sym)}\b.*$",
                      "", src, flags=re.M)
        if re.search(rf"\b{re.escape(sym)}\b", body):
            continue
        if sym in ALLOW_UNUSED:
            continue
        # 検査道具が突き合わせに使っている値
        if re.search(rf"\b{re.escape(sym)}\b", tool_src):
            continue
        err(f"{name}: export {sym} をどこからも呼んでいない"
            "（繋ぎ忘れは実機で無言の不具合になる。使うか、消すか、"
            "tools/validate.py の ALLOW_UNUSED に理由付きで書く）")

# ---------------------------------------------------------------------------
# 6. .mcfunction と scriptevent
# ---------------------------------------------------------------------------

main_src = sources.get(os.path.join(scripts_dir, "main.js"), "")
handled = set(re.findall(r'case\s+"(\w+)":', main_src))

func_dir = os.path.join(BP, "functions")
if not os.path.isdir(func_dir):
    err("functions/ が無い（/function で操作できない）")
else:
    for name in sorted(os.listdir(func_dir)):
        if not name.endswith(".mcfunction"):
            continue
        with io.open(os.path.join(func_dir, name), encoding="utf-8") as f:
            body = f.read()
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("/"):
                err(f"{name}: .mcfunction の中では先頭に / を付けない: {line}")
            m = re.match(r"scriptevent\s+bear:(\w+)", line)
            if m and m.group(1) not in handled:
                err(f"{name}: scriptevent bear:{m.group(1)} が main.js で処理されていない")

    # main.js が受ける命令に、対応する .mcfunction があるか
    files = {n[: -len(".mcfunction")] for n in os.listdir(func_dir) if n.endswith(".mcfunction")}
    for cmd in sorted(handled):
        if cmd == "debug":
            if "bear_debug_on" not in files or "bear_debug_off" not in files:
                err("bear_debug_on / bear_debug_off の .mcfunction が足りない")
        elif f"bear_{cmd}" not in files:
            warn(f"命令 bear:{cmd} に対応する /function bear_{cmd} が無い"
                 "（scriptevent を直接打たせることになる）")

# ---------------------------------------------------------------------------
# 結果
# ---------------------------------------------------------------------------

print(f"検査したJSON: {len(docs)} 個 / スクリプト: {len(script_files)} 個")
for w in warns:
    print(f"  注意  {w}")
for e in errors:
    print(f"  誤り  {e}")

if errors:
    print(f"\n失敗: 誤り {len(errors)} 件")
    sys.exit(1)
print(f"\n合格{'（注意 ' + str(len(warns)) + ' 件）' if warns else ''}")
