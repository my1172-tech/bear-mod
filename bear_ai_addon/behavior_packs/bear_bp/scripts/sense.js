/**
 * 熊の感覚。**視界と嗅覚は別物として扱う。**
 *
 *   視界 … 距離 + 視野角 + 見通し。**壁を通らない。** 背後からは近づける
 *   嗅覚 … 距離だけ。**壁を通り抜ける。** 視界よりずっと遠くまで届く
 *
 * これで「家の中で肉を焼いていると、外の熊が匂いを嗅ぎつけて建物へ寄ってくる。
 * ただしプレイヤーの姿は壁越しには見えていない」という動きになる。
 *
 * 熊の状態(rec.alert)が上がるほど、視界は**遠く・狭く**なる(対象に集中する)。
 *   calm 通常 → alert 警戒 → spotted 発見 → chase 追跡
 */

import {
  ALERT_DECAY, COOKING_BLOCKS, SIGHT, SIGHT_NEAR, SIGHT_SAMPLES, SMELL_ANIMALS, SMELL_INTERVAL,
  SMELL_MEMORY, SMELL_RANGE, SMELL_STRENGTH,
} from "./config.js";
import { FOOD_ITEMS } from "./config.js";
import { requestScan } from "./scan.js";
import { alive, dist, distXZ, passableAt, tryDo } from "./util.js";

const COOKING_SET = new Set(COOKING_BLOCKS);
const FOOD_SET = new Set(FOOD_ITEMS);

/** 生肉・魚・果物の見分け。匂いの強さを変えるためだけに使う。 */
const RAW_MEAT = new Set([
  "minecraft:beef", "minecraft:porkchop", "minecraft:chicken", "minecraft:rabbit",
  "minecraft:mutton", "minecraft:muttonRaw", "minecraft:rotten_flesh",
]);
const FISH = new Set([
  "minecraft:cod", "minecraft:fish", "minecraft:salmon", "minecraft:tropical_fish",
  "minecraft:clownfish", "minecraft:pufferfish", "minecraft:cooked_cod",
  "minecraft:cooked_fish", "minecraft:cooked_salmon",
]);
const COOKED_MEAT = new Set([
  "minecraft:cooked_beef", "minecraft:cooked_porkchop", "minecraft:cooked_chicken",
  "minecraft:cooked_rabbit", "minecraft:cooked_mutton", "minecraft:muttonCooked",
]);

// ---------------------------------------------------------------------------
// 状態(警戒の段階)
// ---------------------------------------------------------------------------

export const ALERT_ORDER = ["calm", "alert", "spotted", "chase"];

/** その熊の今の視界(距離と視野角)。 */
export function sightOf(rec) {
  return SIGHT[rec.alert ?? "calm"] ?? SIGHT.calm;
}

/** 警戒の段階を上げる。下げるのは時間だけ(decayAlert)。 */
export function raiseAlert(rec, level, now) {
  const cur = ALERT_ORDER.indexOf(rec.alert ?? "calm");
  const next = ALERT_ORDER.indexOf(level);
  if (next < 0) return;
  if (next > cur) rec.alert = level;
  rec.alertAt = now;
}

/** 何も無い時間が続いたら1段下げる。 */
export function decayAlert(rec, now) {
  const cur = ALERT_ORDER.indexOf(rec.alert ?? "calm");
  if (cur <= 0) return;
  if (now - (rec.alertAt ?? 0) < ALERT_DECAY) return;
  rec.alert = ALERT_ORDER[cur - 1];
  rec.alertAt = now;
}

// ---------------------------------------------------------------------------
// 視界
// ---------------------------------------------------------------------------

/**
 * 熊から見た角度(度)。0 が正面、180 が真後ろ。
 * 熊の向きが読めなければ null(角度で弾かない＝全方位)。
 */
