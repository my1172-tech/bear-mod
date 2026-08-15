/**
 * 机上試験 3: **逆テスト**（起きてはいけないことが起きないか）。
 *
 * 「動いた」だけを見ると、実は条件を無視して常に動いているのに気づけない。
 * 水害MODでこれをやらずに実機で5件のバグを出した反省から、必ず逆も見る。
 *
 * 実行: node --import ./hook.mjs test_inverse.mjs
 */

import { sim, ItemStack } from "./mcstub.mjs";
import { ok, report } from "./assert.mjs";
import { makeRecord, setDebug, update, onHurt } from "../../behavior_packs/bear_bp/scripts/bear.js";
import { requestScan, tick as scanTick } from "../../behavior_packs/bear_bp/scripts/scan.js";
import { lootChest, maybeBreakChest } from "../../behavior_packs/bear_bp/scripts/loot.js";
import { breakDoor, breakWindow, windowOpening } from "../../behavior_packs/bear_bp/scripts/house.js";
import { checkStuck, setWaypoint, unstick } from "../../behavior_packs/bear_bp/scripts/nav.js";
import { embeddedAt, freeSpot } from "../../behavior_packs/bear_bp/scripts/util.js";
import {
  TICK_INTERVAL, ESCAPE_THRESHOLD, PENDING_TIMEOUT,
  BEAR_WIDTH, BEAR_HEIGHT, STUCK_LIMIT,
} from "../../behavior_packs/bear_bp/scripts/config.js";

const dim = sim.dimension();
const G = sim.GROUND_Y;
setDebug(false);

// --- 1. 食料が無いチェストには手を付けない ----------------------------------
const noFood = { x: 10, y: G + 1, z: 10 };
const c1 = dim.__putChest(noFood, [
  new ItemStack("minecraft:iron_ingot", 4),
  new ItemStack("minecraft:stick", 2),
]);
const r1 = lootChest(dim, noFood);
ok(r1 && r1.taken === 0, "食料が無ければ何も取らない");
ok(c1.slots.filter(Boolean).length === 2, "食料でない中身はそのまま残る");

// --- 2. 破壊確率 0 なら絶対に壊さない --------------------------------------
let broke = 0;
for (let i = 0; i < 300; i++) {
  const p = { x: 100 + i, y: G + 1, z: 100 };
  dim.__putChest(p, [new ItemStack("minecraft:iron_ingot", 1)]);
  if (maybeBreakChest(dim, p, 0)) broke++;
}
ok(broke === 0, `破壊確率0なら1つも壊れない (${broke} 個)`);
ok(dim.droppedItems.length === 0, "壊れていないので中身もこぼれない");

// --- 3. チェストが無い場所を壊そうとしても何も起きない ----------------------
ok(maybeBreakChest(dim, { x: 900, y: G + 1, z: 900 }, 1.0) === false,
  "チェストが無ければ壊さない（地面を消さない）");
ok(breakDoor(dim, { x: 900, y: G + 1, z: 900 }) === false,
  "ドアが無ければ壊さない（壁を消さない）");

// --- 4. しきい値以下のダメージでは逃げない ----------------------------------
const bear = dim.spawnEntity("bear:bear", { x: 0, y: G + 1, z: 0 });
const rec = makeRecord(bear);
rec.traits.bravery = 0.5; // 度胸をまん中に固定して、しきい値を決め打ちできるようにする
const limit = ESCAPE_THRESHOLD * (0.5 + rec.traits.bravery); // = 6
const fled = onHurt(bear, rec, "projectile", limit - 1, null, 100);
ok(fled === false, `しきい値(${limit})未満のダメージでは逃げない`);
const fled2 = onHurt(bear, rec, "projectile", 2, null, 100); // 累積で超える
ok(fled2 === true, "累積でしきい値を超えたら逃げる");

// --- 5. クリエイティブのプレイヤーは狙わない --------------------------------
const creative = sim.spawnPlayer({ x: 2, y: G + 1, z: 0 });
creative.gameMode = "creative";
const bear2 = dim.spawnEntity("bear:bear", { x: 0, y: G + 1, z: 0 });
const rec2 = makeRecord(bear2);
rec2.traits.aggression = 1.0; // いちばん好戦的な個体でも狙わないこと
for (let t = 1; t <= 60; t++) {
  scanTick();
  if (t % TICK_INTERVAL === 0) update(bear2, rec2, t);
}
ok(rec2.state !== "ATTACK", `クリエイティブのプレイヤーは狙わない (状態: ${rec2.state})`);

