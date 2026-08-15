/**
 * 机上試験 2: 実際の登録・攻撃・逃走・命令・重さ。
 *
 * main.js を本物のまま読み込む(＝実機と同じ登録の流れを通す)。
 *
 * 実行: node --import ./hook.mjs test_runtime.mjs
 */

import { sim } from "./mcstub.mjs";
import { ok, near, report } from "./assert.mjs";
import { BEAR_DAMAGE, SCAN_BUDGET, TICK_INTERVAL } from "../../behavior_packs/bear_bp/scripts/config.js";
import { makeRecord } from "../../behavior_packs/bear_bp/scripts/bear.js";
import { maybeBreakChest, isFood } from "../../behavior_packs/bear_bp/scripts/loot.js";
import { ItemStack } from "./mcstub.mjs";
import { seenPlayer, strongestSmell } from "../../behavior_packs/bear_bp/scripts/sense.js";

const dim = sim.dimension();
const G = sim.GROUND_Y;

// ブロックの読み取り回数を数える(1tickあたりの上限が守られているか)
let reads = 0;
let maxReads = 0;
const rawGetBlock = dim.getBlock.bind(dim);
dim.getBlock = (pos) => { reads++; return rawGetBlock(pos); };

// **main.js は読み込むだけで登録が走る。** ここが実機と同じ入口。
await import("../../behavior_packs/bear_bp/scripts/main.js");

const player = sim.spawnPlayer({ x: 0, y: G + 1, z: 0 });
sim.world.afterEvents.playerSpawn.emit({ player, initialSpawn: true });
sim.fire("bear:debug", "on", player);

ok(player.messages.length > 0, "起動のあいさつと命令の返事が届く");

// --- 1. /function bear_spawn で熊が出る ------------------------------------
sim.fire("bear:spawn", "2", player);
// **待つ時間はケチらない。** 目印は走査の返事が返ってから置かれる。
// 60tick では家探しの走査が終わりきらず、たまにだけ落ちる試験になっていた
// (家探しの上限を 6→12 に上げたぶん走査が長くなった)。
// たまに落ちる試験は、本物の不具合と見分けが付かないので置いておかない。
for (let t = 0; t < 200 && dim.getEntities({ type: "bear:lure" }).length === 0; t++) tick();
const bears = dim.getEntities({ type: "bear:bear" });
ok(bears.length === 2, `bear_spawn で2頭出た (${bears.length} 頭)`);
ok(dim.getEntities({ type: "bear:lure" }).length > 0, "誘導体(目印)が置かれた");

// --- 2. 攻撃は1〜3撃で倒れる ------------------------------------------------
// プレイヤーの真横に1頭置いて、倒れるまでの打撃数を数える
for (const b of dim.getEntities({ type: "bear:bear" })) b.remove();
const bear = dim.spawnEntity("bear:bear", { x: 2, y: G + 1, z: 0 });
let hits = 0;
sim.world.afterEvents.entityHitEntity.subscribe((ev) => {
  if (ev.damagingEntity?.typeId === "bear:bear") hits++;
});
player.health = 20;
// **プレイヤーは熊に張り付かせる。** 熊は湧いた直後から目印へ歩き出すので、
// 放っておくと、記録に登録される前に間合い(攻撃性が低い個体は8m)の外へ
// 出てしまい、たまにだけ一度も殴られない試験になる。
// ここで見たいのは「何撃で倒れるか」なので、距離の揺れは消す。
for (let t = 0; t < 400 && player.health > 0; t++) {
  player.teleport({ x: bear.location.x + 1.5, y: bear.location.y, z: bear.location.z });
  tick();
}
ok(hits >= BEAR_DAMAGE.minHits && hits <= BEAR_DAMAGE.maxHits,
  `プレイヤーは ${hits} 撃で倒れた(${BEAR_DAMAGE.minHits}〜${BEAR_DAMAGE.maxHits}撃)`);
ok(bear.nameTag.includes("攻撃"), `攻撃の状態になっている (名札: ${bear.nameTag || "なし"})`);

// --- 3. 遠距離攻撃で逃げる --------------------------------------------------
player.health = 20;
player.teleport({ x: 200, y: G + 1, z: 200 }); // 近くにいると攻撃が優先されるので離す
for (let t = 0; t < 40; t++) tick();
sim.shoot(bear, 12, player);
for (let t = 0; t < 40; t++) tick();
ok(bear.nameTag.includes("逃走"), `遠距離攻撃で逃走に入った (名札: ${bear.nameTag || "なし"})`);