function angleTo(bear, target) {
  const view = tryDo("向きの取得", () => bear.getViewDirection());
  if (!view) return null;
  const vx = view.x, vz = view.z;
  const vlen = Math.hypot(vx, vz);
  if (vlen < 1e-6) return null;
  const dx = target.x - bear.location.x;
  const dz = target.z - bear.location.z;
  const dlen = Math.hypot(dx, dz);
  if (dlen < 1e-6) return 0;
  const cos = (vx * dx + vz * dz) / (vlen * dlen);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * 視野の中にいるか。
 *
 * **境目はゆるく取る。** 視野角180度の熊の真横(ちょうど90度)は「見える」でなければ
 * ならないのに、acos の丸めで 90.00000000000001 が返って弾かれることがある
 * (机上試験で「たまにだけ攻撃に入らない」という形で出た)。
 *
 * 180度でも**真後ろ(180度)は見えない**。半分より前だけが見える、で正しい。
 */
function inFov(bear, target, fov) {
  // すぐ横の気配は向きに関わらず分かる。**ここが無いと、段階が上がって視野が
  // 狭まった瞬間に、真横の相手を見失う。**
  if (distXZ(bear.location, target) <= SIGHT_NEAR) return true;
  const a = angleTo(bear, target);
  if (a === null) return true; // 向きが読めない = 角度で弾かない
  return a <= fov / 2 + 0.01;
}

/**
 * 目が通るか。線上を間引いて読み、塞がっていれば false。
 *
 * **読めないブロックは「通る」扱いにする。** 読み込み範囲の外を「壁」と決めると、
 * 遠くのプレイヤーが常に見えないことになり、視界の距離が意味を失う。
 */
export function hasLineOfSight(dimension, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1.5) return true;
  const steps = Math.min(SIGHT_SAMPLES, Math.max(2, Math.floor(d / 2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = {
      x: Math.floor(from.x + dx * t),
      y: Math.floor(from.y + dy * t),
      z: Math.floor(from.z + dz * t),
    };
    if (passableAt(dimension, p) === false) return false;
  }
  return true;
}

/**
 * 見えているプレイヤーを返す。見えていなければ null。
 *
 * 距離・視野角・見通しの3つを全部満たしたときだけ「見えた」とする。
 * クリエイティブ／観戦は狙わない。
 */
export function seenPlayer(bear, rec) {
  const { range, fov } = sightOf(rec);
  const players = tryDo("プレイヤーの検索", () =>
    bear.dimension.getPlayers({ location: bear.location, maxDistance: range })
  ) ?? [];

  let best = null;
  let bestD = Infinity;
  for (const p of players) {
    if (!alive(p)) continue;
    const mode = tryDo("モードの取得", () => p.getGameMode?.());
    if (mode === "creative" || mode === "spectator") continue;

    if (!inFov(bear, p.location, fov)) continue; // 視野の外(背後)
    const eye = { x: bear.location.x, y: bear.location.y + 1, z: bear.location.z };
    const head = { x: p.location.x, y: p.location.y + 1.5, z: p.location.z };
    if (!hasLineOfSight(bear.dimension, eye, head)) continue; // 壁の向こう

    const d = distXZ(bear.location, p.location);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 嗅覚
// ---------------------------------------------------------------------------

/** 落ちているアイテムの匂いの種類。食料でなければ null。 */
function smellOfItem(typeId) {
  if (!typeId) return null;
  if (COOKED_MEAT.has(typeId)) return "cooking";
  if (RAW_MEAT.has(typeId)) return "raw";
  if (FISH.has(typeId)) return "fish";
  if (FOOD_SET.has(typeId)) return "fruit";
  return null;
}

/** 匂いの点数。**強さ ÷ 距離**。遠くの強い匂いと近くの弱い匂いが釣り合う。 */
function score(kind, d) {
  const s = SMELL_STRENGTH[kind] ?? SMELL_STRENGTH.animal;
  return s / Math.max(1, d);
}

function range(kind) {
  return SMELL_RANGE[kind] ?? SMELL_RANGE.animal;
}

/**
 * 実体(動物・落ちている食料・プレイヤー)の匂いを嗅ぐ。
 * **壁を見ない。** 家の中の肉も匂う。
 *
 * @returns {{pos:object, kind:string, score:number}|null}
 */
function smellEntities(bear) {
  const dim = bear.dimension;
  const far = Math.max(...Object.values(SMELL_RANGE));
  const list = tryDo("匂いの検索", () =>
    dim.getEntities({ location: bear.location, maxDistance: far })
  ) ?? [];

  let best = null;
  for (const e of list) {
    if (!alive(e)) continue;
    let kind = null;
    let at = e.location;

    if (e.typeId === "minecraft:item") {
      const stack = tryDo("落ちている物の中身", () =>
        e.getComponent("minecraft:item")?.itemStack
      );
      kind = smellOfItem(stack ? tryDo("名前", () => stack.typeId) : null);
      if (kind === "raw" || kind === "cooking") kind = "carcass"; // 落ちた肉は強く匂う
    } else if (e.typeId === "minecraft:player") {
      const mode = tryDo("モードの取得", () => e.getGameMode?.());
      if (mode === "creative" || mode === "spectator") continue;
      kind = "player";
    } else {
      kind = SMELL_ANIMALS[e.typeId] ?? null;
    }
    if (!kind) continue;

    const d = dist(bear.location, at);
    if (d > range(kind)) continue;
    const sc = score(kind, d);
    if (!best || sc > best.score) {
      best = {
        pos: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) },
        kind,
        score: sc,
      };
    }
  }
  return best;
}

/**
 * 料理の匂い(火の入ったかまど・焚き火)を探す。走査なので**すぐには返らない**。
 * 見つかったら rec.smell に入れておき、次の周期から使う。
 */
function requestCookingScan(bear, rec, now) {
  const c = {
    x: Math.floor(bear.location.x),
    y: Math.floor(bear.location.y),
    z: Math.floor(bear.location.z),
  };
  const job = requestScan({
    dimension: bear.dimension,
    center: c,
    radius: Math.min(SMELL_RANGE.cooking, 48), // 走査の重さの上限。これ以上は広げない
    step: 2,
    mode: "column",
    yFrom: -6, yTo: 8,
    limit: 3,
    match: (id) => COOKING_SET.has(id),
    onDone: (hits) => {
      rec.cookingPending = false;
      if (rec.gone || !alive(bear)) return; // 返事が届く前に消えた熊
      if (hits.length === 0) { rec.cooking = null; return; }
      const h = hits[0];
      rec.cooking = { pos: h.pos, at: now };
    },
  });
  return !!job;
}

/**
 * いちばん強い匂いを返す。無ければ null。
 *
 * 実体は毎回数え直すと重いので SMELL_INTERVAL おきにし、間は前の答えを使う。
 * 料理はブロック走査なので、頼んでおいて次の周期以降に受け取る。
 *
 * @returns {{pos:object, kind:string, score:number}|null}
 */
export function strongestSmell(bear, rec, now) {
  if (now - (rec.smellAt ?? -1e9) >= SMELL_INTERVAL) {
    rec.smellAt = now;
    rec.smell = smellEntities(bear);
    if (!rec.cookingPending) {
      rec.cookingPending = requestCookingScan(bear, rec, now);
    }
  }

  let best = rec.smell && now - (rec.smellAt ?? 0) < SMELL_MEMORY ? rec.smell : null;

  // 料理の匂いは走査で見つけたものを使う
  const ck = rec.cooking;
  if (ck && now - ck.at < SMELL_MEMORY) {
    const d = dist(bear.location, ck.pos);
    if (d <= range("cooking")) {
      const sc = score("cooking", d);
      if (!best || sc > best.score) best = { pos: ck.pos, kind: "cooking", score: sc };
    }
  }
  return best;
}

/** 人に見せる匂いの名前。bear_status に出す。 */
export const SMELL_LABEL = {
  cooking: "料理", carcass: "肉", raw: "生肉", fish: "魚", fruit: "木の実",
  cow: "牛", sheep: "羊", pig: "豚", animal: "動物", player: "人",
};