// サバイバルに変えたら狙う（＝上の判定が「常に狙わない」ではないことの確認）
creative.gameMode = "survival";
for (let t = 61; t <= 120; t++) {
  scanTick();
  if (t % TICK_INTERVAL === 0) update(bear2, rec2, t);
}
ok(rec2.state === "ATTACK", `サバイバルなら狙う (状態: ${rec2.state})`);

// --- 6. あさった場所は覚えていて二度は行かない ------------------------------
const twice = { x: 4, y: G + 1, z: 4 };
dim.__putChest(twice, [new ItemStack("minecraft:bread", 1)]);
const first = lootChest(dim, twice);
const second = lootChest(dim, twice);
ok(first.taken === 1 && second.taken === 0, "同じチェストから二度は取れない");

// --- 7. 走査が失敗しても、頼んだ側を待たせ続けない --------------------------
// 実機で「熊はいるのに何もしない」を出した原因。返事が来ないと熊は
// 行き先(目印)を持てないまま永久に待つ。
let answered = false;
let abortedFlag = null;
requestScan({
  dimension: dim, center: { x: 0, y: G + 1, z: 0 }, radius: 4, step: 1,
  mode: "topmost", limit: 4,
  match: () => { throw new Error("判定の中で失敗"); },
  onDone: (hits, aborted) => { answered = true; abortedFlag = aborted; },
});
for (let t = 0; t < 30; t++) scanTick();
ok(answered === true, "判定が失敗しても走査は必ず返事をする");
ok(abortedFlag === true, "打ち切りだったことも伝える");

// --- 8. ブロックが読めない場所でも走査の進行ごと落ちない --------------------
// 読み込み範囲から外れると、typeId を読むだけでも例外が飛ぶ。
const rawGetBlock = dim.getBlock.bind(dim);
dim.getBlock = () => ({
  get typeId() { throw new Error("読み込み範囲の外"); },
  get location() { throw new Error("読み込み範囲の外"); },
  isLiquid: false,
});
let answered2 = false;
requestScan({
  dimension: dim, center: { x: 700, y: G + 1, z: 700 }, radius: 3, step: 1,
  mode: "column", yFrom: -1, yTo: 1, limit: 4,
  match: () => true,
  onDone: () => { answered2 = true; },
});
let threw = false;
try {
  for (let t = 0; t < 60; t++) scanTick();
} catch {
  threw = true;
}
dim.getBlock = rawGetBlock;
ok(!threw, "ブロックが読めなくても走査の進行は落ちない");
ok(answered2 === true, "読めない場所ばかりでも返事は返る");

// --- 9. 返事が来なくても、熊は時間で待つのをやめて動き出す ------------------
const stuckBear = dim.spawnEntity("bear:bear", { x: 300, y: G + 1, z: 300 });
const recS = makeRecord(stuckBear);
recS.pending = true; // 返事が永久に来ない状態を作る
// 待ちを解いた回数(rec.stalls)で見る。**解いた直後に次の走査を頼んで
// pending が立ち直る**ので、フラグの観測では乱数で結果が揺れる。
let stalledAt = -1;
for (let t = 1; t <= PENDING_TIMEOUT + TICK_INTERVAL * 3; t++) {
  scanTick();
  if (t % TICK_INTERVAL !== 0) continue;
  update(stuckBear, recS, t);
  if (recS.stalls > 0 && stalledAt < 0) stalledAt = t;
}
ok(stalledAt > 0 && stalledAt <= PENDING_TIMEOUT + TICK_INTERVAL * 2,
  `返事が来なくても ${stalledAt}tick で待つのをやめる(上限 ${PENDING_TIMEOUT})`);
for (let t = PENDING_TIMEOUT + TICK_INTERVAL * 3; t < PENDING_TIMEOUT + 600; t++) {
  scanTick();
  if (t % TICK_INTERVAL === 0) update(stuckBear, recS, t);
}
ok(!!recS.finalTarget, "待つのをやめたあと、行き先を持てる");