// --- 4. 頭数を増やしても1tickの読み取り数が上限を超えない --------------------
// 家をいくつも建てて、10頭に一斉に家探しをさせる(いちばん重い状態)。
for (let h = 0; h < 6; h++) {
  const ox = 1000 + h * 40;
  for (let x = ox; x <= ox + 6; x++) {
    for (let z = 0; z <= 6; z++) {
      for (let y = G + 1; y <= G + 3; y++) {
        if (x === ox || x === ox + 6 || z === 0 || z === 6) {
          dim.__set({ x, y, z }, "minecraft:stone_bricks");
        }
      }
      dim.__set({ x, y: G + 4, z }, "minecraft:oak_planks");
    }
  }
  dim.__set({ x: ox + 3, y: G + 1, z: 0 }, "minecraft:oak_door");
  dim.__set({ x: ox + 3, y: G + 2, z: 0 }, "minecraft:oak_door");
  dim.__putChest({ x: ox + 3, y: G + 1, z: 3 }, [new ItemStack("minecraft:bread", 1)]);
}
player.teleport({ x: 1100, y: G + 1, z: -60 }); // 熊から離れて攻撃に入らせない
for (let i = 0; i < 10; i++) {
  dim.spawnEntity("bear:bear", { x: 1000 + i * 20, y: G + 1, z: -14 });
}
maxReads = 0;
for (let t = 0; t < 600; t++) tick();
const herd = dim.getEntities({ type: "bear:bear" }).length;
ok(herd >= 10, `10頭を同時に動かせた (${herd} 頭)`);
ok(maxReads <= SCAN_BUDGET + 300,
  `1tickのブロック読み取りは最大 ${maxReads} 個 (上限 ${SCAN_BUDGET} + 余裕300)`);
ok(maxReads > 100, `走査がちゃんと走っている (最大 ${maxReads} 個/tick)`);

// --- 5. /function bear_clear で片付く --------------------------------------
player.messages.length = 0;
sim.fire("bear:status", "", player);
ok(player.messages.some((m) => m.includes("熊AI")), "bear_status が答える");
sim.fire("bear:clear", "", player);
for (let t = 0; t < 20; t++) tick();
ok(dim.getEntities({ type: "bear:bear" }).length === 0, "bear_clear で熊が消えた");
ok(dim.getEntities({ type: "bear:lure" }).length === 0, "bear_clear で目印も消えた");

// --- 6. 食料の見分けと破壊確率 ----------------------------------------------
ok(isFood(new ItemStack("minecraft:bread")), "パンは食料");
ok(isFood(new ItemStack("minecraft:cooked_salmon")), "焼き鮭は食料");
ok(!isFood(new ItemStack("minecraft:diamond_sword")), "剣は食料でない");
ok(!isFood(new ItemStack("minecraft:iron_ingot")), "鉄は食料でない");

let broken = 0;
// **試行回数は余裕を持って取る。** 確率 0.3 を ±0.03 で見るなら、
// 2000回では散らばりが 1σ=0.010 あって 3σ に届いてしまい、
// 数十回に1回は「たまたま外れて」落ちる。落ちる試験は本物の不具合と
// 見分けが付かないので、6σ 相当まで回数を増やす(1σ=0.005)。
const N = 8000;
for (let i = 0; i < N; i++) {
  const pos = { x: 500 + (i % 40), y: G + 1, z: 500 + Math.floor(i / 40) };
  dim.__putChest(pos, [new ItemStack("minecraft:iron_ingot", 1)]);
  if (maybeBreakChest(dim, pos, 0.3)) broken++;
}
near(broken / N, 0.3, 0.03, "チェストの破壊確率は 30%");
// 壊したチェストの中身は消えずに床へこぼれる
ok(dim.droppedItems.length === broken, `壊した ${broken} 個ぶんの中身が床にこぼれた`);

// --- 7. 出せなかったときに、理由を隠さない ----------------------------------
// 実機で「コマンドは返るのに熊がいない」を出したときに、原因が
// 「場所が無い」なのか「定義が読めていない」なのか分からなかった反省から。
sim.fire("bear:clear", "", player);
player.teleport({ x: 5000, y: G + 1, z: 5000 });
for (let t = 0; t < 20; t++) tick();

// 7a. 湧かせ自体が断られる(熊の定義が読めていない)場合
sim.blockSpawn("bear:bear", "Failed to spawn entity bear:bear");
player.messages.length = 0;
sim.fire("bear:spawn", "1", player);
ok(dim.getEntities({ type: "bear:bear" }).length === 0, "断られたら1頭も出ない");
ok(player.messages.some((m) => m.includes("出せませんでした") && m.includes("bear:bear")),
  "断られた理由をそのまま出す");
