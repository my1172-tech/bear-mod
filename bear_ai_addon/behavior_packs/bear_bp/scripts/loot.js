/**
 * チェストの略奪。
 *
 * 熊は持ち物を持てないので、**食料は取り出してその場で無くなる**(食べた／
 * くわえて持ち去った、という扱い)。食料以外には手を付けない。
 * チェストを壊すときは、残っている中身を床にこぼしてから壊す
 * (壊すついでに他人の道具を消してしまうのは「食料のみ略奪」に反する)。
 */

import {
  BREAK_CHANCE, BROKEN_BLOCK, CHEST_BLOCKS, FOOD_ITEMS, FOOD_COMPONENT_PROBE, LOOT_STACKS,
} from "./config.js";
import { chance, tryDo, typeIdAt } from "./util.js";

const CHEST = new Set(CHEST_BLOCKS);
const FOOD = new Set(FOOD_ITEMS);

/** minecraft:food の部品が使える版か。起動時に1度だけ試す。 */
let foodComponentUsable = null;

export function isChest(typeId) {
  return CHEST.has(typeId);
}

/**
 * 食べ物か。
 *
 * 一覧(FOOD_ITEMS)で判定するのが基本。版によっては ItemStack から
 * minecraft:food の部品が読めるので、読めるなら一覧に無い食べ物も拾える。
 * **部品が使えるかどうかを推測しない**。1度試して、使えたときだけ使う。
 */
export function isFood(stack) {
  if (!stack) return false;
  if (FOOD.has(stack.typeId)) return true;

  if (FOOD_COMPONENT_PROBE) {
    if (foodComponentUsable === null) {
      foodComponentUsable = false;
      try {
        stack.getComponent("minecraft:food");
        foodComponentUsable = true;
      } catch {
        foodComponentUsable = false;
      }
      console.warn(`[bear] minecraft:food 部品は${foodComponentUsable ? "使える" : "使えない"}`);
    }
    if (foodComponentUsable) {
      try {
        if (stack.getComponent("minecraft:food")) return true;
      } catch {
        /* この品では読めなかっただけ。一覧の判定に任せる */
      }
    }
  }
  return false;
}

function containerAt(dimension, pos) {
  const block = tryDo("チェストを開く", () => dimension.getBlock(pos));
  if (!block) return null;
  return tryDo("中身の取得", () => block.getComponent("minecraft:inventory")?.container) ?? null;
}

/**
 * チェストから食料だけを取り出す。
 *
 * @returns {{taken:number, kinds:string[], emptied:boolean}|null}
 *   null は「まだ読めない(未読み込み)」。呼び出し側は待って再試行する。
 */
export function lootChest(dimension, pos) {
  const id = typeIdAt(dimension, pos);
  if (id === null) return null;
  if (!isChest(id)) return { taken: 0, kinds: [], emptied: true };

  const container = containerAt(dimension, pos);
  if (!container) return null;

  let taken = 0;
  let stacks = 0;
  const kinds = [];
  for (let i = 0; i < container.size && stacks < LOOT_STACKS; i++) {
    const item = tryDo("スロットの読み取り", () => container.getItem(i));
    if (!item || !isFood(item)) continue;
    taken += item.amount ?? 1;
    stacks++;
    if (!kinds.includes(item.typeId)) kinds.push(item.typeId);
    tryDo("食料の持ち去り", () => container.setItem(i, undefined));
  }

  if (taken > 0) {
    tryDo("あさる音", () =>
      dimension.playSound("random.chestopen", { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 })
    );
  }
  return { taken, kinds, emptied: isEmpty(container) };
}

function isEmpty(container) {
  for (let i = 0; i < container.size; i++) {
    const item = tryDo("スロットの読み取り", () => container.getItem(i));
    if (item) return false;
  }
  return true;
}

/**
 * 確率でチェストを壊す。壊す前に残りの中身を床へこぼす。
 * @returns {boolean} 壊したか
 */
export function maybeBreakChest(dimension, pos, chanceOverride = null) {
  const p = chanceOverride ?? BREAK_CHANCE;
  if (!chance(p)) return false;

  const id = typeIdAt(dimension, pos);
  if (id === null || !isChest(id)) return false;

  const container = containerAt(dimension, pos);
  if (container) {
    const spill = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    for (let i = 0; i < container.size; i++) {
      const item = tryDo("スロットの読み取り", () => container.getItem(i));
      if (!item) continue;
      tryDo("中身をこぼす", () => {
        dimension.spawnItem(item, spill);
        container.setItem(i, undefined);
      });
    }
  }

  const ok = tryDo("チェストの破壊", () => {
    dimension.getBlock(pos).setType(BROKEN_BLOCK);
    return true;
  });
  if (ok) {
    tryDo("破壊音", () =>
      dimension.playSound("mob.zombie.woodbreak", { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 })
    );
  }
  return !!ok;
}