// --- 10. 埋まっていない熊を勝手に動かさない ---------------------------------
// 「動かない＝救出」にすると、立ち止まっているだけの熊まで瞬間移動して
// 徘徊に見えなくなる。**体が本当にブロックの中にあるときだけ**動かすこと。
const openBear = dim.spawnEntity("bear:bear", { x: 400.5, y: G + 1, z: 400.5 });
const recO = makeRecord(openBear);
const beforeO = { ...openBear.location };
ok(embeddedAt(dim, openBear.location, BEAR_WIDTH, BEAR_HEIGHT) === false,
  "開けた場所の熊は「埋まっている」と判定されない");
ok(unstick(openBear, recO) === "free", "埋まっていない熊は救出の対象にしない");
ok(openBear.location.x === beforeO.x && openBear.location.z === beforeO.z,
  "埋まっていない熊は1ブロックも動かさない");

// --- 11. ブロックに食い込んだ熊は掘り出す ------------------------------------
// 実機で「詰まって動けない・地面に埋まっている」と見えた症状の側。
const buried = { x: 500, y: G + 1, z: 500 };
dim.__set({ x: buried.x, y: buried.y, z: buried.z }, "minecraft:stone");
dim.__set({ x: buried.x, y: buried.y + 1, z: buried.z }, "minecraft:stone");
const buriedBear = dim.spawnEntity("bear:bear", { x: buried.x + 0.5, y: buried.y, z: buried.z + 0.5 });
const recB = makeRecord(buriedBear);
ok(embeddedAt(dim, buriedBear.location, BEAR_WIDTH, BEAR_HEIGHT) === true,
  "石の中に立っている熊は「埋まっている」と分かる");
ok(unstick(buriedBear, recB) === "moved", "埋まった熊は掘り出す");
ok(embeddedAt(dim, buriedBear.location, BEAR_WIDTH, BEAR_HEIGHT) === false,
  "掘り出した先はブロックの中ではない");
ok(Math.abs(buriedBear.location.x - (buried.x + 0.5)) <= 4
  && Math.abs(buriedBear.location.z - (buried.z + 0.5)) <= 4,
  "掘り出す先は近く（遠くへ飛ばさない）");

// --- 12. 助け出せないときに、でたらめな場所へ飛ばさない ----------------------
// 地中深くは四方すべてが土。逃げ場が無いので「失敗」と答えるのが正しい。
// ここで無理に動かすと、熊が地面をすり抜けて現れることになる。
const deep = { x: 600.5, y: G - 20, z: 600.5 };
const deepBear = dim.spawnEntity("bear:bear", deep);
const recD = makeRecord(deepBear);
ok(freeSpot(dim, deep, 3, BEAR_WIDTH) === null, "土の中には立てる場所が無い");
ok(unstick(deepBear, recD) === "failed", "助け出せないときは失敗と答える");
ok(deepBear.location.x === deep.x && deepBear.location.y === deep.y,
  "助け出せないなら動かさない");
ok(recD.buried === true, "動けない熊は印を残す（bear_status に出す）");

// --- 13. 地面の高さが測れない場所に目印を置かない ----------------------------
// 目標の高さをそのまま使うと、目印が地中に沈む/空中に浮く。地中の目印には
// 熊が永久に届かず、壁に体を押しつけたまま「詰まった」を出し続ける。
const farBear = dim.spawnEntity("bear:bear", { x: 0.5, y: G + 1, z: 800.5 });
const recF = makeRecord(farBear);
const rawGet2 = dim.getBlock.bind(dim);
const rawTop2 = dim.getTopmostBlock.bind(dim);
dim.getBlock = (p) => (p.x >= 30 ? undefined : rawGet2(p));
dim.getTopmostBlock = (p) => (p.x >= 30 ? undefined : rawTop2(p));
const placed = setWaypoint(farBear, recF, { x: 400, y: G + 1, z: 800 });
dim.getBlock = rawGet2;
dim.getTopmostBlock = rawTop2;
ok(placed === false, "途中の地面の高さが測れないときは目印を置かない");
ok(!recF.finalTarget, "測れなかった行き先を「置けた」ことにしない");

