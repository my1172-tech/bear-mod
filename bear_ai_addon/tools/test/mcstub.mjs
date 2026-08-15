/**
 * 机上試験用の偽 @minecraft/server。
 *
 * **実機の代わりにはならない。** 経路探索も物理も本物ではない。
 * ここで確かめられるのは「状態機械が期待どおりに進むか」「食料だけを取るか」
 * 「壊す確率が効いているか」「遠距離攻撃で逃げるか」といった**筋道**だけ。
 * 見た目・当たり判定・実際の歩きは実機で見るしかない。
 *
 * 世界の作り: y<=63 は土、y>63 は空気。そこへ試験ごとにブロックを置く。
 */

const GROUND_Y = 63;
const GROUND_BLOCK = "minecraft:grass_block";

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

class Emitter {
  constructor() { this.handlers = []; }
  subscribe(fn) { this.handlers.push(fn); return fn; }
  unsubscribe(fn) { this.handlers = this.handlers.filter((h) => h !== fn); }
  emit(ev) { for (const h of this.handlers) h(ev); }
}

export class ItemStack {
  constructor(typeId, amount = 1) {
    this.typeId = typeId;
    this.amount = amount;
  }
  getComponent(name) {
    // 実機の版によっては minecraft:food が読めない。読めない側を再現する
    if (name === "minecraft:food") throw new Error("food component is not available");
    return undefined;
  }
}

class Container {
  constructor(size = 27) {
    this.size = size;
    this.slots = new Array(size).fill(null);
  }
  getItem(i) { return this.slots[i] ?? undefined; }
  setItem(i, item) { this.slots[i] = item ?? null; }
}

class Block {
  constructor(dimension, pos, typeId) {
    this.dimension = dimension;
    this.location = { ...pos };
    this.typeId = typeId;
  }
  get isAir() { return this.typeId === "minecraft:air"; }
  get isLiquid() { return this.typeId.includes("water") || this.typeId.includes("lava"); }
  get isSolid() { return !this.isAir && !this.isLiquid; }
  setType(id) { this.dimension.__set(this.location, id); this.typeId = id; }
  getComponent(name) {
    if (name !== "minecraft:inventory") return undefined;
    const c = this.dimension.__containers.get(key(this.location));
    return c ? { container: c } : undefined;
  }
}

function key(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

// ---------------------------------------------------------------------------
// 実体
// ---------------------------------------------------------------------------

let nextId = 1;

class Entity {
  constructor(dimension, typeId, location) {
    this.id = `e${nextId++}`;
    this.typeId = typeId;
    this.dimension = dimension;
    this.location = { ...location };
    this.isValid = true;
    this.nameTag = "";
    this.props = new Map();
    this.events = [];           // triggerEvent の履歴(＝今のAIの型)
    this.health = 40;
  }
  teleport(loc, opts) {
    this.location = { ...loc };
    if (opts?.dimension) this.dimension = opts.dimension;
  }
  triggerEvent(name) { this.events.push(name); }
  remove() {
    this.isValid = false;
    this.dimension.__entities.delete(this.id);
  }
  getDynamicProperty(id) { return this.props.get(id); }
  setDynamicProperty(id, v) { this.props.set(id, v); }
  applyDamage(amount, options) {
    this.health -= amount;
    world.afterEvents.entityHurt.emit({
      hurtEntity: this,
      damage: amount,
      damageSource: { cause: options?.cause ?? "none", damagingEntity: options?.damagingEntity },
    });
    if (this.health <= 0) {
      world.afterEvents.entityDie.emit({ deadEntity: this });
      this.remove();
    }
    return true;
  }
  getComponent(name) {
    if (name === "minecraft:health") {
      return { currentValue: this.health, effectiveMax: 20, setCurrentValue: (v) => { this.health = v; } };
    }
    return undefined;
  }
  /** その熊の今のAIの型(roam/hunt/flee/still)。試験の物理が使う。 */
  get mode() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const m = /^bear:mode_(\w+)$/.exec(this.events[i]);
      if (m) return m[1];
    }
    return "roam";
  }
}

