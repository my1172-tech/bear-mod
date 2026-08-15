/**
 * 机上試験 2: 実際の登録・攻撃・逃走・命令・重さ。
 *
 * main.js を本物のまま読み込む(＝実機と同じ登録の流れを通す)。
 *
 * 実行: node --import ./hook.mjs test_runtime.mjs
 */

import { sim } from "./mcstub.mjs";
import { ok, near, report } from "./assert.mjs";
import { BEAR_DAMAGE, SCAN_BUDGET } from "../../behavior_packs/bear_bp/scripts/config.js";
import { maybeBreakChest, isFood } from "../../behavior_packs/bear_bp/scripts/loot.js";
import { ItemStack } from "./mcstub.mjs";

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
for (let t = 0; t < 400 && player.health > 0; t++) tick();
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
const N = 2000;
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

report("動きの試験");

function tick() {
  reads = 0;
  sim.tick();
  if (reads > maxReads) maxReads = reads;
}
