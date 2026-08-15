/**
 * 行き先の与え方。
 *
 * 統合版のスクリプトAPIには「この座標へ歩け」という命令が無い。経路探索を
 * 持っているのはバニラのAIだけなので、**行き先に見えない目印(誘導体)を置いて
 * それを狙わせる**。熊は nearest_attackable_target で目印を見つけ、
 * move_towards_target で歩いていく。段差・階段・ドアの通り抜けは全部AIがやる。
 *
 * 目印は熊1頭につき1つ。熊が消えたら一緒に消す(置き去りにすると世界に溜まる)。
 */

import {
  LURE_TYPE, ARRIVE_DIST, BEAR_HEIGHT, BEAR_WIDTH, STUCK_DIST, STUCK_LIMIT,
  STUCK_RECOVER, STUCK_RESCUE_RANGE, WAYPOINT_MAX,
} from "./config.js";
import { alive, center, distXZ, embeddedAt, freeSpot, groundY, tryDo } from "./util.js";

/**
 * 目印を出せなかった最後の理由。
 * 目印が出ないと熊は行き先を持てず、その場をうろつくだけになる。
 * **黙って諦めると実機で原因が追えない**ので、理由を残して bear_status に出す。
 */
let lureTrouble = null;

export function lureProblem() {
  return lureTrouble;
}

/** その熊の目印を返す。無ければ湧かせる。 */
export function ensureLure(bear, rec) {
  // **消えた熊のために目印を作ってはいけない。**
  // ブロック走査の返事は数tick遅れて届くので、その間に熊が死んでいることがある。
  // ここで止めないと、飼い主のいない目印が世界に溜まる。
  if (rec.gone || !alive(bear)) return null;
  if (rec.lure && alive(rec.lure)) return rec.lure;

  // 保存してあるIDから拾い直す(ワールドを開き直した直後など)
  if (rec.lureId) {
    const found = tryDo("目印の再取得", () =>
      bear.dimension.getEntities({ type: LURE_TYPE }).find((e) => e.id === rec.lureId)
    );
    if (alive(found)) {
      rec.lure = found;
      return found;
    }
  }

  let lure = null;
  try {
    lure = bear.dimension.spawnEntity(LURE_TYPE, bear.location);
  } catch (e) {
    lureTrouble = String(e);
    console.warn(`[bear] 目印を出せない: ${e}`);
    return null;
  }
  if (!alive(lure)) {
    lureTrouble = "目印が湧いた直後に消えました";
    return null;
  }
  lureTrouble = null;
  rec.lure = lure;
  rec.lureId = lure.id;
  return lure;
}

/**
 * 行き先を置く。遠すぎる相手には、そちらの方角の届く距離までに置き直す
 * (遠いと熊が目印に気づかず、その場から動かない)。
 *
 * @returns {boolean} 置けたか
 */
export function setWaypoint(bear, rec, target) {
  const lure = ensureLure(bear, rec);
  if (!lure) return false;

  let goal = { x: target.x, y: target.y, z: target.z };
  const d = distXZ(bear.location, goal);
  if (d > WAYPOINT_MAX) {
    const t = WAYPOINT_MAX / d;
    goal = {
      x: bear.location.x + (goal.x - bear.location.x) * t,
      y: goal.y,
      z: bear.location.z + (goal.z - bear.location.z) * t,
    };
    // 途中に置いた点は地面の高さが分からないので測り直す。
    // **測れなければ目印を置かない。** 目標の高さをそのまま使うと、丘の手前では
    // 地中に、谷の手前では空中に目印が沈む/浮く。地中の目印は熊が永久に届かず、
    // 壁や地面に体を押しつけたまま「詰まった」を出し続けることになる。
    const gy = groundY(bear.dimension, Math.floor(goal.x), Math.floor(goal.z), bear.location.y);
    if (gy === null) return false;
    goal.y = gy;
  }

  const ok = tryDo("目印の移動", () => {
    lure.teleport(center(goal), { dimension: bear.dimension });
    return true;
  });
  if (!ok) return false;

  rec.waypoint = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) };
  rec.finalTarget = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
  rec.legTick = 0;
  rec.stuck = 0;
  rec.lastPos = { ...bear.location };
  return true;
}

/** 今の行き先に着いたか。高さは無視する(2階の窓の下で「着いた」にしたい)。 */
export function arrived(bear, rec, tolerance = ARRIVE_DIST) {
  if (!rec.finalTarget) return true;
  return distXZ(bear.location, rec.finalTarget) <= tolerance;
}

/** 目印まで着いたか(最終目標が遠いときの、途中の点への到着)。 */
export function reachedWaypoint(bear, rec, tolerance = ARRIVE_DIST) {
  if (!rec.waypoint) return true;
  return distXZ(bear.location, rec.waypoint) <= tolerance;
}

