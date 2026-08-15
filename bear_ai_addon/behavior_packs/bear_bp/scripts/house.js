/**
 * 家の扱い。判定はドアを基準にする(指示書どおり)。
 *
 * ドアを開けて入る動作そのものはバニラのAIがやる
 * (bear.json の annotation.open_door + behavior.open_door + navigation の
 *  can_open_doors)。スクリプトの仕事は
 *   ・どこが「家の中」かを決めて、そこへ行き先を置くこと
 *   ・開かないドア(鉄など)や、つっかえたときにドアを壊すこと
 * の2つ。
 */

import {
  BROKEN_BLOCK, DOOR_UNBREAKABLE, WINDOW_ENTRY, WINDOW_MARGIN, WINDOW_OPEN_MAX,
  WINDOW_STEP_UP,
} from "./config.js";
import { isDoor, isWindow } from "./routes.js";
import { getBlock, groundY, isAir, topmost, tryDo, typeIdAt } from "./util.js";

const DIRS = [
  { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
];

/**
 * ドアの**下半分**を返す。
 *
 * ドアは上下2ブロックで1枚。走査で先に見つかるのがどちらかは、熊の立っている
 * 高さで変わる。上半分を基準にすると「足元が空気」なので中の判定が全部外れ、
 * 熊が家に入れなくなる。基準は必ず下半分に揃える。
 */
export function lowerDoor(dimension, door) {
  let pos = { ...door };
  for (let i = 0; i < 2; i++) {
    const below = { x: pos.x, y: pos.y - 1, z: pos.z };
    const id = typeIdAt(dimension, below);
    if (id !== null && isDoor(id)) pos = below;
    else break;
  }
  return pos;
}

/**
 * ドアの「家の中」側を返す。
 *
 * 屋根があるほうが中、という単純な見分け方をする。ドアの左右2ブロック先を見て、
 * その真上に屋根(ドアより高いブロック)があるほうを中と決める。
 * どちらにも屋根が無ければ null(＝中が分からない。ドアの前で止める)。
 */
export function insidePoint(dimension, door) {
  let best = null;
  for (const d of DIRS) {
    const x = door.x + d.dx * 2;
    const z = door.z + d.dz * 2;

    // 立てる場所か（足が入らない場所を中とは呼べない）
    const floor = getBlock(dimension, { x, y: door.y - 1, z });
    if (!floor || isAir(floor.typeId)) continue;
    if (!isAir(typeIdAt(dimension, { x, y: door.y, z }))) continue;
    if (!isAir(typeIdAt(dimension, { x, y: door.y + 1, z }))) continue;

    // 屋根があるか
    const top = topmost(dimension, x, z);
    if (!top) continue;
    const roof = top.location.y - door.y;
    if (roof < 2) continue;

    if (!best || roof > best.roof) best = { x, y: door.y, z, roof };
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/**
 * ドアの前(**外側**)の立ち位置。
 *
 * 立てる向きのうち、屋根が無いほう＝外を選ぶ。ここを間違えて中を返すと、
 * 熊が壁をすり抜けて入ったように見える(実際には遠回りするので、ただ遅くなる)。
 */
export function frontPoint(dimension, door) {
  let fallback = null;
  for (const d of DIRS) {
    const x = door.x + d.dx;
    const z = door.z + d.dz;
    if (!isAir(typeIdAt(dimension, { x, y: door.y, z }))) continue;
    if (!isAir(typeIdAt(dimension, { x, y: door.y + 1, z }))) continue;

    const top = topmost(dimension, x, z);
    const roofed = top ? top.location.y - door.y >= 2 : false;
    if (!roofed) return { x, y: door.y, z };   // 屋根が無い＝外
    if (!fallback) fallback = { x, y: door.y, z };
  }
  return fallback ?? { x: door.x, y: door.y, z: door.z };
}

// ---------------------------------------------------------------------------
// 窓
// ---------------------------------------------------------------------------

/**
 * その窓から**中へ入れるか**を見て、割るべき高さを返す。入れなければ null。
 *
 * 熊は窓枠ごと腕で押し広げる。開口は**ガラスの連なりの上下 WINDOW_MARGIN(1) 段**まで。
 * ふつうの家の窓はガラス1段(地面から3段目)なので、上下に1段ずつ広げて
 * 3段の穴にする。これで高さ1.4の熊が通れる。
 *
 * 守る線は3つ。
 *   1. 開口の下端が、外に立った熊の足元から WINDOW_STEP_UP(1) 段以内
 *      — 統合版のモブが登れるのは1段まで。ここを超えると割ったのに入れない
 *   2. **外の地面より下は掘らない** — 掘ると窓ではなく穴になる
 *   3. 高さは WINDOW_OPEN_MAX(3) 段まで — ガラス張りのビルで壁面が丸ごと消えないように
 *
 * @returns {{y:number, height:number}|null} 壊し始める高さと、壊す段数
 */
export function windowOpening(dimension, win) {
  if (!WINDOW_ENTRY) return null;

  // ガラスの連なり(上下)を求める
  let glassLow = win.y;
  let glassHigh = win.y;
  for (let i = 0; i < 8; i++) {
    const p = { x: win.x, y: glassLow - 1, z: win.z };
    if (!isWindow(typeIdAt(dimension, p))) break;
    glassLow = p.y;
  }
  for (let i = 0; i < 8; i++) {
    const p = { x: win.x, y: glassHigh + 1, z: win.z };
    if (!isWindow(typeIdAt(dimension, p))) break;
    glassHigh = p.y;
  }

  // 外に立ったときの足元の高さ。窓の1つ外側の柱で測る。
  let standY = null;
  for (const d of DIRS) {
    const y = groundY(dimension, win.x + d.dx, win.z + d.dz, win.y);
    if (y === null) continue;
    if (standY === null || Math.abs(y - glassLow) < Math.abs(standY - glassLow)) standY = y;
  }
  if (standY === null) return null;
  if (glassHigh < standY) return null; // 窓が足元より下(地下)

  // ガラスの上下 WINDOW_MARGIN 段まで押し広げる。
  // **外の地面より下は掘らない。** 掘ると窓ではなく穴になる。
  const bottom = Math.max(glassLow - WINDOW_MARGIN, standY);
  if (bottom - standY > WINDOW_STEP_UP) return null; // 登れない高さ

  // 高さは上限で頭打ちにする(ガラス張りのビルで壁面が丸ごと消えないように)
  const top = Math.min(glassHigh + WINDOW_MARGIN, bottom + WINDOW_OPEN_MAX - 1);
  const height = top - bottom + 1;
  if (height < 2) return null; // 熊は高さ1.4。1段の穴は通れない

  return { y: bottom, height };
}

/** 熊にも壊せないブロック。ここを壊すとワールドが壊れる。 */
const UNBREAKABLE = new Set([
  "minecraft:bedrock", "minecraft:barrier", "minecraft:command_block",
  "minecraft:structure_block", "minecraft:light_block", "minecraft:deny", "minecraft:allow",
]);

/**
 * 窓をぶち抜く。ガラスと、その**上下1段(WINDOW_MARGIN)ぶんの窓枠**を壊す。
 *
 * ガラスだけを割ると、ふつうの家(ガラス1段)では穴が1段しか開かず、
 * 高さ1.4の熊は通れない。熊が腕で窓枠ごと押し広げるぶんとして、
 * windowOpening が決めた範囲だけを壊す。**それ以外の壁には触らない。**
 *
 * @returns {boolean} 壊せたか
 */
export function breakWindow(dimension, win, opening) {
  if (!WINDOW_ENTRY || !opening) return false;
  let broke = false;
  let glass = false;
  for (let i = 0; i < opening.height; i++) {
    const pos = { x: win.x, y: opening.y + i, z: win.z };
    const id = typeIdAt(dimension, pos);
    if (id === null || isAir(id)) continue;
    if (UNBREAKABLE.has(id)) continue;
    const ok = tryDo("窓をぶち抜く", () => {
      dimension.getBlock(pos).setType(BROKEN_BLOCK);
      return true;
    });
    if (ok) {
      broke = true;
      if (isWindow(id)) glass = true;
    }
  }
  if (broke) {
    tryDo("割れる音", () =>
      dimension.playSound(glass ? "random.glass" : "mob.zombie.woodbreak",
        { x: win.x + 0.5, y: opening.y + 0.5, z: win.z + 0.5 })
    );
  }
  return broke;
}

/**
 * その窓がまだ塞がっているか(他の熊が割ったあとを叩き続けないため)。
 * ガラスに限らず、開口の中に何か残っていれば「まだ塞がっている」。
 */
export function windowStillThere(dimension, win, opening = null) {
  if (!opening) return isWindow(typeIdAt(dimension, win));
  for (let i = 0; i < opening.height; i++) {
    const id = typeIdAt(dimension, { x: win.x, y: opening.y + i, z: win.z });
    if (id !== null && !isAir(id)) return true;
  }
  return false;
}

/**
 * 窓の外の立ち位置。屋根が無いほう＝外。
 * ドアと違い、窓は高さが地面と違うので、**必ず地面の高さを測り直す**。
 */
export function windowFront(dimension, win) {
  let fallback = null;
  for (const d of DIRS) {
    const x = win.x + d.dx;
    const z = win.z + d.dz;
    const y = groundY(dimension, x, z, win.y);
    if (y === null) continue;
    const top = topmost(dimension, x, z);
    const roofed = top ? top.location.y - y >= 2 : false;
    if (!roofed) return { x, y, z };
    if (!fallback) fallback = { x, y, z };
  }
  return fallback;
}

/** 窓の内側(家の中)の立ち位置。屋根があるほうが中。 */
export function windowInside(dimension, win) {
  let best = null;
  for (const d of DIRS) {
    const x = win.x + d.dx * 2;
    const z = win.z + d.dz * 2;
    const y = groundY(dimension, x, z, win.y);
    if (y === null) continue;
    const top = topmost(dimension, x, z);
    if (!top) continue;
    const roof = top.location.y - y;
    if (roof < 2) continue;
    if (!best || roof > best.roof) best = { x, y, z, roof };
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/** 鉄のドアなど、熊には開けられないドアか。 */
export function isLockedDoor(typeId) {
  return typeId === "minecraft:iron_door";
}

/**
 * ドアを壊す。上下2枚とも消す(片方だけ消すと空中に半分残る)。
 * @returns {boolean} 壊せたか
 */
export function breakDoor(dimension, door) {
  const id = typeIdAt(dimension, door);
  if (id === null || !isDoor(id)) return false;
  if (DOOR_UNBREAKABLE.includes(id)) return false;

  let broke = false;
  for (const dy of [0, 1, -1]) {
    const pos = { x: door.x, y: door.y + dy, z: door.z };
    const t = typeIdAt(dimension, pos);
    if (t !== null && isDoor(t)) {
      const ok = tryDo("ドアの破壊", () => {
        dimension.getBlock(pos).setType(BROKEN_BLOCK);
        return true;
      });
      broke = broke || !!ok;
    }
  }
  if (broke) {
    // ゾンビが木のドアを叩き割る音。統合版に実在するIDだけを使う
    tryDo("破壊音", () =>
      dimension.playSound("mob.zombie.woodbreak", { x: door.x + 0.5, y: door.y + 0.5, z: door.z + 0.5 })
    );
  }
  return broke;
}

/** そのドアがまだ残っているか(他の熊が壊したあとを追いかけないため)。 */
export function doorStillThere(dimension, door) {
  const id = typeIdAt(dimension, door);
  return id !== null && isDoor(id);
}
