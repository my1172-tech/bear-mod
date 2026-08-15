/**
 * 熊AI の入口。
 *
 * ここがやること:
 *   ・世界にいる熊を見つけて記録を持つ
 *   ・1周期(TICK_INTERVAL)ごとに、頭数を分けて bear.update() を回す
 *   ・殴った/殴られたの当たり判定を受けて、打撃力の上乗せと逃走の判断をする
 *   ・/function から来る命令(scriptevent)に答える
 *
 * 熊の考え方そのものは bear.js にある。ここには置かない。
 */

import { system, world } from "@minecraft/server";
import {
  ATTACK_COOLDOWN, ATTACK_IGNORE_ARMOR, BEARS_PER_TICK, BEAR_TYPE, BEAR_WIDTH, DEBUG_DEFAULT,
  MAX_BEARS, SPAWN_COUNT, SPAWN_DISTANCE, TICK_INTERVAL, VERSION,
} from "./config.js";
import {
  STATE_LABEL, attackDamage, hitsOf, isDebug, makeRecord, onHurt, setDebug, update,
} from "./bear.js";
import { lureProblem, removeLure, rescueCount, sweepLures } from "./nav.js";
import { routeOf } from "./routes.js";
import { activeJobs, tick as scanTick } from "./scan.js";
import { traitLine } from "./traits.js";
import { alive, distXZ, groundY, hasExit, isStandable, randRange, tryDo } from "./util.js";

/** 熊の記録。鍵は entity.id。 */
const bears = new Map();

/** 次にどの熊から面倒を見るか。頭数が多いときに順番が偏らないようにする。 */
let cursor = 0;

/** 熊を探し直す間隔(tick)。 */
const DISCOVER_INTERVAL = 40;

let tickCount = 0;

// ---------------------------------------------------------------------------
// 熊を見つける
// ---------------------------------------------------------------------------

function dimensionsInUse() {
  const dims = new Map();
  const overworld = tryDo("世界の取得", () => world.getDimension("minecraft:overworld"));
  if (overworld) dims.set(overworld.id, overworld);
  for (const p of world.getAllPlayers()) {
    if (alive(p)) dims.set(p.dimension.id, p.dimension);
  }
  return [...dims.values()];
}

function discover() {
  const seen = new Set();
  for (const dim of dimensionsInUse()) {
    const list = tryDo("熊の検索", () => dim.getEntities({ type: BEAR_TYPE })) ?? [];
    for (const bear of list) {
      if (!alive(bear)) continue;
      seen.add(bear.id);
      const known = bears.get(bear.id);
      if (known) {
        known.entity = bear; // 実体は毎回引き直す。持ち越すと消えた実体を触る
      } else {
        const rec = makeRecord(bear);
        rec.entity = bear;
        bears.set(bear.id, rec);
        if (isDebug()) console.warn(`[bear] 新しい熊 ${bear.id.slice(-4)} ルート${rec.route}`);
      }
    }
  }

  // 読み込み範囲から消えた熊は、記録ごと片付ける(目印を残さない)
  for (const [id, rec] of bears) {
    if (!seen.has(id)) {
      removeLure(rec);
      bears.delete(id);
    }
  }

  enforceLimit();

  // 飼い主のいない目印を掃除する
  const owned = new Set();
  for (const rec of bears.values()) if (rec.lureId) owned.add(rec.lureId);
  for (const dim of dimensionsInUse()) sweepLures(dim, owned);
}

/**
 * 頭数の上限。自然湧きで増えすぎると、走査も経路探索も一気に重くなる。
 * 上限を超えたぶんは、**プレイヤーからいちばん遠い熊**から消す
 * (目の前で消えると不自然なので)。
 */
function enforceLimit() {
  if (bears.size <= MAX_BEARS) return;
  const players = world.getAllPlayers().filter(alive);
  const scored = [];
  for (const [id, rec] of bears) {
    const bear = entityOf(id, rec);
    if (!alive(bear)) continue;
    let far = Infinity;
    for (const p of players) far = Math.min(far, distXZ(bear.location, p.location));
    scored.push({ id, rec, bear, far });
  }
  scored.sort((a, b) => b.far - a.far);
  const over = bears.size - MAX_BEARS;
  for (let i = 0; i < over && i < scored.length; i++) {
    const { id, rec, bear } = scored[i];
    removeLure(rec);
    bears.delete(id);
    tryDo("上限超過の熊を撤去", () => bear.remove());
  }
}