/**
 * 遠い行き先へ向かう途中で、目印まで着いたら**次の区間へ置き直す**。
 *
 * 目印は WAYPOINT_MAX より遠くへは置けない。遠い行き先はその距離ずつ
 * 繋いでいく必要があるのに、**繋ぎ直す呼び出しが無かった**。
 * そのため熊は途中の目印に着いた時点で行き先を失い、その場で足を止め、
 * 3秒後に「詰まった」と判定されて道のりごと捨てていた
 * (実機のログで [bear] 489行中 202行がこれだった)。
 *
 * @returns {boolean} 置き直したか
 */
export function advanceWaypoint(bear, rec) {
  if (!rec.finalTarget || !rec.waypoint) return false;
  if (arrived(bear, rec)) return false;            // 最終目標に着いている
  if (!reachedWaypoint(bear, rec)) return false;   // まだ途中の点に着いていない
  return setWaypoint(bear, rec, rec.finalTarget);
}

/**
 * 詰まっていないかを見る。1周期で STUCK_DIST も動かなければ1回、
 * STUCK_LIMIT 回続いたら「詰まった」とみなす。
 *
 * @param {boolean} holding 熊が**わざと**足を止めているか(略奪中・ドアを叩いている間・
 *   プレイヤーに張り付いている間)。動かないのが正しい場面まで数えると、
 *   仕事を終えて歩き出した瞬間に「詰まった」と言われて道のりが毎回捨てられる。
 * @returns {boolean} 詰まったか
 */
export function checkStuck(bear, rec, holding = false) {
  const now = bear.location;
  if (holding) {
    rec.stuck = 0;
    rec.lastPos = { x: now.x, y: now.y, z: now.z };
    return false;
  }
  if (rec.lastPos) {
    const moved = distXZ(rec.lastPos, now);
    if (moved < STUCK_DIST) rec.stuck = (rec.stuck ?? 0) + 1;
    else rec.stuck = 0;
  }
  rec.lastPos = { x: now.x, y: now.y, z: now.z };
  return (rec.stuck ?? 0) >= STUCK_LIMIT;
}

// ---------------------------------------------------------------------------
// 埋まった熊を助ける
// ---------------------------------------------------------------------------

/** 助け出した回数の合計(bear_status に出す)。 */
let rescueTotal = 0;
export function rescueCount() { return rescueTotal; }

/**
 * 詰まった熊がブロックに食い込んでいないか確かめ、食い込んでいれば近くの
 * 立てる場所へ移す。
 *
 * **動かない熊を片端から動かすのではない。** ただ立ち止まっているだけの熊まで
 * 移すと、地形を無視した瞬間移動になって「徘徊」に見えなくなる。
 * 体が本当にブロックの中にあるときだけ動かす。
 *
 * @returns {"off"|"free"|"moved"|"failed"}
 *   off … 設定で切ってある / free … 埋まっていない(何もしない)
 *   moved … 掘り出した / failed … 埋まっているが移す先が無い
 */
export function unstick(bear, rec) {
  if (!STUCK_RECOVER) return "off";
  if (!alive(bear)) return "off";
  if (!embeddedAt(bear.dimension, bear.location, BEAR_WIDTH, BEAR_HEIGHT)) {
    rec.buried = false;
    return "free";
  }
  const spot = freeSpot(bear.dimension, bear.location, STUCK_RESCUE_RANGE, BEAR_WIDTH);
  if (!spot) {
    rec.buried = true;
    return "failed";
  }
  const ok = tryDo("埋まった熊の救出", () => {
    bear.teleport(center(spot), { dimension: bear.dimension });
    return true;
  });
  if (!ok) {
    rec.buried = true;
    return "failed";
  }
  rescueTotal++;
  rec.rescues = (rec.rescues ?? 0) + 1;
  rec.buried = false;
  rec.stuck = 0;
  rec.lastPos = null;
  return "moved";
}

/**
 * 目印を片付ける。熊が死んだとき・消えたときに必ず呼ぶ。
 * rec.gone を立てるので、遅れて届く走査の返事もここで止まる。
 */
export function removeLure(rec) {
  rec.gone = true;
  if (rec.lure && alive(rec.lure)) {
    tryDo("目印の撤去", () => rec.lure.remove());
  }
  rec.lure = null;
  rec.lureId = null;
  rec.waypoint = null;
  rec.finalTarget = null;
}

/**
 * 世界に残っている迷子の目印を掃除する。
 * ワールドを強制終了したときなどに、飼い主のいない目印が残ることがある。
 */
export function sweepLures(dimension, ownedIds) {
  const list = tryDo("目印の掃除", () => dimension.getEntities({ type: LURE_TYPE })) ?? [];
  let removed = 0;
  for (const e of list) {
    if (!ownedIds.has(e.id)) {
      tryDo("迷子の目印を撤去", () => e.remove());
      removed++;
    }
  }
  return removed;
}
