/**
 * 徘徊ルート。指示書の Route A〜E をそのまま持つ。
 *
 * ルートは「行き先の種類」の並びで、1つ着いたら次へ進む。最後まで行ったら先頭に戻る。
 * 種類から実際の座標を出すのがこのファイルの仕事(森はどこか、川はどこか)。
 *
 * 座標探しはブロック走査なので**すぐには返らない**。呼び出し側は
 * コールバックで受け取り、待っている間は今の状態のままにしておくこと。
 */

import {
  ROUTES, TERRAIN_RANGE, TERRAIN_STEP, HOUSE_RANGE, HOUSE_SCAN_Y, LEG_DISTANCE,
  FOREST_BLOCKS, WATER_BLOCKS, FARM_BLOCKS, ROAD_BLOCKS, DOOR_BLOCKS,
  WINDOW_BLOCKS, WINDOW_ENTRY,
} from "./config.js";
import { requestScan } from "./scan.js";
import { distXZ, groundY, pick, pickWeighted, randRange, tryDo } from "./util.js";

const FOREST = new Set(FOREST_BLOCKS);
const WATER = new Set(WATER_BLOCKS);
const FARM = new Set(FARM_BLOCKS);
const ROAD = new Set(ROAD_BLOCKS);
const DOOR = new Set(DOOR_BLOCKS);
const WINDOW = new Set(WINDOW_BLOCKS);

/** ドアかどうか。名前に "_door" が入るものは他アドオンのドアでも拾う。 */
export function isDoor(typeId) {
  return DOOR.has(typeId) || typeId.endsWith("_door");
}

/**
 * 窓(ガラス)かどうか。名前が _glass / _glass_pane で終わるものも拾う。
 *
 * **ドアの見分けと同じ場所に置く。** house.js に置くと routes.js と
 * 相互に import し合う形になり、統合版の読み込み順によっては
 * どちらかが未定義のまま呼ばれる(実機でしか出ない類の壊れ方)。
 */
export function isWindow(typeId) {
  if (typeId === null) return false;
  return WINDOW.has(typeId) || typeId.endsWith("_glass") || typeId.endsWith("_glass_pane");
}

/**
 * 特性に合わせてルートを1つ選ぶ。
 * ROUTES[].weight は「その特性が高い個体ほど選ばれやすい」重み。
 */
export function pickRoute(traits) {
  const w = {};
  for (const key of Object.keys(ROUTES)) {
    let score = 1.0; // どのルートにも最低限の目が出るようにする
    const weight = ROUTES[key].weight ?? {};
    for (const trait of Object.keys(weight)) {
      score += weight[trait] * ((traits[trait] ?? 0.5) - 0.5) * 2;
    }
    w[key] = score;
  }
  return pickWeighted(w);
}

export function routeOf(key) {
  return ROUTES[key] ?? ROUTES.A;
}

/**
 * 行き先の種類から座標を探す。
 *
 * @param {Entity} bear
 * @param {object} rec  熊の記録(home / knownDoors などを見る)
 * @param {string} kind forest|water|farm|road|high|house|edge|home
 * @param {(pos:object|null)=>void} done 見つからなければ null
 * @param {object} [opts] radius … 探す半径を上書きする(個体差を出すのに使う)
 * @returns {boolean} 走査を始められたか(混み合っていて始められないと false)
 */
export function findTarget(bear, rec, kind, done, opts = {}) {
  const dim = bear.dimension;
  const c = {
    x: Math.floor(bear.location.x),
    y: Math.floor(bear.location.y),
    z: Math.floor(bear.location.z),
  };

  switch (kind) {
    case "home":
      done(rec.home ?? null);
      return true;

    case "house":
      // ドアと窓の両方を拾う。**PLATEAUの都市ワールドにはドアが1枚も無い**ので、
      // ドアだけを探すと「家が無い」で終わってしまう(実機で19回出た)。
      return scanFor(bear, rec, done, {
        dimension: dim, center: c, radius: opts.radius ?? HOUSE_RANGE, step: 1, mode: "column",
        yFrom: HOUSE_SCAN_Y.from, yTo: HOUSE_SCAN_Y.to, limit: 12,
        match: (id, pos) =>
          (isDoor(id) || (WINDOW_ENTRY && isWindow(id))) && !isLooted(rec, pos),
      });

    case "forest":
      return terrain(bear, done, dim, c, (id) => FOREST.has(id));
    case "water":
      return terrain(bear, done, dim, c, (id) => WATER.has(id));
    case "farm":
      return terrain(bear, done, dim, c, (id) => FARM.has(id));
    case "road":
      return terrain(bear, done, dim, c, (id) => ROAD.has(id));

    case "high": {
      // 山＝周りよりも高いところ。いちばん上のブロックを間引いて読み、
      // その中でいちばん高い列を選ぶ。
      const job = requestScan({
        dimension: dim, center: c, radius: TERRAIN_RANGE, step: TERRAIN_STEP,
        mode: "topmost", limit: 4096,
        match: () => true,
        onDone: (hits) => {
          let best = null;
          for (const h of hits) {
            if (h.pos.y <= c.y + 2) continue; // 今いる高さと変わらない場所は山ではない
            if (!best || h.pos.y > best.pos.y) best = h;
          }
          done(best ? { x: best.pos.x, y: best.pos.y + 1, z: best.pos.z } : null);
        },
      });
      return !!job;
    }

    case "edge": {
      // 市街地の外れ。知っている家から離れる向きへ出る。
      // 家をまだ知らなければ、ただ遠くへ向かう(＝町の外へ出る動きになる)。
      const doors = rec.knownDoors ?? [];
      if (doors.length === 0) {
        done(randomPoint(bear));
        return true;
      }
      let cx = 0, cz = 0;
      for (const d of doors) { cx += d.x; cz += d.z; }
      cx /= doors.length; cz /= doors.length;
      const dx = bear.location.x - cx, dz = bear.location.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      const dist = randRange(LEG_DISTANCE.min, LEG_DISTANCE.max);
      const tx = Math.floor(bear.location.x + (dx / len) * dist);
      const tz = Math.floor(bear.location.z + (dz / len) * dist);
      const gy = groundY(dim, tx, tz, c.y);
      done(gy === null ? randomPoint(bear) : { x: tx, y: gy, z: tz });
      return true;
    }

    default:
      done(randomPoint(bear));
      return true;
  }
}

