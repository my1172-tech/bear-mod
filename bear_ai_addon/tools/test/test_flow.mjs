/**
 * 机上試験 1: 徘徊 → 家侵入 → 物色 → 略奪 の筋道。
 *
 * **本物の scripts/*.js をそのまま読み込んで動かす。** 写しは作らない。
 * 経路探索と物理は偽物(mcstub.mjs)なので、ここで見ているのは
 * 「状態が期待どおりに進むか」「食料だけを取るか」だけ。
 *
 * 実行: node --import ./hook.mjs test_flow.mjs
 */

import { sim, ItemStack } from "./mcstub.mjs";
import { makeRecord, setDebug, update } from "../../behavior_packs/bear_bp/scripts/bear.js";
import { tick as scanTick } from "../../behavior_packs/bear_bp/scripts/scan.js";
import { setWaypoint } from "../../behavior_packs/bear_bp/scripts/nav.js";
import { distXZ } from "../../behavior_packs/bear_bp/scripts/util.js";
import {
  TICK_INTERVAL, WAYPOINT_MAX, STUCK_LIMIT,
} from "../../behavior_packs/bear_bp/scripts/config.js";
import { fail, ok, report } from "./assert.mjs";

const dim = sim.dimension();
const G = sim.GROUND_Y; // 63

// --- 家をひとつ建てる -------------------------------------------------------
// 30..36 四方、高さ 64..66、屋根 67。南(z=30)の真ん中にドア。
for (let x = 30; x <= 36; x++) {
  for (let z = 30; z <= 36; z++) {
    for (let y = G + 1; y <= G + 3; y++) {
      const wall = x === 30 || x === 36 || z === 30 || z === 36;
      if (wall) dim.__set({ x, y, z }, "minecraft:stone_bricks");
    }
    dim.__set({ x, y: G + 4, z }, "minecraft:oak_planks"); // 屋根
  }
}
dim.__set({ x: 33, y: G + 1, z: 30 }, "minecraft:oak_door");
dim.__set({ x: 33, y: G + 2, z: 30 }, "minecraft:oak_door");

// 中にチェスト。食料と、食料でないものを混ぜる。
const chestPos = { x: 33, y: G + 1, z: 34 };
const chest = dim.__putChest(chestPos, [
  new ItemStack("minecraft:bread", 3),
  new ItemStack("minecraft:diamond_sword", 1),
  new ItemStack("minecraft:cooked_beef", 5),
  new ItemStack("minecraft:iron_ingot", 12),
]);

// --- 熊を1頭 ---------------------------------------------------------------
const bear = dim.spawnEntity("bear:bear", { x: 33, y: G + 1, z: 18 });
setDebug(false);
const rec = makeRecord(bear);
rec.route = "D"; // 食料型(家→家→家)に固定して、道草を無くす

const seen = new Set();
let lootedAt = -1;

for (let t = 1; t <= 4000; t++) {
  scanTick();
  if (t % TICK_INTERVAL === 0) update(bear, rec, t);
  sim.tick();
  seen.add(rec.state);
  if (rec.stolen > 0 && lootedAt < 0) lootedAt = t;
  if (lootedAt > 0 && t > lootedAt + 100) break;
}

// --- 確かめる ---------------------------------------------------------------
ok(seen.has("PATROL"), "徘徊した");
ok(seen.has("SEARCH_HOUSE"), "家を探した");
ok(seen.has("ENTER_HOUSE"), "家に侵入した");
ok(seen.has("SEARCH_CHEST"), "チェストを物色した");
ok(seen.has("LOOT"), "略奪に入った");
ok(rec.stolen >= 8, `食料を持ち去った (${rec.stolen} 個)`);

// 食料だけを取ったか。取られていないものは、チェストの中か床のどちらかに残る。
const leftInChest = chest.slots.filter(Boolean).map((s) => s.typeId);
const onFloor = dim.droppedItems.map((d) => d.item.typeId);
const remaining = [...leftInChest, ...onFloor];
ok(remaining.includes("minecraft:diamond_sword"), "食料でない剣は残っている");
ok(remaining.includes("minecraft:iron_ingot"), "食料でない鉄は残っている");
ok(!remaining.includes("minecraft:bread"), "パンは持ち去られた");
ok(!remaining.includes("minecraft:cooked_beef"), "ステーキは持ち去られた");

