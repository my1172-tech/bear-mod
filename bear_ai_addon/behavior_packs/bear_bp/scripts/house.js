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
  BROKEN_BLOCK, DOOR_UNBREAKABLE, WINDOW_ENTRY, WINDOW_STEP_UP,
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
 * 条件は2つだけ。
 *   1. 窓の下端が、外に立った熊の足元から WINDOW_STEP_UP(1) 段以内にあること
 *      — 統合版のモブが登れるのは1段まで。腰高窓は覗けても入れない
 *   2. その上にもう1つ、ガラスか空気があること — 熊は高さ1.4。1段の穴は通れない
 *
 * **壁は数に入れない。** 割るのはガラスだけで、足りなければその窓は諦める。
 *
 * @returns {{y:number, height:number}|null} 割り始める高さと、割る段数
 */
export function windowOpening(dimension, win) {
  if (!WINDOW_ENTRY) return null;

  // 窓の下端を探す(下へガラスが続くならそちらが下端)
  let bottom = win.y;
  for (let i = 0; i < 4; i++) {
    const below = { x: win.x, y: bottom - 1, z: win.z };
    if (!isWindow(typeIdAt(dimension, below))) break;
    bottom = below.y;
  }

  // 外に立ったときの足元の高さ。窓の1つ外側の柱で測る。
  let standY = null;
  for (const d of DIRS) {
    const y = groundY(dimension, win.x + d.dx, win.z + d.dz, win.y);
    if (y === null) continue;
    if (standY === null || Math.abs(y - bottom) < Math.abs(standY - bottom)) standY = y;
  }
  if (standY === null) return null;

  if (bottom < standY) return null;                    // 窓が足元より下(地下)
  if (bottom - standY > WINDOW_STEP_UP) return null;   // 登れない高さ。腰高窓

  // 2段ぶんの穴を作れるか。上がガラスなら割る、空気ならそのまま使う。
  const upper = { x: win.x, y: bottom + 1, z: win.z };
  const upperId = typeIdAt(dimension, upper);
  if (upperId === null) return null;
  if (!isWindow(upperId) && !isAir(upperId)) return null; // 上は壁。壁は壊さない

  return { y: bottom, height: isWindow(upperId) ? 2 : 1 };
}

/**
 * 窓を割る。**ガラスだけを割る。** 壁は1ブロックも壊さない。
 * @returns {boolean} 割れたか
 */
export function breakWindow(dimension, win, opening) {
  if (!WINDOW_ENTRY || !opening) return false;
  let broke = false;
  for (let i = 0; i < opening.height; i++) {
    const pos = { x: win.x, y: opening.y + i, z: win.z };
    if (!isWindow(typeIdAt(dimension, pos))) continue;
    const ok = tryDo("窓を割る", () => {
      dimension.getBlock(pos).setType(BROKEN_BLOCK);
      return true;
    });
    broke = broke || !!ok;
  }
  if (broke) {
    tryDo("ガラスの割れる音", () =>
      dimension.playSound("random.glass", { x: win.x + 0.5, y: win.y + 0.5, z: win.z + 0.5 })
    );
  }
  return broke;
}

/** その窓がまだ残っているか(他の熊が割ったあとを追いかけないため)。 */
export function windowStillThere(dimension, win) {
  return isWindow(typeIdAt(dimension, win));
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