// --- 14. わざと止まっている間は「詰まった」と数えない ------------------------
// 略奪中・ドアを叩いている間・プレイヤーに張り付いている間は動かないのが正しい。
// ここを数えると、仕事を終えて歩き出した瞬間に道のりが毎回捨てられる。
const holdBear = dim.spawnEntity("bear:bear", { x: 700.5, y: G + 1, z: 700.5 });
const recH = makeRecord(holdBear);
for (let i = 0; i < STUCK_LIMIT * 3; i++) checkStuck(holdBear, recH, true);
ok(recH.stuck === 0 && checkStuck(holdBear, recH, true) === false,
  `わざと止まっている間は ${STUCK_LIMIT * 3} 周期動かなくても詰まり扱いしない`);
// 逆に、ふつうに歩いているつもりで動かなければ詰まり扱いになること
let becameStuck = false;
for (let i = 0; i < STUCK_LIMIT + 2; i++) {
  if (checkStuck(holdBear, recH, false)) becameStuck = true;
}
ok(becameStuck === true, "同じ熊でも、止まる理由が無ければ詰まりと分かる");

// --- 15. 窓の開口は「ガラス＋上下1段」より広げない -------------------------
// **ここが唯一、ガラス以外を壊す場所。** 広げすぎると家が崩れるので、
// 上下1段・全体3段までに収まっていることを機械で見張る。
{
  const BX = 800, BZ = 800;
  // ふつうの家の窓: ガラス1段(地面から3段目 = G+3)。上下は壁。
  for (let y = G + 1; y <= G + 6; y++) dim.__set({ x: BX, y, z: BZ }, "minecraft:stone_bricks");
  dim.__set({ x: BX, y: G + 3, z: BZ }, "minecraft:light_blue_stained_glass");

  const open = windowOpening(dim, { x: BX, y: G + 3, z: BZ });
  ok(open !== null, "ガラス1段のふつうの窓でも入口になる");
  ok(open.y === G + 2 && open.height === 3,
    `開口はガラスの上下1段まで (${open ? `${open.y - G}段目から${open.height}段` : "null"})`);

  breakWindow(dim, { x: BX, y: G + 3, z: BZ }, open);
  ok(dim.__typeAt({ x: BX, y: G + 2, z: BZ }) === "minecraft:air"
    && dim.__typeAt({ x: BX, y: G + 3, z: BZ }) === "minecraft:air"
    && dim.__typeAt({ x: BX, y: G + 4, z: BZ }) === "minecraft:air",
    "ガラスと上下1段が抜けて3段の穴になる");
  ok(dim.__typeAt({ x: BX, y: G + 1, z: BZ }) === "minecraft:stone_bricks",
    "**足元の壁は残る**(床に穴を開けない)");
  ok(dim.__typeAt({ x: BX, y: G + 5, z: BZ }) === "minecraft:stone_bricks",
    "**2段以上は広げない**");

  // ガラス張りのビル: ガラスが延々と続いても、開ける穴は3段まで
  const TX = 820, TZ = 820;
  for (let y = G + 1; y <= G + 40; y++) dim.__set({ x: TX, y, z: TZ }, "minecraft:blue_stained_glass");
  const tall = windowOpening(dim, { x: TX, y: G + 5, z: TZ });
  ok(tall !== null && tall.height <= 3,
    `ガラス張りでも穴は3段まで (${tall ? tall.height : "null"} 段)`);

  // 岩盤は壊さない
  const RX = 830, RZ = 830;
  dim.__set({ x: RX, y: G + 1, z: RZ }, "minecraft:bedrock");
  dim.__set({ x: RX, y: G + 2, z: RZ }, "minecraft:glass");
  breakWindow(dim, { x: RX, y: G + 2, z: RZ }, { y: G + 1, height: 2 });
  ok(dim.__typeAt({ x: RX, y: G + 1, z: RZ }) === "minecraft:bedrock", "岩盤は壊さない");

  // 地下の窓は入口にしない
  const UX = 840, UZ = 840;
  dim.__set({ x: UX, y: G - 5, z: UZ }, "minecraft:glass");
  ok(windowOpening(dim, { x: UX, y: G - 5, z: UZ }) === null,
    "地面より下の窓は入口にしない");
}

report("逆テスト");