// 目印(誘導体)が世界に溜まっていないか
const lures = dim.getEntities({ type: "bear:lure" });
ok(lures.length <= 1, `目印は1頭につき1つ (${lures.length} 個)`);

if (lootedAt < 0) fail("略奪までたどり着かなかった");

// --- 遠い行き先まで、区間を繋いで歩き通せるか -------------------------------
// 目印は WAYPOINT_MAX より遠くへ置けない。**その先へ置き直さないと、熊は
// 途中の目印に着いた時点で止まる。** 実機ではこれが「詰まった」の 4 割だった。
// 「1区間ぶん歩けた」だけでは見つからないので、**目印より遠い行き先**で見る。
const far = dim.spawnEntity("bear:bear", { x: 2000, y: G + 1, z: 2000 });
const recFar = makeRecord(far);
const goal = { x: 2000 + WAYPOINT_MAX * 4, y: G + 1, z: 2000 };
ok(setWaypoint(far, recFar, goal), "遠い行き先に目印を置けた");

const firstWp = { ...recFar.waypoint };
ok(Math.round(distXZ({ x: 2000, z: 2000 }, firstWp)) <= WAYPOINT_MAX + 1,
  `最初の目印は ${WAYPOINT_MAX}m 以内に置かれる (${Math.round(distXZ({ x: 2000, z: 2000 }, firstWp))}m)`);

const wpSeen = new Set([`${firstWp.x},${firstWp.z}`]);
let stuckSeen = 0;
for (let t = 5000; t <= 9000; t++) {
  scanTick();
  if (t % TICK_INTERVAL === 0) {
    update(far, recFar, t);
    if (recFar.waypoint) wpSeen.add(`${recFar.waypoint.x},${recFar.waypoint.z}`);
    if ((recFar.stuck ?? 0) >= STUCK_LIMIT) stuckSeen++;
  }
  sim.tick();
  if (distXZ(far.location, goal) <= 3) break;
}
const left = Math.round(distXZ(far.location, goal));
ok(wpSeen.size >= 2, `途中で目印を置き直した (${wpSeen.size} か所)`);
ok(left <= 6, `目印より遠い行き先まで歩き通せた (残り ${left}m)`);
ok(stuckSeen === 0, `道中で詰まらなかった (詰まり ${stuckSeen} 回)`);