class Player extends Entity {
  constructor(dimension, location, name = "テスト") {
    super(dimension, "minecraft:player", location);
    this.name = name;
    this.messages = [];
    this.health = 20;
  }
  sendMessage(text) { this.messages.push(text); }
  getGameMode() { return this.gameMode ?? "survival"; }
  getViewDirection() { return this.view ?? { x: 0, y: 0, z: 1 }; }
  getComponent(name) {
    if (name === "minecraft:health") {
      return { currentValue: this.health, effectiveMax: 20, setCurrentValue: (v) => { this.health = v; } };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 世界
// ---------------------------------------------------------------------------

class Dimension {
  constructor(id) {
    this.id = id;
    this.blocks = new Map();       // "x,y,z" -> typeId
    this.__containers = new Map(); // "x,y,z" -> Container
    this.__entities = new Map();   // id -> Entity
    this.sounds = [];
    this.droppedItems = [];
    this.__spawnBlocked = new Map(); // typeId -> 断る理由
  }

  __typeAt(pos) {
    const k = key(pos);
    if (this.blocks.has(k)) return this.blocks.get(k);
    return Math.floor(pos.y) <= GROUND_Y ? GROUND_BLOCK : "minecraft:air";
  }

  __set(pos, typeId) {
    this.blocks.set(key(pos), typeId);
    if (typeId === "minecraft:air") this.__containers.delete(key(pos));
  }

  /** 試験の準備で使う。中身つきのチェストを置く。 */
  __putChest(pos, items, typeId = "minecraft:chest") {
    this.__set(pos, typeId);
    const c = new Container(27);
    items.forEach((it, i) => c.setItem(i, it));
    this.__containers.set(key(pos), c);
    return c;
  }

  getBlock(pos) {
    if (Math.floor(pos.y) < -64 || Math.floor(pos.y) > 320) return undefined;
    return new Block(this, pos, this.__typeAt(pos));
  }

  getTopmostBlock(pos) {
    for (let y = 200; y >= -64; y--) {
      const t = this.__typeAt({ x: pos.x, y, z: pos.z });
      if (t !== "minecraft:air") return new Block(this, { x: pos.x, y, z: pos.z }, t);
    }
    return undefined;
  }

  getEntities(opts = {}) {
    let list = [...this.__entities.values()].filter((e) => e.isValid);
    if (opts.type) list = list.filter((e) => e.typeId === opts.type);
    if (opts.location && opts.maxDistance !== undefined) {
      list = list.filter((e) => dist(e.location, opts.location) <= opts.maxDistance);
    }
    return list;
  }

  getPlayers(opts = {}) {
    return this.getEntities({ ...opts, type: "minecraft:player" });
  }

  spawnEntity(typeId, location) {
    // 定義が読めていない実体は、本物のマイクラでも例外で断られる。
    // その様子を作れるようにしておく(逆テスト用)。
    const blocked = this.__spawnBlocked?.get(typeId);
    if (blocked) throw new Error(blocked);
    const e = typeId === "minecraft:player"
      ? new Player(this, location)
      : new Entity(this, typeId, location);
    this.__entities.set(e.id, e);
    return e;
  }

  spawnItem(item, location) {
    this.droppedItems.push({ item, location: { ...location } });
    return { typeId: "minecraft:item" };
  }

  playSound(id, location) { this.sounds.push({ id, location }); }
  runCommand(cmd) { return { successCount: 1 }; }
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const dimensions = new Map([
  ["minecraft:overworld", new Dimension("minecraft:overworld")],
]);

export const world = {
  afterEvents: {
    entityHitEntity: new Emitter(),
    entityHurt: new Emitter(),
    entityDie: new Emitter(),
    entityRemove: new Emitter(),
    playerSpawn: new Emitter(),
    worldLoad: new Emitter(),
  },
  getDimension(id) {
    if (!dimensions.has(id)) dimensions.set(id, new Dimension(id));
    return dimensions.get(id);
  },
  getAllPlayers() {
    const out = [];
    for (const d of dimensions.values()) out.push(...d.getPlayers());
    return out;
  },
  messages: [],
  sendMessage(text) { this.messages.push(text); },
};

const intervals = [];

export const system = {
  currentTick: 0,
  runInterval(fn, period = 1) {
    intervals.push({ fn, period, next: period });
    return intervals.length;
  },
  run(fn) { fn(); },
  clearRun() {},
  afterEvents: {
    scriptEventReceive: new Emitter(),
  },
};

// ---------------------------------------------------------------------------
// 試験の駆動
// ---------------------------------------------------------------------------

export const sim = {
  world,
  system,
  dimension: () => world.getDimension("minecraft:overworld"),
  Player,
  ItemStack,
  GROUND_Y,

  /** 1tick 進める。登録された runInterval を呼び、簡易の物理を動かす。 */
  tick() {
    system.currentTick++;
    for (const it of intervals) {
      it.next--;
      if (it.next <= 0) {
        it.next = it.period;
        it.fn();
      }
    }
    physics();
  },

  spawnPlayer(location) {
    const dim = world.getDimension("minecraft:overworld");
    const p = new Player(dim, location);
    dim.__entities.set(p.id, p);
    return p;
  },

  /** 遠距離攻撃を熊に当てる。 */
  shoot(bear, amount, shooter) {
    bear.health -= amount;
    world.afterEvents.entityHurt.emit({
      hurtEntity: bear,
      damage: amount,
      damageSource: { cause: "projectile", damagingEntity: shooter },
    });
  },

  fire(id, message, sourceEntity) {
    system.afterEvents.scriptEventReceive.emit({ id, message, sourceEntity });
  },

  /** その種類の実体を湧かせようとすると例外にする(定義が読めていない状況)。 */
  blockSpawn(typeId, reason = "Failed to spawn entity") {
    world.getDimension("minecraft:overworld").__spawnBlocked.set(typeId, reason);
  },

  allowSpawn(typeId) {
    world.getDimension("minecraft:overworld").__spawnBlocked.delete(typeId);
  },
};

/**
 * 熊の動きの代わり。**本物の経路探索ではない。**
 * ・roam / flee … いちばん近い目印(bear:lure)へまっすぐ寄る
 * ・hunt        … いちばん近いプレイヤーへ寄り、届いたら殴った合図を出す
 * ・still       … 動かない
 */
function physics() {
  for (const dim of dimensions.values()) {
    for (const bear of dim.getEntities({ type: "bear:bear" })) {
      const mode = bear.mode;
      if (mode === "still") continue;

      let target = null;
      if (mode === "hunt") {
        const players = dim.getPlayers();
        target = players[0] ?? null;
      } else {
        let best = null, bestD = Infinity;
        for (const l of dim.getEntities({ type: "bear:lure" })) {
          const d = dist(l.location, bear.location);
          if (d < bestD) { best = l; bestD = d; }
        }
        target = best;
      }
      if (!target) continue;

      const speed = mode === "flee" ? 0.42 : 0.25;
      const dx = target.location.x - bear.location.x;
      const dz = target.location.z - bear.location.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) {
        bear.location.x += (dx / d) * Math.min(speed, d);
        bear.location.z += (dz / d) * Math.min(speed, d);
        // 足元の床に着地させる。**いちばん上のブロック(屋根)に乗せてはいけない。**
        // 屋根に乗せると、家の中を探しているつもりで屋根の上を探すことになる。
        const x = Math.floor(bear.location.x);
        const z = Math.floor(bear.location.z);
        for (let y = Math.floor(bear.location.y) + 1; y >= Math.floor(bear.location.y) - 3; y--) {
          const below = dim.__typeAt({ x, y: y - 1, z });
          const here = dim.__typeAt({ x, y, z });
          const above = dim.__typeAt({ x, y: y + 1, z });
          if (below !== "minecraft:air" && here === "minecraft:air" && above === "minecraft:air") {
            bear.location.y = y;
            break;
          }
        }
      }

      if (mode === "hunt" && d <= 2.5 && system.currentTick % 20 === 0) {
        // bear.json の minecraft:attack が先に 1 を与える。実機と同じ順番にする
        // (これを忘れると「1〜3撃」の勘定が1撃ずれる)。
        world.afterEvents.entityHitEntity.emit({ damagingEntity: bear, hitEntity: target });
        if (target.isValid) target.applyDamage(1, { cause: "entityAttack", damagingEntity: bear });
      }
    }
  }
}

export default { world, system, ItemStack };