/** 記録から実体を引く。実体は保持し続けず、毎回引き直す(消えた実体を触らないため)。 */
function entityOf(id, rec) {
  if (rec.entity && alive(rec.entity) && rec.entity.id === id) return rec.entity;
  for (const dim of dimensionsInUse()) {
    const found = tryDo("熊の再取得", () =>
      dim.getEntities({ type: BEAR_TYPE }).find((e) => e.id === id)
    );
    if (alive(found)) {
      rec.entity = found;
      return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 毎tick
// ---------------------------------------------------------------------------

system.runInterval(() => {
  tickCount++;

  // ブロック走査を1tickぶん進める（予算はscan.js側で切ってある）
  // **必ず包む。** ここで例外が外へ出ると、この下の熊の面倒も丸ごと止まる。
  tryDo("走査の進行", () => scanTick());

  if (tickCount % DISCOVER_INTERVAL === 0) tryDo("熊の探し直し", () => discover());

  // 熊の面倒。1周期に全頭を1回ずつ。1tickでまとめて見ない。
  const ids = [...bears.keys()];
  if (ids.length === 0) return;

  const perTick = Math.max(1, Math.min(BEARS_PER_TICK, Math.ceil(ids.length / TICK_INTERVAL)));
  for (let n = 0; n < perTick; n++) {
    if (ids.length === 0) break;
    cursor = (cursor + 1) % ids.length;
    const id = ids[cursor];
    const rec = bears.get(id);
    if (!rec) continue;
    if ((rec.nextTick ?? 0) > tickCount) continue;
    rec.nextTick = tickCount + TICK_INTERVAL;

    const bear = entityOf(id, rec);
    if (!alive(bear)) {
      removeLure(rec);
      bears.delete(id);
      continue;
    }
    tryDo("熊の更新", () => update(bear, rec, tickCount));
  }
}, 1);

// ---------------------------------------------------------------------------
// 当たり判定
// ---------------------------------------------------------------------------

/**
 * 熊がプレイヤーを殴った。
 * bear.json の minecraft:attack は 1 しか与えていないので、
 * 個体ごとの「1〜3撃で倒す」ぶんをここで上乗せする。
 */
tryDo("殴りイベントの登録", () => {
  world.afterEvents.entityHitEntity.subscribe((ev) => {
    const bear = ev.damagingEntity;
    const victim = ev.hitEntity;
    if (!bear || bear.typeId !== BEAR_TYPE) return;
    if (!victim || victim.typeId !== "minecraft:player") return;

    const rec = bears.get(bear.id);
    if (!rec) return;
    if (tickCount - (rec.lastAttack ?? 0) < ATTACK_COOLDOWN) return;
    rec.lastAttack = tickCount;

    const extra = attackDamage(rec, victim);
    tryDo("打撃の上乗せ", () => {
      victim.applyDamage(extra, {
        cause: ATTACK_IGNORE_ARMOR ? "override" : "entityAttack",
        damagingEntity: bear,
      });
    });
    tryDo("うなり声", () => bear.dimension.playSound("mob.polarbear.warning", bear.location));
  });
});

/**
 * 熊が傷ついた。遠距離攻撃を一定以上受けたら逃げる(指示書の ESCAPE 条件)。
 */
tryDo("被弾イベントの登録", () => {
  world.afterEvents.entityHurt.subscribe((ev) => {
    const bear = ev.hurtEntity;
    if (!bear || bear.typeId !== BEAR_TYPE) return;
    const rec = bears.get(bear.id);
    if (!rec) return;

    const cause = ev.damageSource?.cause ?? "none";
    const source = ev.damageSource?.damagingEntity ?? null;
    // 矢・トライデント・雪玉などは "projectile"。指示書の「遠距離攻撃」はこれ。
    const kind = cause === "projectile" ? "projectile" : "melee";

    if (onHurt(bear, rec, kind, ev.damage ?? 0, source, tickCount)) {
      if (isDebug()) console.warn(`[bear] ${bear.id.slice(-4)} が逃走に入った (${cause})`);
    }
  });
});

/** 熊が死んだ / 消えた。目印を必ず片付ける。 */
tryDo("死亡イベントの登録", () => {
  world.afterEvents.entityDie.subscribe((ev) => {
    const id = ev.deadEntity?.id;
    if (!id) return;
    const rec = bears.get(id);
    if (!rec) return;
    removeLure(rec);
    bears.delete(id);
  });
});

tryDo("消滅イベントの登録", () => {
  world.afterEvents.entityRemove.subscribe((ev) => {
    const id = ev.removedEntityId;
    const rec = bears.get(id);
    if (!rec) return;
    removeLure(rec);
    bears.delete(id);
  });
});

// ---------------------------------------------------------------------------
// 命令（/function から scriptevent で届く）
// ---------------------------------------------------------------------------

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (!ev.id.startsWith("bear:")) return;
  const cmd = ev.id.slice("bear:".length);
  const arg = (ev.message ?? "").trim();
  const player = ev.sourceEntity?.typeId === "minecraft:player" ? ev.sourceEntity : null;

  switch (cmd) {
    case "help": showHelp(player); break;
    case "spawn": doSpawn(player, arg); break;
    case "here": doHere(player); break;
    case "status": showStatus(player); break;
    case "clear": doClear(player); break;
    case "debug": doDebug(player, arg); break;
    default: say(player, `§c知らない命令です: ${cmd}  (/function bear_help)`); break;
  }
});

function say(player, text) {
  if (player) tryDo("表示", () => player.sendMessage(text));
  else world.sendMessage(text);
}

function showHelp(player) {
  say(player, `§6=== 熊AI  v${VERSION} ===`);
  say(player, "§f/function bear_here §7… §e目の前に1頭出す(見えるかの確認)");
  say(player, "§f/function bear_spawn §7… 近くに熊を出す");
  say(player, "§f/function bear_status §7… いま何頭いて、何をしているか");
  say(player, "§f/function bear_clear §7… 熊を全部消す");
  say(player, "§f/function bear_debug_on §7/§f bear_debug_off §7… 状態を名札とログに出す");
}

/**
 * 熊を出す。プレイヤーから SPAWN_DISTANCE ほど離れた、立てる場所に出す。
 * 目の前に湧かせると「森から歩いてきた」感じが出ないため。
 *
 * **出せなかったときは理由をそのまま出す。** 「湧かせる場所が無い」と
 * 「湧かせ自体が断られた(定義が読めていない等)」は原因が全く別で、
 * 同じ文言にまとめると実機で切り分けができない。
 * 離れた場所に置けなかった場合は、最後に足元へ出す(出ないより出るほうがよい)。
 */
function doSpawn(player, arg) {
  if (!player) {
    say(null, "§c/function bear_spawn はプレイヤーが実行してください");
    return;
  }
  const count = Math.max(1, Math.min(16, Number.parseInt(arg, 10) || SPAWN_COUNT));
  const dim = player.dimension;
  let made = 0;
  let noGround = 0;   // 立てる場所が無くて見送った回数
  let lastError = null; // spawnEntity が断った最後の理由
  const spots = [];

  /** その座標に1頭出す。出せなければ null(理由は lastError に残す)。 */
  const put = (pos) => {
    let bear = null;
    try {
      bear = dim.spawnEntity(BEAR_TYPE, pos);
    } catch (e) {
      lastError = String(e);
      return null;
    }
    if (!alive(bear)) {
      lastError = lastError ?? "湧いた直後に消えました";
      return null;
    }
    bears.set(bear.id, makeRecord(bear));
    return bear;
  };

  for (let i = 0; i < count; i++) {
    let placed = null;
    for (let attempt = 0; attempt < 24 && !placed; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = randRange(SPAWN_DISTANCE * 0.6, SPAWN_DISTANCE * 1.4);
      const x = Math.floor(player.location.x + Math.cos(a) * d);
      const z = Math.floor(player.location.z + Math.sin(a) * d);
      // **熊の幅ぶんの足場と、そこから出られる道があること。**
      // 立てるだけを見て湧かせると、壁に食い込んだ熊や、四方を囲まれた1マスの
      // 穴に入った熊ができて、一歩も動けないまま「詰まった」を出し続ける。
      const y = groundY(dim, x, z, Math.floor(player.location.y), BEAR_WIDTH);
      if (y === null) { noGround++; continue; }
      if (!isStandable(dim, { x, y, z }, BEAR_WIDTH) || !hasExit(dim, { x, y, z })) {
        noGround++;
        continue;
      }
      placed = put({ x: x + 0.5, y, z: z + 0.5 });
    }
    // 離れた場所が全部だめなら足元に出す(屋上・洞窟・狭い路地でも必ず出る)
    if (!placed) placed = put({ ...player.location });
    if (placed) {
      made++;
      spots.push(`${Math.floor(placed.location.x)},${Math.floor(placed.location.z)}`);
    }
  }

  if (made > 0) {
    say(player, `§a熊を ${made} 頭 出しました(今 ${bears.size} 頭)。§7${spots.join(" / ")}`);
    say(player, "§7見当たらないときは §f/function bear_status §7で座標が出ます。");
  } else if (lastError) {
    say(player, `§c熊を出せませんでした: §7${lastError}`);
    say(player, "§7ビヘイビアパックの熊の定義が読めていない合図です。");
  } else {
    say(player, `§c湧かせる場所が見つかりませんでした(${noGround}回試行)。開けた場所で試してください。`);
  }
}

/**
 * **目の前に1頭だけ出す。「熊が見えているか」を確かめるためだけの命令。**
 *
 * bear_spawn は「森から歩いてきた」感じを出すために 28m 離した場所に出すので、
 * 湧いたかどうかを目で確かめられない(実機で「そもそも熊が見当たらない」に
 * なった)。ここでは目の前に置き、名札も付ける。
 *
 *   体も名札も見える … 正常
 *   名札だけ見える   … リソースパックが効いていない(見た目が入っていない)
 *   どちらも見えない … その場所に熊がいない(出せていない)
 */
function doHere(player) {
  if (!player) {
    say(null, "§c/function bear_here はプレイヤーが実行してください");
    return;
  }
  const dim = player.dimension;
  const dir = tryDo("向きの取得", () => player.getViewDirection()) ?? { x: 0, y: 0, z: 1 };
  const len = Math.hypot(dir.x, dir.z) || 1;

  // 目の前 3〜5m。立てる場所が無ければ足元に出す(出ないより出るほうがよい)
  let spot = null;
  for (const d of [3, 4, 5, 2]) {
    const x = Math.floor(player.location.x + (dir.x / len) * d);
    const z = Math.floor(player.location.z + (dir.z / len) * d);
    const y = groundY(dim, x, z, Math.floor(player.location.y), BEAR_WIDTH);
    if (y !== null && isStandable(dim, { x, y, z }, BEAR_WIDTH)) {
      spot = { x: x + 0.5, y, z: z + 0.5 };
      break;
    }
  }
  if (!spot) spot = { ...player.location };

  let bear = null;
  try {
    bear = dim.spawnEntity(BEAR_TYPE, spot);
  } catch (e) {
    say(player, `§c熊を出せませんでした: §7${e}`);
    say(player, "§7ビヘイビアパックの熊の定義が読めていない合図です。");
    return;
  }
  if (!alive(bear)) {
    say(player, "§c熊が湧いた直後に消えました。");
    return;
  }
  bears.set(bear.id, makeRecord(bear));
  tryDo("名札", () => { bear.nameTag = "確認用のクマ"; });

  const at = `${Math.floor(bear.location.x)},${Math.floor(bear.location.y)},${Math.floor(bear.location.z)}`;
  say(player, `§a目の前に熊を1頭出しました。§7${at}`);
  say(player, "§7体も名札も見える … §a正常");
  say(player, "§7名札だけ見える     … §cリソースパック(見た目)が効いていません");
  say(player, "§7どちらも見えない   … §cその場所に熊が出せていません");
}

function showStatus(player) {
  say(player, `§6=== 熊AI v${VERSION}  ${bears.size} 頭 / 走査 ${activeJobs()} 本 ===`);
  const trouble = lureProblem();
  if (trouble) {
    // 目印が出ないと熊は行き先を持てない。「熊はいるのに何もしない」の正体はこれ。
    say(player, `§c目印(誘導体)を出せていません: §7${trouble}`);
  }
  if (bears.size === 0) {
    say(player, "§7熊はいません。/function bear_spawn で出せます。");
    return;
  }

  // 詰まり・埋まりの数を先に出す。1頭ずつの行を数えなくても様子が分かるように。
  let stuckN = 0;
  let buriedN = 0;
  for (const rec of bears.values()) {
    if (rec.buried) buriedN++;
    if ((rec.stuck ?? 0) > 0) stuckN++;
  }
  if (buriedN > 0) {
    say(player, `§c${buriedN} 頭がブロックに食い込んで動けません` +
      "§7（周りが塞がっていて助け出せない場所です）");
  }
  say(player, `§7足が止まっている熊 ${stuckN} 頭 / 掘り出した回数 ${rescueCount()} 回`);

  let shown = 0;
  for (const [id, rec] of bears) {
    if (shown >= 8) { say(player, `§7… ほか ${bears.size - shown} 頭`); break; }
    const bear = entityOf(id, rec);
    const where = bear ? `${Math.floor(bear.location.x)},${Math.floor(bear.location.z)}` : "?";
    const dist = bear && player ? Math.round(distXZ(bear.location, player.location)) : "?";
    const goal = rec.finalTarget ? `→${rec.finalTarget.x},${rec.finalTarget.z}` : "→なし";
    // 動けていない熊はひと目で分かるようにする
    const mark = rec.buried ? " §c[埋]" : (rec.stuck ?? 0) > 0 ? ` §e[止${rec.stuck}]` : "";
    say(player,
      `§f${id.slice(-4)} §e${STATE_LABEL[rec.state] ?? rec.state}§7 ` +
      `ルート${rec.route}(${routeOf(rec.route).label}) ${hitsOf(rec)}撃 ` +
      `略奪${rec.stolen} 破壊${rec.breakCount} 侵入${rec.housesEntered} ` +
      `§8${where} (${dist}m) ${goal}${mark}`);
    say(player, `  §7${traitLine(rec.traits)}`);
    shown++;
  }
}

function doClear(player) {
  let n = 0;
  for (const [id, rec] of bears) {
    const bear = entityOf(id, rec);
    removeLure(rec);
    if (alive(bear)) {
      tryDo("熊を消す", () => bear.remove());
      n++;
    }
  }
  bears.clear();
  // 取り残された目印も掃除する
  for (const dim of dimensionsInUse()) sweepLures(dim, new Set());
  say(player, `§a熊を ${n} 頭 消しました。`);
}

function doDebug(player, arg) {
  const on = arg === "on" || (arg !== "off" && !isDebug());
  setDebug(on);
  if (!on) {
    for (const [id, rec] of bears) {
      const bear = entityOf(id, rec);
      if (alive(bear)) tryDo("名札を消す", () => { bear.nameTag = ""; });
    }
  }
  say(player, on ? "§a熊の状態を名札とログに出します。" : "§7熊の状態表示を止めました。");
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

setDebug(DEBUG_DEFAULT);

let greeted = false;

function greet() {
  if (greeted) return;
  greeted = true;
  discover();
  console.warn(`[bear] 熊AI v${VERSION} 起動。熊 ${bears.size} 頭。/function bear_help`);
}

// worldLoad はスクリプトAPIの版によって無いことがある。
// 無くてもプレイヤーが入った時点で必ず動くよう、両方に登録しておく。
tryDo("worldLoad の登録", () => {
  world.afterEvents.worldLoad.subscribe(() => greet());
});
tryDo("playerSpawn の登録", () => {
  world.afterEvents.playerSpawn.subscribe((ev) => {
    greet();
    if (ev.initialSpawn && ev.player) {
      tryDo("あいさつ", () =>
        ev.player.sendMessage(`§7[熊AI v${VERSION}] 熊が徘徊しています。§f/function bear_help`)
      );
    }
  });
});