function terrain(bear, done, dimension, c, matcher) {
  const job = requestScan({
    dimension, center: c, radius: TERRAIN_RANGE, step: TERRAIN_STEP,
    mode: "topmost", limit: 24,
    match: (id) => matcher(id),
    onDone: (hits) => {
      if (hits.length === 0) { done(null); return; }
      // いちばん近いものばかり選ぶと同じ場所を往復するので、
      // 近い数件からばらけさせる。
      const near = hits.slice(0, Math.min(6, hits.length));
      const h = pick(near);
      done({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z });
    },
  });
  return !!job;
}

function scanFor(bear, rec, done, spec) {
  const job = requestScan({
    ...spec,
    onDone: (hits) => {
      if (hits.length === 0) { done(null); return; }
      // ドアは上下2ブロックで1枚。窓も縦に並ぶ。同じ柱は1つにまとめる。
      const seen = new Set();
      const found = [];
      for (const h of hits) {
        const key = `${h.pos.x},${h.pos.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ ...h.pos, kind: isDoor(h.typeId) ? "door" : "window" });
      }
      rememberDoors(rec, found);
      // **ドアがあればドアを選ぶ。** 窓は割らないと入れないので、開けて入れる
      // ドアのほうが穏当(指示書の「ドアを基準にする」を保てる)。
      const door = found.find((f) => f.kind === "door");
      done(door ?? found[0] ?? null);
    },
  });
  return !!job;
}

/** その熊が「もうあさった」と覚えている場所か。 */
export function isLooted(rec, pos) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  return rec.looted?.has(key) ?? false;
}

function rememberDoors(rec, doors) {
  if (!rec.knownDoors) rec.knownDoors = [];
  for (const d of doors) {
    if (!rec.knownDoors.some((k) => k.x === d.x && k.z === d.z)) rec.knownDoors.push({ ...d });
  }
  if (rec.knownDoors.length > 32) rec.knownDoors.splice(0, rec.knownDoors.length - 32);
}

/** 何も見つからないときの行き先。適当な方角へ、届く距離だけ。 */
export function randomPoint(bear) {
  const dim = bear.dimension;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = randRange(LEG_DISTANCE.min, LEG_DISTANCE.max);
    const x = Math.floor(bear.location.x + Math.cos(a) * d);
    const z = Math.floor(bear.location.z + Math.sin(a) * d);
    const y = groundY(dim, x, z, Math.floor(bear.location.y));
    if (y !== null) return { x, y, z };
  }
  return null;
}

/** 逃走先。プレイヤー(と町)から離れる向きへ。 */
export function fleePoint(bear, from, distance) {
  const dim = bear.dimension;
  const dx = bear.location.x - from.x;
  const dz = bear.location.z - from.z;
  const base = Math.atan2(dz, dx);
  for (let i = 0; i < 8; i++) {
    // まっすぐ逃げられないときは少しずつ角度を変えて試す
    const a = base + (i % 2 === 0 ? 1 : -1) * (Math.PI / 8) * Math.floor(i / 2);
    const x = Math.floor(bear.location.x + Math.cos(a) * distance);
    const z = Math.floor(bear.location.z + Math.sin(a) * distance);
    const y = groundY(dim, x, z, Math.floor(bear.location.y));
    if (y !== null && distXZ({ x, y, z }, from) > distance * 0.6) return { x, y, z };
  }
  return tryDo("逃走先", () => randomPoint(bear)) ?? null;
}
