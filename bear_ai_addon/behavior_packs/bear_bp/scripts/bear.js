/**
 * 熊1頭の頭の中。状態機械はここだけにある。
 *
 *   IDLE → PATROL → SEARCH_HOUSE → ENTER_HOUSE → SEARCH_CHEST → LOOT
 *                 ↘ ATTACK ↘ ESCAPE → RETURN → PATROL
 *
 * 優先順位(高いほうが割り込む):
 *   ESCAPE > ATTACK > LOOT > ENTER_HOUSE > SEARCH_HOUSE > PATROL
 *
 * 1周期は TICK_INTERVAL(既定10tick)。**毎tickは走らせない。**
 * ブロック走査は scan.js に頼み、返事が来るまで待つ(rec.pending)。
 */

import {
  ARRIVE_DIST, BEAR_DAMAGE, BREAK_CHANCE, CHEST_BLOCKS, CHEST_RANGE, CHEST_SCAN_Y, DAMAGE_MEMORY,
  DOOR_BREAK_CHANCE, DOOR_BREAK_TIME, ESCAPE_DISTANCE, ESCAPE_MELEE_THRESHOLD, ESCAPE_THRESHOLD,
  ESCAPE_TIME, HOME_RANGE, HOUSE_RANGE, LEG_TIMEOUT, LOOTED_MEMORY, LOOTED_MEMORY_MAX, LOOT_TIME,
  PENDING_TIMEOUT, TICK_INTERVAL, DEBUG_NAMETAG, LOG_REPEAT_INTERVAL, STUCK_REPLAN_WAIT,
  WINDOW_BREAK_TIME,
} from "./config.js";
import {
  breakDoor, breakWindow, doorStillThere, frontPoint, insidePoint, isLockedDoor, lowerDoor,
  windowFront, windowInside, windowOpening, windowStillThere,
} from "./house.js";
import { lootChest, maybeBreakChest } from "./loot.js";
import { advanceWaypoint, arrived, checkStuck, setWaypoint, unstick } from "./nav.js";
import { findTarget, fleePoint, isDoor, pickRoute, randomPoint, routeOf } from "./routes.js";
import { requestScan } from "./scan.js";
import { traitsOf } from "./traits.js";
import { alive, chance, clamp, distXZ, tryDo, typeIdAt } from "./util.js";

export const STATES = [
  "IDLE", "PATROL", "SEARCH_HOUSE", "ENTER_HOUSE", "SEARCH_CHEST", "LOOT",
  "ATTACK", "ESCAPE", "RETURN",
];

/** 人に見せる状態名。 */
export const STATE_LABEL = {
  IDLE: "待機", PATROL: "徘徊", SEARCH_HOUSE: "家探し", ENTER_HOUSE: "侵入",
  SEARCH_CHEST: "物色", LOOT: "略奪", ATTACK: "攻撃", ESCAPE: "逃走", RETURN: "復帰",
};

const CHEST_SET = new Set(CHEST_BLOCKS);

let debug = false;
export function setDebug(v) { debug = v; }
export function isDebug() { return debug; }

function log(rec, msg) {
  if (!debug) return;
  console.warn(`[bear:${String(rec.id).slice(-4)}] ${msg}`);
}

/**
 * 何周期も続く事情のログ。**同じ札(tag)は LOG_REPEAT_INTERVAL おきにしか出さない。**
 *
 * 詰まった熊は毎周期(0.5秒)同じことを言い続ける。実機で「詰まって動けないと
 * いっぱい出る」と見えたのはこれで、たった数頭でもログが埋まって
 * 本当に見たい行が流れてしまう。
 */