ok(!player.messages.some((m) => m.includes("湧かせる場所が見つかりません")),
  "場所のせいにしない(原因を取り違えない)");
sim.allowSpawn("bear:bear");

// 7b. 周りに立てる場所が1つも無くても、足元には必ず出る
for (let x = 4950; x <= 5050; x++) {
  for (let z = 4950; z <= 5050; z++) {
    for (let y = G + 1; y <= G + 3; y++) dim.__set({ x, y, z }, "minecraft:stone");
  }
}
player.messages.length = 0;
sim.fire("bear:spawn", "1", player);
ok(dim.getEntities({ type: "bear:bear" }).length === 1, "離れた場所がだめでも足元に出る");
ok(player.messages.some((m) => m.includes("出しました")), "出せたことと座標を伝える");

// --- 8. 目印が出せないときは黙らない ----------------------------------------
// 目印が出ないと熊は行き先を持てず、その場をうろつくだけになる。
// 実機でこれが起きたのに、どこにも出ていなかった。
sim.blockSpawn("bear:lure", "Failed to spawn entity bear:lure");
for (let t = 0; t < 400; t++) tick();
player.messages.length = 0;
sim.fire("bear:status", "", player);
ok(player.messages.some((m) => m.includes("目印")),
  "目印が出せないことを bear_status で知らせる");
sim.allowSpawn("bear:lure");

// --- 目の前に出す(見えるかの確認用) ---------------------------------------
// **「そもそも熊が見当たらない」を潰すための命令。** bear_spawn は 28m 離すので、
// 湧いたかを目で確かめられない。here は目の前に出して、見分け方まで答える。
{
  const p = sim.spawnPlayer({ x: 5000, y: sim.GROUND_Y + 1, z: 5000 });
  p.view = { x: 0, y: 0, z: 1 };
  const before = dim.getEntities({ type: "bear:bear" }).length;
  sim.fire("bear:here", "", p);
  const after = dim.getEntities({ type: "bear:bear" }).length;
  ok(after === before + 1, `bear_here で1頭だけ出る (${after - before} 頭)`);

  const made = dim.getEntities({ type: "bear:bear" })
    .filter((b) => Math.hypot(b.location.x - 5000, b.location.z - 5000) < 8);
  ok(made.length === 1, "出た熊は目の前(8m以内)にいる");
  ok(made[0].nameTag !== "", `名札が付く (${made[0].nameTag})`);

  const msg = p.messages.join(" / ");
  ok(msg.includes("目の前に熊"), "出したことを座標付きで答える");
  ok(msg.includes("名札だけ見える"),
    "見えないときの見分け方(名札だけ見える=RPが効いていない)を答える");
}

