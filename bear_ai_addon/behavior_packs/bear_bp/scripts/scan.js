/**
 * ブロック走査。**毎tickの全探索は禁止**なので、走査は必ずここを通して
 * 1tickあたりの読み取り数に上限をかけ、何tickかに分けて進める。
 *
 * 家探しは半径24×高さ8で約2万ブロックある。1tickで読むと確実に落ちる。
 * 近いところから順に読み、必要な数だけ見つかったら途中でやめる。
 */

import { SCAN_BUDGET, SCAN_JOBS_MAX } from "./config.js";
import { getBlock, topmost } from "./util.js";

/** 走査中の仕事。先頭から順に予算を分け合う。 */
const jobs = [];

/** 半径と間引きごとの「近い順の座標並び」。作るのが少し重いので使い回す。 */
const offsetCache = new Map();

function offsetsFor(radius, step) {
  const key = `${radius}:${step}`;
  const hit = offsetCache.get(key);
  if (hit) return hit;

  const list = [];
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const d2 = dx * dx + dz * dz;
      if (d2 > radius * radius) continue;
      list.push({ dx, dz, d2 });
    }
  }
  list.sort((a, b) => a.d2 - b.d2); // 近いところから読む
  offsetCache.set(key, list);
  return list;
}

/**
 * 走査を頼む。
 *
 * @param {object} spec
 *   dimension … 読む世界
 *   center    … 中心のブロック座標
 *   radius    … 水平の半径
 *   yFrom/yTo … 中心からの相対の高さの幅（mode:"column" のとき）
 *   step      … 間引き（1 なら全部、4 なら4ブロックおき）
 *   mode      … "column" 高さの幅を全部読む / "topmost" いちばん上だけ読む
 *   match     … (typeId, pos, block) => 真なら当たり
 *   limit     … 当たりがこの数に達したら打ち切る
 *   onDone    … (hits, aborted) => void  hits は近い順
 * @returns {object|null} 仕事。混み合っていて受け付けられなければ null
 */
export function requestScan(spec) {
  if (jobs.length >= SCAN_JOBS_MAX) return null;
  const job = {
    dimension: spec.dimension,
    center: spec.center,
    radius: spec.radius,
    yFrom: spec.yFrom ?? 0,
    yTo: spec.yTo ?? 0,
    step: spec.step ?? 1,
    mode: spec.mode ?? "column",
    match: spec.match,
    limit: spec.limit ?? 8,
    onDone: spec.onDone,
    offsets: offsetsFor(spec.radius, spec.step ?? 1),
    i: 0,
    y: null,
    hits: [],
    done: false,
    cancelled: false,
  };
  jobs.push(job);
  return job;
}

export function cancelScan(job) {
  if (!job) return;
  job.cancelled = true;
}

/** 今動いている走査の数。 */
export function activeJobs() {
  return jobs.length;
}

/**
 * 1tickぶん進める。main.js から毎tick呼ぶ。
 * 予算は全ての仕事で分け合う（頭数が増えても総量は増えない）。
 */
export function tick() {
  if (jobs.length === 0) return;

  let budget = SCAN_BUDGET;
  const share = Math.max(1, Math.floor(SCAN_BUDGET / jobs.length));

  for (let k = jobs.length - 1; k >= 0; k--) {
    const job = jobs[k];
    if (job.cancelled) {
      // **打ち切った仕事でも必ず返事をする。**
      // 黙って捨てると、頼んだ熊が返事を待ったまま永久に止まる(実機で踏んだ)。
      jobs.splice(k, 1);
      finish(job, true);
      continue;
    }
    let spent = 0;
    try {
      spent = step(job, Math.min(share, budget));
    } catch (e) {
      // 1か所でも読み取りに失敗したら、その仕事だけを畳む。
      // ここで外へ投げると main.js の毎tickの処理ごと止まり、MODが丸ごと死ぬ。
      console.warn(`[bear] 走査を打ち切った: ${e}`);
      jobs.splice(k, 1);
      finish(job, true);
      continue;
    }
    budget -= spent;
    if (job.done) {
      jobs.splice(k, 1);
      finish(job, false);
    }
    if (budget <= 0) break;
  }
}

function finish(job, aborted) {
  try {
    job.onDone?.(job.hits, aborted);
  } catch (e) {
    console.warn(`[bear] 走査の後始末で失敗: ${e}`);
  }
}

function step(job, budget) {
  let spent = 0;
  const { dimension, center } = job;

  while (spent < budget) {
    // 判定が失敗した仕事は、そこで読むのをやめる(残りを読んでも捨てるだけ)。
    // 返事は tick() が「打ち切り」として返す。
    if (job.cancelled) break;
    if (job.i >= job.offsets.length) {
      job.done = true;
      break;
    }
    const off = job.offsets[job.i];
    const x = center.x + off.dx;
    const z = center.z + off.dz;

    if (job.mode === "topmost") {
      const b = topmost(dimension, x, z);
      spent++;
      const read = readBlock(b, x, z);
      if (read && safeMatch(job, read.typeId, read.pos, b)) {
        job.hits.push({ pos: read.pos, typeId: read.typeId });
      }
      job.i++;
    } else {
      if (job.y === null) job.y = center.y + job.yFrom;
      const yEnd = center.y + job.yTo;
      while (job.y <= yEnd && spent < budget) {
        const pos = { x, y: job.y, z };
        const b = getBlock(dimension, pos);
        spent++;
        const id = typeIdOf(b);
        if (id !== null && safeMatch(job, id, pos, b)) job.hits.push({ pos, typeId: id });
        job.y++;
        if (job.hits.length >= job.limit) break;
      }
      if (job.y > yEnd) {
        job.y = null;
        job.i++;
      }
    }

    if (job.hits.length >= job.limit) {
      job.done = true;
      break;
    }
  }
  return spent;
}

/**
 * ブロックの名前を読む。**読み取りだけでも例外が飛ぶ**(読み込み範囲から外れた瞬間)。
 * 読めなければ null。
 */
function typeIdOf(block) {
  if (!block) return null;
  try {
    return block.typeId;
  } catch {
    return null;
  }
}

/** いちばん上のブロックの名前と位置。読めなければ null。 */
function readBlock(block, x, z) {
  if (!block) return null;
  try {
    return { typeId: block.typeId, pos: { x, y: block.location.y, z } };
  } catch {
    return null;
  }
}

function safeMatch(job, typeId, pos, block) {
  try {
    return job.match(typeId, pos, block);
  } catch (e) {
    console.warn(`[bear] 走査の判定で失敗: ${e}`);
    job.cancelled = true;
    return false;
  }
}