function logEvery(rec, now, tag, msg) {
  if (!debug) return;
  if (!rec.logAt) rec.logAt = {};
  const last = rec.logAt[tag];
  if (last !== undefined && now - last < LOG_REPEAT_INTERVAL) return;
  rec.logAt[tag] = now;
  console.warn(`[bear:${String(rec.id).slice(-4)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 記録の作成
// ---------------------------------------------------------------------------

export function makeRecord(bear) {
  const traits = traitsOf(bear);
  const route = pickRoute(traits);
  return {
    id: bear.id,
    traits,
    route,
    legIndex: 0,
    state: "IDLE",
    stateTick: 0,
    mode: null,
    home: {
      x: Math.floor(bear.location.x),
      y: Math.floor(bear.location.y),
      z: Math.floor(bear.location.z),
    },
    lure: null,
    lureId: null,
    waypoint: null,
    finalTarget: null,
    legTick: 0,
    stuck: 0,
    lastPos: null,
    buried: false,
    rescues: 0,
    knownDoors: [],
    looted: new Map(),
    targetDoor: null,
    entryKind: "door",
    opening: null,
    targetChest: null,
    pending: false,
    pendingTick: 0,
    stalls: 0,
    hurt: { projectile: 0, melee: 0, at: 0 },
    fleeUntil: 0,
    lastAttack: 0,
    stolen: 0,
    breakCount: 0,
    housesEntered: 0,
  };
}

/** 「もうあさった」を覚える。数が増えすぎないよう古いものから忘れる。 */
function remember(rec, pos, now) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  rec.looted.set(key, now + LOOTED_MEMORY);
  if (rec.looted.size > LOOTED_MEMORY_MAX) {
    const oldest = rec.looted.keys().next().value;
    rec.looted.delete(oldest);
  }
}

function forget(rec, now) {
  for (const [key, until] of rec.looted) {
    if (until <= now) rec.looted.delete(key);
  }
}

function looted(rec, pos) {
  return rec.looted.has(`${pos.x},${pos.y},${pos.z}`);
}

// ---------------------------------------------------------------------------
// 見た目の切り替え(BPの component_group)
// ---------------------------------------------------------------------------

/**
 * 熊のAIの型を切り替える。
 *   roam  … 目印を追う(徘徊・移動全般)
 *   hunt  … プレイヤーを狙って殴る
 *   flee  … 目印を追う(速い)
 *   still … 何も狙わない(その場で足を止める)
 */
function setMode(bear, rec, mode) {
  if (rec.mode === mode) return;
  const ok = tryDo("AIの切り替え", () => {
    bear.triggerEvent(`bear:mode_${mode}`);
    return true;
  });
  if (ok) rec.mode = mode;
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

function go(bear, rec, state, why = "") {
  if (rec.state === state) return;
  log(rec, `${rec.state} → ${state}${why ? ` (${why})` : ""}`);
  rec.state = state;
  rec.stateTick = 0;
  if (DEBUG_NAMETAG && debug) {
    tryDo("名札", () => {
      bear.nameTag = `${STATE_LABEL[state] ?? state} / ${routeOf(rec.route).label}`;
    });
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 1頭ぶんの1周期。main.js が TICK_INTERVAL ごとに呼ぶ。
 * @param {Entity} bear
 * @param {object} rec
 * @param {number} now 現在のtick
 */
export function update(bear, rec, now) {
  rec.stateTick += TICK_INTERVAL;
  rec.legTick += TICK_INTERVAL;
  forget(rec, now);

  // 走査の返事を待ったまま固まらないようにする。
  // 返事が来ない理由(読み込み範囲から外れた・走査が打ち切られた)はこちらから
  // 分からないので、**時間で必ず待つのをやめる**。
  if (rec.pending) {
    rec.pendingTick = (rec.pendingTick ?? 0) + TICK_INTERVAL;
    if (rec.pendingTick > PENDING_TIMEOUT) {
      log(rec, "走査の返事が来ないので待つのをやめる");
      rec.pending = false;
      rec.pendingTick = 0;
      rec.stalls = (rec.stalls ?? 0) + 1;
    }
  } else {
    rec.pendingTick = 0;
  }

  // 受けたダメージの記憶は時間で薄れる
  if (rec.hurt.at && now - rec.hurt.at > DAMAGE_MEMORY) {
    rec.hurt.projectile = 0;
    rec.hurt.melee = 0;
  }

  // **わざと止まっている間は「詰まった」と数えない。**
  // 略奪中・ドアを叩いている間・プレイヤーに張り付いている間は、動かないのが正しい。
  const holding = rec.mode === "still" || rec.state === "ATTACK";
  let stuck = checkStuck(bear, rec, holding);

  // 詰まったら、まず**本当にブロックの中に食い込んでいないか**を見る。
  // 食い込んでいれば掘り出す。食い込んでいなければ触らない(道のりの引き直しだけ)。
  if (stuck) {
    const r = unstick(bear, rec);
    if (r === "moved") {
      logEvery(rec, now, "buried", "ブロックに食い込んでいたので掘り出した");
      rec.waypoint = null;
      rec.finalTarget = null;
      stuck = false;
    } else if (r === "failed") {
      logEvery(rec, now, "buried", "ブロックに食い込んでいるが、助け出せる場所が近くに無い");
    }
  }

  // 遠い行き先は、目印を置き直しながら区間で繋いでいく。
  // **ここが無いと、途中の目印に着いた熊はその場で止まる。**
  if (rec.state !== "ATTACK" && advanceWaypoint(bear, rec)) {
    logEvery(rec, now, "leg", "次の区間へ目印を進めた");
    stuck = false;
  }

  // --- 優先順位1: 逃走 ----------------------------------------------------
  if (rec.fleeUntil > now) {
    if (rec.state !== "ESCAPE") startEscape(bear, rec, now);
    escapeTick(bear, rec, now, stuck);
    return;
  }
  if (rec.state === "ESCAPE") {
    go(bear, rec, "RETURN", "逃げ切った");
    planReturn(bear, rec);
    return;
  }

  // --- 優先順位2: 攻撃 ----------------------------------------------------
  const prey = findPrey(bear, rec);
  if (prey) {
    if (rec.state !== "ATTACK") {
      rec.resume = rec.state;
      go(bear, rec, "ATTACK", "プレイヤーを見つけた");
    }
    setMode(bear, rec, "hunt");
    rec.lastPrey = now;
    return;
  }
  if (rec.state === "ATTACK") {
    // 相手が見えなくなってしばらくしたら元の仕事に戻る
    if (now - (rec.lastPrey ?? 0) > 60) {
      const back = rec.resume && rec.resume !== "ATTACK" ? rec.resume : "PATROL";
      go(bear, rec, back, "見失った");
      rec.pending = false;
      rec.waypoint = null;
      rec.finalTarget = null;
    } else {
      return;
    }
  }

  // --- 縄張りから離れすぎたら戻る -----------------------------------------
  if (rec.state !== "RETURN" && distXZ(bear.location, rec.home) > HOME_RANGE) {
    go(bear, rec, "RETURN", "縄張りから出すぎた");
    planReturn(bear, rec);
    return;
  }

  switch (rec.state) {
    case "IDLE": go(bear, rec, "PATROL", "動き出す"); patrolTick(bear, rec, now, stuck); break;
    case "PATROL": patrolTick(bear, rec, now, stuck); break;
    case "SEARCH_HOUSE": searchHouseTick(bear, rec, now); break;
    case "ENTER_HOUSE": enterHouseTick(bear, rec, now, stuck); break;
    case "SEARCH_CHEST": searchChestTick(bear, rec, now); break;
    case "LOOT": lootTick(bear, rec, now); break;
    case "RETURN": returnTick(bear, rec, now, stuck); break;
    default: go(bear, rec, "PATROL", "未知の状態"); break;
  }
}

// ---------------------------------------------------------------------------
// PATROL … 徘徊
// ---------------------------------------------------------------------------

function patrolTick(bear, rec, now, stuck) {
  setMode(bear, rec, "roam");

  if (rec.pending) return; // 走査の返事待ち

  const legs = routeOf(rec.route).legs;
  const kind = legs[rec.legIndex % legs.length];

  // 行き先がまだ無い、着いた、詰まった、時間切れ → 次の道のりへ
  const needNew =
    !rec.finalTarget ||
    arrived(bear, rec) ||
    rec.legTick > LEG_TIMEOUT ||
    stuck;

  if (!needNew) return;

  if (rec.finalTarget && arrived(bear, rec)) {
    // 着いた先が「家」なら、そこから家探しに入る
    rec.legIndex++;
    if (kind === "house") {
      go(bear, rec, "SEARCH_HOUSE", "家の近くに着いた");
      return;
    }
    // 空腹・食料優先が高い個体は、道中でも家を探しはじめる
    const appetite = (rec.traits.hunger + rec.traits.foodSeeking) / 2;
    if (chance(appetite * 0.5)) {
      go(bear, rec, "SEARCH_HOUSE", "腹が減った");
      return;
    }
  } else if (stuck) {
    // 詰まったままの熊が毎周期(0.5秒)引き直すと、その熊が走査の枠を占領して
    // ほかの熊まで動かなくなる。間隔を空ける。
    if (now < (rec.replanAt ?? 0)) return;
    rec.replanAt = now + STUCK_REPLAN_WAIT;
    // **数字を出す。** 「詰まった」だけでは、目印が遠すぎるのか・目印が消えたのか・
    // 本当に壁に阻まれているのかが実機で見分けられない(前回それで一往復した)。
    const toWp = rec.waypoint ? Math.round(distXZ(bear.location, rec.waypoint)) : -1;
    const toGoal = rec.finalTarget ? Math.round(distXZ(bear.location, rec.finalTarget)) : -1;
    const lure = rec.lure && alive(rec.lure) ? "目印○" : "目印×";
    logEvery(rec, now, "stuck",
      `詰まったので道のりを引き直す (目印まで${toWp}m 行き先まで${toGoal}m ${lure})`);
    rec.legIndex++;
  } else if (rec.legTick > LEG_TIMEOUT) {
    log(rec, "時間切れで道のりを引き直す");
    rec.legIndex++;
  }

  planLeg(bear, rec, now);
}

/** 次の道のりの行き先を探して、目印を置く。 */
function planLeg(bear, rec, now) {
  const legs = routeOf(rec.route).legs;
  const kind = legs[rec.legIndex % legs.length];
  rec.pending = true;

  const started = findTarget(bear, rec, kind, (pos) => {
    rec.pending = false;
    if (rec.gone || !alive(bear)) return; // 返事が届く前に消えた熊
    const goal = pos ?? randomPoint(bear);
    if (!goal) return; // 次の周期でやり直す
    if (!setWaypoint(bear, rec, goal)) return;
    log(rec, `道のり ${kind} → ${goal.x},${goal.y},${goal.z}`);
  });

  if (!started) rec.pending = false; // 走査が混み合っていた。次の周期で出し直す
}

// ---------------------------------------------------------------------------
// SEARCH_HOUSE … 家(ドア)を探す
// ---------------------------------------------------------------------------

function searchHouseTick(bear, rec, now) {
  setMode(bear, rec, "roam");
  if (rec.pending) return;

  if (rec.stateTick > 400) {
    go(bear, rec, "PATROL", "家が見つからない");
    return;
  }

  rec.pending = true;
  // 市街地志向が高い個体ほど広く探す(=町に踏み込む)
  const radius = Math.round(clamp(HOUSE_RANGE * (0.7 + rec.traits.urbanPreference * 0.6), 8, 32));

  const started = findTarget(bear, rec, "house", (pos) => {
    rec.pending = false;
    if (rec.gone || !alive(bear)) return; // 返事が届く前に消えた熊
    if (!pos) {
      go(bear, rec, "PATROL", "家が無い");
      return;
    }
    if (looted(rec, pos)) {
      go(bear, rec, "PATROL", "もうあさった家");
      return;
    }
    rec.entryKind = pos.kind === "window" ? "window" : "door";
    rec.doorPlan = null;
    rec.opening = null;

    if (rec.entryKind === "window") {
      // 窓は「入れる窓」だけを入口にする。腰高窓は覗けても入れない。
      const opening = windowOpening(bear.dimension, pos);
      if (!opening) {
        remember(rec, pos, now); // 入れない窓は覚えて、次から同じ窓を狙わない
        go(bear, rec, "PATROL", "入れない窓だった");
        return;
      }
      rec.targetDoor = { x: pos.x, y: opening.y, z: pos.z };
      rec.opening = opening;
      const front = windowFront(bear.dimension, rec.targetDoor);
      if (front && setWaypoint(bear, rec, front)) {
        go(bear, rec, "ENTER_HOUSE", "窓を見つけた");
      }
      return;
    }

    // ドアは上下2ブロック。基準は必ず下半分に揃える(上だと中の判定が全部外れる)
    rec.targetDoor = lowerDoor(bear.dimension, pos);
    const front = frontPoint(bear.dimension, rec.targetDoor);
    if (setWaypoint(bear, rec, front)) {
      go(bear, rec, "ENTER_HOUSE", "ドアを見つけた");
    }
  }, { radius });
  if (!started) rec.pending = false;
}

// ---------------------------------------------------------------------------
// ENTER_HOUSE … ドアを開ける / 壊して入る
// ---------------------------------------------------------------------------

function enterHouseTick(bear, rec, now, stuck) {
  const door = rec.targetDoor;
  if (!door) {
    go(bear, rec, "PATROL", "ドアを見失った");
    return;
  }
  setMode(bear, rec, "roam");
  if (rec.entryKind === "window") {
    enterWindowTick(bear, rec, now, stuck);
    return;
  }

  const d = distXZ(bear.location, door);

  // ドアの前まで来た
  if (d <= 2.5) {
    const id = typeIdAt(bear.dimension, door);
    const gone = id === null ? false : !isDoor(id);

    // 開けるか壊すかは、そのドアに着いたときに**一度だけ**決める。
    // 毎周期くじを引くと、待っているうちに必ず壊すことになってしまう。
    if (!rec.doorPlan) {
      const breaks = isLockedDoor(id) || chance(DOOR_BREAK_CHANCE * (0.5 + rec.traits.aggression));
      rec.doorPlan = breaks ? "break" : "open";
      rec.doorSince = rec.stateTick;
      log(rec, rec.doorPlan === "break" ? "ドアを壊しにかかる" : "ドアを開けて入る");
    }

    if (!gone && (rec.doorPlan === "break" || stuck)) {
      // 叩き壊すには時間がかかる。詰まっているときは待たずに壊す
      if (rec.stateTick - (rec.doorSince ?? 0) < DOOR_BREAK_TIME && !stuck) {
        setMode(bear, rec, "still"); // 叩いている間は足を止める
        return;
      }
      if (breakDoor(bear.dimension, door)) {
        log(rec, "ドアを壊した");
        rec.breakCount++;
      }
    }
    // 壊さないときはバニラのAIがドアを開けて通る(behavior.open_door)

    const inside = insidePoint(bear.dimension, door);
    if (inside) {
      if (setWaypoint(bear, rec, inside)) {
        rec.insidePos = inside;
        rec.housesEntered++;
        go(bear, rec, "SEARCH_CHEST", "中へ入る");
      }
    } else {
      // 中が分からない家(小屋・門など)。ドアの前でチェストを探す
      go(bear, rec, "SEARCH_CHEST", "中が分からないので周りを探す");
    }
    return;
  }

  if (rec.stateTick > LEG_TIMEOUT || (stuck && d > 6)) {
    remember(rec, door, now); // 届かない家は覚えて次から避ける
    go(bear, rec, "PATROL", "ドアに届かない");
    return;
  }

  // まだ遠い。ドアが他の熊に壊されていたら追いかけるのをやめる
  if (!doorStillThere(bear.dimension, door) && rec.stateTick > 60) {
    go(bear, rec, "PATROL", "ドアが無くなった");
  }
}

/**
 * 窓から入る。
 *
 * ドアと違って「開ける」選択肢は無い。**割るしかない。**
 * ただし割るのは**ガラスだけ**で、壁は1ブロックも壊さない
 * (入れる高さに開かない窓は SEARCH_HOUSE の時点で弾いてある)。
 */
function enterWindowTick(bear, rec, now, stuck) {
  const win = rec.targetDoor;
  const d = distXZ(bear.location, win);

  if (d <= 2.5) {
    const stillGlass = windowStillThere(bear.dimension, win, rec.opening);

    if (stillGlass) {
      // 叩き割るのに少し時間をかける(一瞬で消えると割った感じが出ない)。
      // 詰まっているときは待たずに割る。
      if (rec.windowSince === undefined) {
        rec.windowSince = rec.stateTick;
        log(rec, "窓を割りにかかる");
      }
      if (rec.stateTick - rec.windowSince < WINDOW_BREAK_TIME && !stuck) {
        setMode(bear, rec, "still"); // 叩いている間は足を止める
        return;
      }
      if (breakWindow(bear.dimension, win, rec.opening)) {
        log(rec, "窓を割った");
        rec.breakCount++;
      }
    }

    const inside = windowInside(bear.dimension, win);
    if (inside) {
      if (setWaypoint(bear, rec, inside)) {
        rec.insidePos = inside;
        rec.housesEntered++;
        go(bear, rec, "SEARCH_CHEST", "窓から入る");
      }
    } else {
      // 中が分からない建物。窓の外でチェストを探す
      go(bear, rec, "SEARCH_CHEST", "中が分からないので周りを探す");
    }
    return;
  }

  if (rec.stateTick > LEG_TIMEOUT || (stuck && d > 6)) {
    remember(rec, win, now); // 届かない窓は覚えて次から避ける
    go(bear, rec, "PATROL", "窓に届かない");
  }
}

// ---------------------------------------------------------------------------
// SEARCH_CHEST … 家の中のチェストを探す
// ---------------------------------------------------------------------------

function searchChestTick(bear, rec, now) {
  setMode(bear, rec, "roam");
  if (rec.pending) return;

  if (rec.stateTick > 600) {
    if (rec.targetDoor) remember(rec, rec.targetDoor, now);
    go(bear, rec, "PATROL", "チェストが見つからない");
    return;
  }

  const range = Math.round(CHEST_RANGE * (0.8 + rec.traits.urbanPreference * 0.8));
  rec.pending = true;
  const job = requestScan({
    dimension: bear.dimension,
    center: {
      x: Math.floor(bear.location.x),
      y: Math.floor(bear.location.y),
      z: Math.floor(bear.location.z),
    },
    radius: clamp(range, 8, 32),
    yFrom: CHEST_SCAN_Y.from, yTo: CHEST_SCAN_Y.to, step: 1, mode: "column", limit: 4,
    match: (id, pos) => CHEST_SET.has(id) && !looted(rec, pos),
    onDone: (hits) => {
      rec.pending = false;
      if (rec.gone || !alive(bear)) return; // 返事が届く前に消えた熊
      if (hits.length === 0) {
        if (rec.targetDoor) remember(rec, rec.targetDoor, now);
        go(bear, rec, "PATROL", "チェストが無い");
        return;
      }
      rec.targetChest = hits[0].pos;
      if (setWaypoint(bear, rec, rec.targetChest)) {
        log(rec, `チェスト ${rec.targetChest.x},${rec.targetChest.y},${rec.targetChest.z}`);
      }
      go(bear, rec, "LOOT", "チェストを見つけた");
    },
  });
  if (!job) rec.pending = false;
}

// ---------------------------------------------------------------------------
// LOOT … 略奪
// ---------------------------------------------------------------------------

function lootTick(bear, rec, now) {
  const chest = rec.targetChest;
  if (!chest) {
    go(bear, rec, "SEARCH_CHEST", "チェストを見失った");
    return;
  }

  const d = distXZ(bear.location, chest);
  if (d > ARRIVE_DIST + 1) {
    setMode(bear, rec, "roam");
    if (rec.stateTick > LEG_TIMEOUT) {
      remember(rec, chest, now);
      go(bear, rec, "PATROL", "チェストに届かない");
    }
    return;
  }

  // 目の前まで来た。あさっている間は足を止める
  setMode(bear, rec, "still");
  if (rec.stateTick < LOOT_TIME) return;

  const result = lootChest(bear.dimension, chest);
  if (result === null) return; // まだ読めない。次の周期で

  rec.stolen += result.taken;
  if (result.taken > 0) {
    log(rec, `食料を ${result.taken} 個 持ち去った (${result.kinds.join(",")})`);
    // 食べたぶん空腹が収まる
    rec.traits.hunger = clamp(rec.traits.hunger - 0.1 * result.taken, 0, 1);
  }

  // 壊すかどうか。攻撃性が高い個体ほど壊す
  const p = BREAK_CHANCE * (0.6 + rec.traits.aggression * 0.8);
  if (maybeBreakChest(bear.dimension, chest, clamp(p, 0, 1))) {
    log(rec, "チェストを壊した");
    rec.breakCount++;
  }

  remember(rec, chest, now);
  rec.targetChest = null;
  go(bear, rec, "SEARCH_CHEST", "次のチェストへ");
}

// ---------------------------------------------------------------------------
// ATTACK … 攻撃(狙いと殴りはバニラのAI、打撃力は main.js の当たり判定で足す)
// ---------------------------------------------------------------------------

/** 狙う相手を返す。攻撃性が高いほど遠くから寄ってくる。 */
function findPrey(bear, rec) {
  const reach = 8 + rec.traits.aggression * 16; // 8〜24ブロック
  const players = tryDo("プレイヤーの検索", () =>
    bear.dimension.getPlayers({ location: bear.location, maxDistance: reach })
  ) ?? [];
  let best = null;
  let bestD = Infinity;
  for (const p of players) {
    if (!alive(p)) continue;
    // クリエイティブ/観戦は狙わない
    const mode = tryDo("モードの取得", () => p.getGameMode?.());
    if (mode === "creative" || mode === "spectator") continue;
    const d = distXZ(bear.location, p.location);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/**
 * その熊が1撃で上乗せするダメージ。
 *
 * 「1〜3撃で倒れる」を相手の最大体力から逆算する。攻撃性が高い個体ほど少ない撃数
 * (＝一撃が重い)。bear.json の minecraft:attack が 1 を先に与えているので、
 * その1を差し引いた残りをスクリプトが足す。
 */
export function attackDamage(rec, player) {
  const hp = tryDo("体力の取得", () => player.getComponent("minecraft:health")?.effectiveMax) ?? 20;
  const span = BEAR_DAMAGE.maxHits - BEAR_DAMAGE.minHits;
  const hits = clamp(Math.round(BEAR_DAMAGE.minHits + span * (1 - rec.traits.aggression)), 1, 10);
  return Math.max(1, Math.ceil(hp / hits) - 1);
}

/** 個体ごとの「何撃で倒すか」。表示用。 */
export function hitsOf(rec) {
  const span = BEAR_DAMAGE.maxHits - BEAR_DAMAGE.minHits;
  return clamp(Math.round(BEAR_DAMAGE.minHits + span * (1 - rec.traits.aggression)), 1, 10);
}

// ---------------------------------------------------------------------------
// ESCAPE … 逃走
// ---------------------------------------------------------------------------

/**
 * ダメージを受けたときの判断。main.js の entityHurt から呼ぶ。
 * @param {string} kind "projectile" | "melee"
 * @returns {boolean} 逃走に入ったか
 */
export function onHurt(bear, rec, kind, amount, source, now) {
  rec.hurt[kind] = (rec.hurt[kind] ?? 0) + amount;
  rec.hurt.at = now;

  // 度胸が高いほど我慢する
  const guts = 0.5 + rec.traits.bravery;
  const limit = kind === "projectile" ? ESCAPE_THRESHOLD * guts : ESCAPE_MELEE_THRESHOLD * guts;

  if (rec.hurt[kind] > limit) {
    rec.fleeFrom = source ? { ...source.location } : { ...bear.location };
    rec.fleeUntil = now + ESCAPE_TIME;
    return true;
  }
  return false;
}

function startEscape(bear, rec, now) {
  go(bear, rec, "ESCAPE", "痛手を負った");
  setMode(bear, rec, "flee");
  const from = rec.fleeFrom ?? bear.location;
  const to = fleePoint(bear, from, ESCAPE_DISTANCE);
  if (to) setWaypoint(bear, rec, to);
  tryDo("うなり声", () => bear.dimension.playSound("mob.polarbear.warning", bear.location));
}

function escapeTick(bear, rec, now, stuck) {
  setMode(bear, rec, "flee");
  if (!rec.finalTarget || arrived(bear, rec) || stuck) {
    const from = rec.fleeFrom ?? bear.location;
    const to = fleePoint(bear, from, ESCAPE_DISTANCE);
    if (to) setWaypoint(bear, rec, to);
  }
}

// ---------------------------------------------------------------------------
// RETURN … 縄張りへ戻る
// ---------------------------------------------------------------------------

function planReturn(bear, rec) {
  setMode(bear, rec, "roam");
  rec.hurt.projectile = 0;
  rec.hurt.melee = 0;
  setWaypoint(bear, rec, rec.home);
}

function returnTick(bear, rec, now, stuck) {
  setMode(bear, rec, "roam");
  if (distXZ(bear.location, rec.home) <= ARRIVE_DIST + 2) {
    go(bear, rec, "PATROL", "縄張りに戻った");
    rec.legIndex++;
    return;
  }
  if (!rec.finalTarget || arrived(bear, rec) || stuck || rec.legTick > LEG_TIMEOUT) {
    setWaypoint(bear, rec, rec.home);
  }
}