// --- 視界と嗅覚 -------------------------------------------------------------
// **視界は壁を通らない。嗅覚は通る。** そこが分かれていないと
// 「家の中で焼肉していると熊が寄ってくる」が成立しない。
{
  const BX = 6000, BZ = 6000;
  const eye = dim.spawnEntity("bear:bear", { x: BX, y: G + 1, z: BZ });
  eye.view = { x: 0, y: 0, z: 1 };   // +z を向いている
  const recE = makeRecord(eye);

  // 正面 20m のプレイヤーは見える
  const front = sim.spawnPlayer({ x: BX, y: G + 1, z: BZ + 20 });
  ok(seenPlayer(eye, recE) === front, "正面のプレイヤーは見える");

  // 同じ距離でも**真後ろ**は見えない
  front.location = { x: BX, y: G + 1, z: BZ - 20 };
  ok(seenPlayer(eye, recE) === null, "真後ろのプレイヤーは見えない(視野角)");

  // 正面に戻して、間に壁を立てると見えなくなる
  front.location = { x: BX, y: G + 1, z: BZ + 20 };
  for (let y = G + 1; y <= G + 4; y++) {
    for (let x = BX - 2; x <= BX + 2; x++) dim.__set({ x, y, z: BZ + 10 }, "minecraft:stone");
  }
  ok(seenPlayer(eye, recE) === null, "壁の向こうのプレイヤーは見えない(見通し)");

  // 状態が上がると遠くまで見える
  for (let y = G + 1; y <= G + 4; y++) {
    for (let x = BX - 2; x <= BX + 2; x++) dim.__set({ x, y, z: BZ + 10 }, "minecraft:air");
  }
  front.location = { x: BX, y: G + 1, z: BZ + 60 };
  recE.alert = "calm";
  const calmSees = seenPlayer(eye, recE);
  recE.alert = "chase";
  const chaseSees = seenPlayer(eye, recE);
  ok(calmSees === null && chaseSees === front,
    `60m先は 通常では見えず 追跡なら見える (通常:${calmSees ? "見える" : "見えない"} / 追跡:${chaseSees ? "見える" : "見えない"})`);
  front.remove();

  // --- 嗅覚は壁を通る -------------------------------------------------------
  const NX = 6200, NZ = 6200;
  const nose = dim.spawnEntity("bear:bear", { x: NX, y: G + 1, z: NZ });
  nose.view = { x: 0, y: 0, z: 1 };
  const recN = makeRecord(nose);

  // 30m 先に「火の入ったかまど」を置き、その手前を壁で塞ぐ
  dim.__set({ x: NX, y: G + 1, z: NZ + 30 }, "minecraft:lit_furnace");
  for (let y = G + 1; y <= G + 4; y++) {
    for (let x = NX - 3; x <= NX + 3; x++) dim.__set({ x, y, z: NZ + 20 }, "minecraft:stone");
  }
  // ほかの熊が走査の枠(同時3本)を埋めていると、料理の走査が始められない。
  // ここで見たいのは匂いなので、先に片付ける。
  for (const b of dim.getEntities({ type: "bear:bear" })) {
    if (b !== nose && b !== eye) b.remove();
  }
  let smell = null;
  let asked = 0;
  for (let t = 30000; t < 31200; t++) {
    tick();
    if (t % TICK_INTERVAL === 0) {
      smell = strongestSmell(nose, recN, t);
      if (recN.cookingPending) asked++;
    }
    if (smell && smell.kind === "cooking") break;
  }
  ok(smell !== null && smell.kind === "cooking",
    `壁の向こうの料理の匂いが届く (${smell ? smell.kind : "何も嗅がない"} / 走査を頼んだ ${asked} 回)`);
  ok(seenPlayer(nose, recN) === null, "同じ場所でも姿は見えていない");

  // --- 匂いの強さで選ぶ -----------------------------------------------------
  // 近くの弱い匂い(人 強さ10)より、遠くの強い匂い(牛 強さ60)を選ぶ
  const SX = 6400, SZ = 6400;
  const pick = dim.spawnEntity("bear:bear", { x: SX, y: G + 1, z: SZ });
  const recP = makeRecord(pick);
  const near = sim.spawnPlayer({ x: SX + 6, y: G + 1, z: SZ });
  dim.spawnEntity("minecraft:cow", { x: SX + 20, y: G + 1, z: SZ });
  const got = strongestSmell(pick, recP, 40000);
  ok(got !== null && got.kind === "cow",
    `近くの人より 遠くの牛の匂いを選ぶ (${got ? got.kind : "null"})`);
  near.remove();
}

// --- 襲うときは本当に速いか -------------------------------------------------
// **突進が徘徊と大差ないと「襲われても速くならない」ように見える。**
// 数字の指定(config.js と bear.json)だけでなく、実際に進んだ距離で見る。
// 向きは問わない(進んだ量だけを比べる)。
{
  // 世界に残っている熊と目印を片付ける
  for (const e of dim.getEntities({ type: "bear:bear" })) e.remove();
  for (const e of dim.getEntities({ type: "bear:lure" })) e.remove();
  for (let t = 0; t < 60; t++) tick();

  // **物理だけ回す。** main.js を一緒に回すと、向こうが熊のモードを決め直して
  // しまい、突進を測っているつもりで徘徊を測ることになる(試験がたまに落ちた)。
  const travel = (bear, ticks) => {
    const from = { ...bear.location };
    for (let t = 0; t < ticks; t++) sim.step();
    return Math.hypot(bear.location.x - from.x, bear.location.z - from.z);
  };

  const SX = 9000, SZ = 9000;
  const walker = dim.spawnEntity("bear:bear", { x: SX, y: G + 1, z: SZ });
  const lure = dim.spawnEntity("bear:lure", { x: SX, y: G + 1, z: SZ + 80 });
  walker.triggerEvent("bear:mode_roam");
  const walked = travel(walker, 100);
  walker.remove();
  lure.remove();

  const charger = dim.spawnEntity("bear:bear", { x: SX + 400, y: G + 1, z: SZ });
  const target = sim.spawnPlayer({ x: SX + 400, y: G + 1, z: SZ + 80 });
  charger.triggerEvent("bear:mode_hunt");
  const charged = travel(charger, 100);

  ok(charged > walked * 1.4,
    `襲うときは徘徊よりはっきり速い (徘徊 ${walked.toFixed(1)}m / 突進 ${charged.toFixed(1)}m)`);
  target.remove();
  charger.remove();
}

report("動きの試験");

function tick() {
  reads = 0;
  sim.tick();
  if (reads > maxReads) maxReads = reads;
}
