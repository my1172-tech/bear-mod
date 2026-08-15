/**
 * 個体特性。熊1頭ごとに湧いたときに決まり、その熊が死ぬまで変わらない。
 *
 * 値はすべて 0.0〜1.0。熊本体の dynamic property に保存するので、
 * ワールドを閉じて開き直しても同じ性格のままになる。
 */

import { TRAITS, TRAIT_SPREAD } from "./config.js";
import { clamp } from "./util.js";

const PROP = "bear:traits";

/** 0.5 を中心に TRAIT_SPREAD の幅で振る。1.0 なら 0〜1 の一様乱数。 */
function roll() {
  return clamp(0.5 + (Math.random() - 0.5) * 2 * TRAIT_SPREAD, 0, 1);
}

export function makeTraits() {
  const t = {};
  for (const name of TRAITS) t[name] = Math.round(roll() * 100) / 100;
  return t;
}

/**
 * その熊の特性を返す。まだ無ければ作って保存する。
 * 保存は文字列(JSON)。dynamic property は数値・文字列・真偽しか持てない。
 */
export function traitsOf(bear) {
  try {
    const raw = bear.getDynamicProperty(PROP);
    if (typeof raw === "string") {
      const t = JSON.parse(raw);
      // 版が上がって特性が増えたときに、足りないぶんだけ足す
      let patched = false;
      for (const name of TRAITS) {
        if (typeof t[name] !== "number") {
          t[name] = Math.round(roll() * 100) / 100;
          patched = true;
        }
      }
      if (patched) bear.setDynamicProperty(PROP, JSON.stringify(t));
      return t;
    }
  } catch {
    /* 壊れていたら作り直す */
  }
  const t = makeTraits();
  try {
    bear.setDynamicProperty(PROP, JSON.stringify(t));
  } catch (e) {
    console.warn(`[bear] 特性の保存に失敗: ${e}`);
  }
  return t;
}

/** 人が読む用の一行。/function bear_status で出す。 */
export function traitLine(t) {
  return (
    `攻撃性${bar(t.aggression)} 度胸${bar(t.bravery)} 空腹${bar(t.hunger)} ` +
    `食料${bar(t.foodSeeking)} 市街${bar(t.urbanPreference)}`
  );
}

/** 0〜1 を全角の棒にする。半角を混ぜると桁が崩れるので全角だけを使う。 */
function bar(v) {
  const n = Math.round(clamp(v, 0, 1) * 5);
  return "■".repeat(n) + "□".repeat(5 - n);
}

/**
 * 「1〜3撃で倒す」の撃数を特性から決める。
 * 攻撃性が高いほど少ない撃数(＝一撃が重い)。
 */
