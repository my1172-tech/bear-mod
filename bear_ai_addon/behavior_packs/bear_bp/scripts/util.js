/**
 * どの部品からも使う小さな道具。
 *
 * ここに置くのは「マイクラの都合を吸収するもの」だけにする。
 * 熊の考え方(状態機械)は bear.js、行き先の決め方は routes.js。
 */

// ---------------------------------------------------------------------------
// 座標
// ---------------------------------------------------------------------------

export function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function dist(a, b) {
  return Math.sqrt(dist2(a, b));
}

/** 高さを無視した距離。徘徊の「着いた/着いていない」は水平で見るほうが素直。 */
export function distXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function floorPos(loc) {
  return { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
}

/** ブロックの中心。誘導体やテレポートの行き先はここに置く。 */
export function center(pos) {
  return { x: Math.floor(pos.x) + 0.5, y: Math.floor(pos.y), z: Math.floor(pos.z) + 0.5 };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// 乱数
// ---------------------------------------------------------------------------

export function chance(p) {
  return Math.random() < p;
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** { key: weight } から重み付きで1つ選ぶ。重みは負でもよい(0に丸める)。 */
export function pickWeighted(weights) {
  const keys = Object.keys(weights);
  let total = 0;
  for (const k of keys) total += Math.max(0, weights[k]);
  if (total <= 0) return pick(keys);
  let r = Math.random() * total;
  for (const k of keys) {
    r -= Math.max(0, weights[k]);
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

// ---------------------------------------------------------------------------
// ブロック
// ---------------------------------------------------------------------------

/**
 * ブロックを読む。**未読み込みのチャンクでは例外が飛ぶ**ので必ずここを通す。
 * 読めなければ null。呼び出し側は「無かった」ではなく「まだ分からない」と扱うこと。
 */
export function getBlock(dimension, pos) {
  try {
    return dimension.getBlock(pos) ?? null;
  } catch {
    return null;
  }
}

export function typeIdAt(dimension, pos) {
  const b = getBlock(dimension, pos);
  if (!b) return null;
  // **名前を読むだけでも例外が飛ぶ**(読み込み範囲から外れた瞬間)。ここで止める。
  try {
    return b.typeId;
  } catch {
    return null;
  }
}

/** その列のいちばん上にあるブロック。地形の種類を見分けるのに使う。 */
export function topmost(dimension, x, z) {
  try {
    return dimension.getTopmostBlock({ x, y: 0, z }) ?? null;
  } catch {
    return null;
  }
}

const AIR_LIKE = new Set([
  "minecraft:air", "minecraft:cave_air", "minecraft:void_air",
]);

/** ブロックの値を読む。読めなければ null(例外は外に出さない)。 */
function tryRead(fn) {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

export function isAir(typeId) {
  return typeId === null || AIR_LIKE.has(typeId);
}

/**
 * 体が通れるブロックか。
 *   true  … 通れる(空気・水・草・松明・ドアなど)
 *   false … 塞がっている
 *   null  … **読めない**(読み込み範囲の外)。分からないので、どちらにも倒さない
 *
 * 「読めない」を false(塞がっている)に丸めると、遠くの熊が全部
 * 「埋まっている」ことになって片端から掘り出されてしまう。必ず null のまま返す。
 */
export function passableAt(dimension, pos) {
  const id = typeIdAt(dimension, pos);
  if (id === null) return null;
  if (AIR_LIKE.has(id)) return true;
  // ドアは開けて通る。開いているか閉じているかに関わらず「塞がり」とは呼ばない
  if (id.endsWith("_door")) return true;
  if (SOFT_BLOCKS.has(id) || SOFT_SUFFIX.some((s) => id.endsWith(s))) return true;

  const b = getBlock(dimension, pos);
  if (!b) return null;
  if (tryRead(() => b.isLiquid) === true) return true;
  const solid = tryRead(() => b.isSolid);
  if (solid === false) return true;   // 看板・松明など、当たり判定の無いブロック
  return false;
}

/** 当たり判定が無い(または体が通る)ことが分かっているブロック。 */
const SOFT_BLOCKS = new Set([
  "minecraft:snow_layer", "minecraft:short_grass", "minecraft:tallgrass", "minecraft:grass",
  "minecraft:fern", "minecraft:large_fern", "minecraft:double_plant", "minecraft:deadbush",
  "minecraft:torch", "minecraft:soul_torch", "minecraft:redstone_torch", "minecraft:lantern",
  "minecraft:vine", "minecraft:ladder", "minecraft:web", "minecraft:sweet_berry_bush",
  "minecraft:red_flower", "minecraft:yellow_flower", "minecraft:seagrass", "minecraft:kelp",
  "minecraft:rail", "minecraft:golden_rail", "minecraft:detector_rail", "minecraft:activator_rail",
]);

/** 名前の末尾で見分けられる「体が通るブロック」。 */
const SOFT_SUFFIX = [
  "_carpet", "_sign", "_button", "_pressure_plate", "_sapling", "_banner", "_rail", "_torch",
];

/**
 * 立てる場所か。足元が固くて、頭2つぶんが空いていること。
 * 熊を湧かせる場所と、逃走先・救出先を選ぶときに使う。
 *
 * @param {number} width 実体の当たり判定の幅。1.0 を超えると隣の柱にはみ出すので、
 *   はみ出す先も空いていることを確かめる。**幅を見ないと壁の中に湧く。**
 */
export function isStandable(dimension, pos, width = 1) {
  const floor = getBlock(dimension, { x: pos.x, y: pos.y - 1, z: pos.z });
  if (!floor) return false;
  try {
    if (isAir(floor.typeId) || floor.isLiquid) return false;
  } catch {
    return false; // 読めない = 立てるかどうか分からない。立てない扱いにする
  }
  const a = typeIdAt(dimension, pos);
  const b = typeIdAt(dimension, { x: pos.x, y: pos.y + 1, z: pos.z });
  if (!isAir(a) || !isAir(b)) return false;

  if (width <= 1) return true;
  const reach = Math.ceil((width - 1) / 2);
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (const dy of [0, 1]) {
        if (passableAt(dimension, { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }) !== true) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * そこから出られるか(四方のどれかが通れるか)。
 *
 * 立てるだけでは足りない。**周りを全部ブロックで囲まれた1マスの穴**に湧かせると、
 * 熊は立ててはいるのに永久に動けない(実機の「詰まって動けない」の一因)。
 */
export function hasExit(dimension, pos) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const p = { x: pos.x + dx, y: pos.y, z: pos.z + dz };
    if (passableAt(dimension, p) === true) return true;
  }
  return false;
}

/**
 * 実体がブロックの中に食い込んでいるか。
 *
 * 足元(y)ではなく**胴と頭の高さ**で見る。地面に立っている実体の y は
 * ちょうど床の上面(例 64.0)なので、足元の柱で見ると誤差 0.001 で
 * 「地面の中」と誤判定する。
 *
 * 読めないブロックが1つでもあれば false(＝埋まっていない扱い)を返す。
 * **分からないものを根拠に熊を動かさない。**
 */
export function embeddedAt(dimension, loc, width = 1, height = 1.4) {
  const half = Math.min(width, 1.9) / 2 - 0.01;
  const ys = [...new Set([
    Math.floor(loc.y + 0.4),
    Math.floor(loc.y + Math.min(height, 1.9) * 0.75),
  ])];
  let blocked = false;
  for (const dx of [-half, half]) {
    for (const dz of [-half, half]) {
      for (const y of ys) {
        const p = { x: Math.floor(loc.x + dx), y, z: Math.floor(loc.z + dz) };
        const v = passableAt(dimension, p);
        if (v === null) return false; // 読めない = 判断しない
        if (v === false) blocked = true;
      }
    }
  }
  return blocked;
}

/** 近い順に見る相対座標。上へ抜けるほうを下より優先する(埋まった熊は掘り出す)。 */
function rescueOffsets(range) {
  const list = [];
  for (let dy = -range; dy <= range + 1; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        // 上へ出るのは安い(dy>0 は重みを軽く)、下へ潜るのは高い
        const cost = dx * dx + dz * dz + (dy >= 0 ? dy * dy * 2 : dy * dy * 6);
        list.push({ dx, dy, dz, cost });
      }
    }
  }
  list.sort((a, b) => a.cost - b.cost);
  return list;
}

const rescueCache = new Map();

/**
 * 近くの「立てる場所」を1つ返す。見つからなければ null。
 * 埋まった熊を掘り出す先を探すのに使う。近い順に見て、最初に見つかったところで止める。
 */
export function freeSpot(dimension, from, range = 3, width = 1) {
  let offsets = rescueCache.get(range);
  if (!offsets) {
    offsets = rescueOffsets(range);
    rescueCache.set(range, offsets);
  }
  const base = floorPos(from);
  for (const off of offsets) {
    const p = { x: base.x + off.dx, y: base.y + off.dy, z: base.z + off.dz };
    if (isStandable(dimension, p, width) && hasExit(dimension, p)) return p;
  }
  return null;
}

/**
 * その列の地面の高さ(立てる y)を返す。見つからなければ null。
 * いちばん上のブロックから始めて、屋根の下にも降りて探す。
 */
export function groundY(dimension, x, z, hintY = null, width = 1) {
  const top = topmost(dimension, x, z);
  // 位置を読むだけでも例外が飛ぶので、読めなければ手がかりの高さから探す。
  const topY = top ? tryRead(() => top.location.y) : null;
  const start = topY === null ? (hintY ?? 100) : topY + 1;
  for (let y = start; y > start - 40; y--) {
    if (isStandable(dimension, { x, y, z }, width)) return y;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 実体
// ---------------------------------------------------------------------------

/** 消えた実体を触ると例外が飛ぶ。触る前に必ずこれで確かめる。 */
export function alive(entity) {
  try {
    return !!entity && entity.isValid;
  } catch {
    return false;
  }
}

/** 例外を握りつぶして実行する。ログだけ残す。 */
export function tryDo(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[bear] ${label}: ${e}`);
    return undefined;
  }
}