// --- 窓から入る（ドアが1枚も無い家） -------------------------------------
// PLATEAUの都市ワールドはこれ。**ドアだけを入口にすると一生入れない。**
// 生成側の作りに合わせて 2段窓(地面から2・3段目がガラス)の家を建てる。
{
  const BX = 300, BZ = 300;
  for (let x = BX; x <= BX + 6; x++) {
    for (let z = BZ; z <= BZ + 6; z++) {
      for (let y = G + 1; y <= G + 4; y++) {
        const wall = x === BX || x === BX + 6 || z === BZ || z === BZ + 6;
        if (wall) dim.__set({ x, y, z }, "minecraft:stone_bricks");
      }
      dim.__set({ x, y: G + 5, z }, "minecraft:oak_planks"); // 屋根
    }
  }
  // 南面の真ん中に**ガラス1段のふつうの窓**(地面から3段目)。
  // 生成側の55%はこの形。ガラスだけを割ると穴が1段で通れないので、
  // 熊が窓枠ごと上下1段を押し広げて入れることを見る。
  const wx = BX + 3, wz = BZ;
  dim.__set({ x: wx, y: G + 3, z: wz }, "minecraft:light_blue_stained_glass");

  const wchest = { x: BX + 3, y: G + 1, z: BZ + 4 };
  const wc = dim.__putChest(wchest, [
    new ItemStack("minecraft:bread", 2),
    new ItemStack("minecraft:iron_ingot", 4),
  ]);

  const wbear = dim.spawnEntity("bear:bear", { x: BX + 3, y: G + 1, z: BZ - 10 });
  const wrec = makeRecord(wbear);
  wrec.route = "D"; // 家→家→家

  const wseen = new Set();
  let wlooted = -1;
  for (let t = 20000; t <= 26000; t++) {
    scanTick();
    if (t % TICK_INTERVAL === 0) update(wbear, wrec, t);
    sim.tick();
    wseen.add(wrec.state);
    if (wrec.stolen > 0 && wlooted < 0) wlooted = t;
    if (wlooted > 0 && t > wlooted + 100) break;
  }

  ok(wseen.has("ENTER_HOUSE"), "ドアが無くても入口(窓)を見つけた");
  ok(wrec.entryKind === "window" || wseen.has("SEARCH_CHEST"),
    `窓を入口として扱った (${wrec.entryKind})`);
  const holeOpen =
    dim.__typeAt({ x: wx, y: G + 2, z: wz }) === "minecraft:air" &&
    dim.__typeAt({ x: wx, y: G + 3, z: wz }) === "minecraft:air" &&
    dim.__typeAt({ x: wx, y: G + 4, z: wz }) === "minecraft:air";
  ok(holeOpen, "ガラス1段の窓を上下に押し広げて3段の穴にした");

  // **壊れたのは窓の柱だけ。** ほかの壁に手を出していないこと。
  let wallLost = 0;
  for (let x = BX; x <= BX + 6; x++) {
    for (let z = BZ; z <= BZ + 6; z++) {
      const wall = x === BX || x === BX + 6 || z === BZ || z === BZ + 6;
      if (!wall) continue;
      for (let y = G + 1; y <= G + 4; y++) {
        if (x === wx && z === wz) continue; // 窓の柱
        if (dim.__typeAt({ x, y, z }) !== "minecraft:stone_bricks") wallLost++;
      }
    }
  }
  ok(wallLost === 0, `窓の柱以外の壁は無傷 (${wallLost} 個)`);
  ok(dim.__typeAt({ x: wx, y: G + 1, z: wz }) === "minecraft:stone_bricks",
    "窓の柱でも、足元の壁は残る");
  ok(wrec.stolen >= 2, `窓から入って食料を持ち去った (${wrec.stolen} 個)`);
  // 取られなかったものは、チェストの中か床のどちらかに残る(壊されるとこぼれる)
  const stillThere = [
    ...wc.slots.filter(Boolean).map((s) => s.typeId),
    ...dim.droppedItems.map((d) => d.item.typeId),
  ];
  ok(stillThere.includes("minecraft:iron_ingot"), "食料でない鉄は残っている");
}

// --- 窓のある家を2軒つづけて破る -------------------------------------------
// **1軒目だけ入れて2軒目で固まる**、という壊れ方をしていた。
// 窓を叩き始めた時刻を熊が持ちっぱなしで、次の窓では「まだ叩き足りない」と
// 判定され続け、足を止めたまま動かなくなる(状態が変わると時計が0に戻るため)。
{
  // 2軒を探索半径(最大32)の中に置く。離しすぎると「見つけられない」で落ちて
  // しまい、見たいこと(2軒目でも窓を割れるか)が試験できない。
  const houses = [{ x: 400, z: 400 }, { x: 400, z: 420 }];
  const wins = [];
  for (const h of houses) {
    for (let x = h.x; x <= h.x + 6; x++) {
      for (let z = h.z; z <= h.z + 6; z++) {
        for (let y = G + 1; y <= G + 4; y++) {
          const wall = x === h.x || x === h.x + 6 || z === h.z || z === h.z + 6;
          if (wall) dim.__set({ x, y, z }, "minecraft:stone_bricks");
        }
        dim.__set({ x, y: G + 5, z }, "minecraft:oak_planks");
      }
    }
    const wx = h.x + 3, wz = h.z;
    dim.__set({ x: wx, y: G + 3, z: wz }, "minecraft:light_blue_stained_glass");
    dim.__putChest({ x: h.x + 3, y: G + 1, z: h.z + 4 },
      [new ItemStack("minecraft:bread", 2)]);
    wins.push({ x: wx, z: wz });
  }

  const b2 = dim.spawnEntity("bear:bear", { x: 403, y: G + 1, z: 390 });
  const r2 = makeRecord(b2);
  r2.route = "D"; // 家→家→家
  for (let t = 40000; t <= 52000; t++) {
    scanTick();
    if (t % TICK_INTERVAL === 0) update(b2, r2, t);
    sim.tick();
  }

  const broken = wins.filter((w) =>
    dim.__typeAt({ x: w.x, y: G + 3, z: w.z }) === "minecraft:air").length;
  ok(broken === 2, `2軒とも窓を破った (${broken} / 2軒)`);
  ok(r2.housesEntered >= 2, `2軒とも中へ入った (${r2.housesEntered} 軒)`);
}

report("流れの試験");
