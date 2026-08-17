/**
 * 熊AIの調整値。**挙動を変えたいときはこのファイルだけを触る。**
 *
 * ここと behavior_packs/bear_bp/entities/bear.json の両方に書いてある値がある
 * (体力・移動速度)。統合版はエンティティ定義の数値をスクリプトから変えられない
 * ためで、片方だけ直すと必ずずれる。**tools/check_config.py がずれを検出する**ので、
 * 直したら必ず走らせること。
 */

// ---------------------------------------------------------------------------
// 実体
// ---------------------------------------------------------------------------

/**
 * この版の番号。**manifest.json の version と一致させること**
 * (check_config.py がずれを見張る)。
 *
 * 同じ名前のパックが何本も並ぶと、有効にしたのが直したあとの物か前の物か
 * 分からなくなる。名乗らせて、ゲームの中から確かめられるようにしておく
 * (起動メッセージ・`/function bear_help`・`/function bear_status` に出る)。
 */
export const VERSION = "0.9.0";

/** 熊の実体。 */
export const BEAR_TYPE = "bear:bear";

/**
 * 誘導体(行き先の目印)の実体。
 *
 * 統合版のスクリプトAPIには「この座標へ歩け」という命令が無い。経路探索を
 * 持っているのはバニラのAIだけなので、行き先に**狙える相手**を置いて
 * nearest_attackable_target + move_towards_target で歩かせている。
 * テレポートで動かすと地形を無視した滑りになり「徘徊」に見えない。
 */
export const LURE_TYPE = "bear:lure";

/** 熊の体力。**bear.json の minecraft:health と一致させること。** */
export const BEAR_HEALTH = 40;

/** 熊の移動速度。**bear.json の minecraft:movement と一致させること。** */
export const BEAR_SPEED = 0.25;

/**
 * 熊の当たり判定の幅。**bear.json の minecraft:collision_box.width と一致させること。**
 *
 * **1.0 未満にしておくこと。** 統合版は当たり判定がブロックに食い込んだ実体を
 * 押し出してくれない。1.0以上にすると幅1のドアや路地を通れず、入口に食い込んだまま
 * 一歩も動けなくなる（実機で「詰まって動けない・地面に埋まっている」ように見えたのは
 * これ。1.3 で作ってあった）。
 *
 * 見た目の大きさは模型(bear.geo.json)が決めるので、ここを細くしても熊は小さくならない。
 * 模型の胴は 12/16 = 0.75 ブロック幅なので、0.9 でも見た目より大きい。
 */
export const BEAR_WIDTH = 0.9;

/** 熊の当たり判定の高さ。**bear.json の minecraft:collision_box.height と一致させること。** */
export const BEAR_HEIGHT = 1.4;

/**
 * 場面ごとの速さの倍率。**bear.json の speed_multiplier と一致させること。**
  *
   * 素の移動速度(BEAR_SPEED = 0.25)に掛かる。目安:
    *
     *   徘徊 1.0 → 0.25   歩くプレイヤーより少し遅い。うろついている感じ
      *   逃走 FLEE_SPEED   いちばん速い。撃たれた熊は振り切って消える
       *
        * **突進が徘徊と大差ないと「襲われても速くならない」ように見える。**
         * 1.3(=0.325)で作ってあったが、徘徊 0.25 との差が3割しかなく、
          * しかも逃走より遅かった。check_config.py が
           * 「突進 > 徘徊」を見張る。
            */
export const ROAM_SPEED = 1.0;

/**
 * 「走るプレイヤー」の実効速度の目安。元は突進 1.8(=0.45) を
  * 「走るプレイヤーとほぼ同じ」として調整した基準値で、それをそのまま使う。
   */
export const PLAYER_RUN_SPEED = 0.45;

/**
 * 突進(ATTACK)の速さ。**個体ごとにランダム**(プレイヤーが走る速さの
  * ATTACK_SPEED_MULT_MIN〜MAX倍)。
   *
    * 統合版の bear.json は静的なJSONなので、連続値ではなく段階(tier)で表す。
     * ここに並べた5段が PLAYER_RUN_SPEED の 1.5〜2.5倍(0.675〜1.125、
      * BEAR_SPEED=0.25で割った速さの倍率)にあたる。個体ごとに湧いたときに
       * このどれか1つが均等な乱数で選ばれ(traits.js の attackTierOf)、
        * 熊が死ぬまで変わらない。bear.json 側は bear:mode_hunt0〜hunt4 の
         * component_group を段の数だけ用意してあり、tools/check_config.py が
          * ここと bear.json のずれ・段の並びを見張る。
           */
export const ATTACK_SPEED_MULT_MIN = 1.5;
export const ATTACK_SPEED_MULT_MAX = 2.5;
export const ATTACK_SPEED_TIERS = [2.7, 3.15, 3.6, 4.05, 4.5];

/**
 * 逃走(FLEE)の速さの倍率。**追う熊(突進)より遅いと逃げ切れない**ので、
  * ATTACK_SPEED_TIERS のいちばん速い段より必ず速くしておくこと
   * (check_config.py が見張る)。
    */
export const FLEE_SPEED = 4.6;

// ---------------------------------------------------------------------------
// 打撃
// ---------------------------------------------------------------------------

/**
 * プレイヤーを倒すのに要する打撃数の幅。個体ごとにこの範囲から決まる。
 * 実際の打撃力は「相手の最大体力 ÷ 打撃数」で毎回計算するので、
 * 体力上限を変えるアドオンと併用しても 1〜3撃 は保たれる。
 */
export const BEAR_DAMAGE = { minHits: 1, maxHits: 3 };

/**
 * 打撃で防具を無視するか。
 *
 * true だと「1〜3撃で倒れる」が装備に関係なく成立する(指示書の要件)。
 * false にすると防具が効くので、フル装備の相手には4撃以上かかる。
 */
export const ATTACK_IGNORE_ARMOR = true;

/** 同じ相手を続けて殴るときの最短間隔(tick)。バニラの殴り間隔に合わせる。 */
export const ATTACK_COOLDOWN = 20;

// ---------------------------------------------------------------------------
// 逃走
// ---------------------------------------------------------------------------

/**
 * 遠距離攻撃(矢・雪玉・トライデントなど)を受けて逃げ出す累積ダメージ。
 * 指示書の `if projectileDamage > threshold → ESCAPE` の threshold。
 * 個体の度胸(bravery)で ±50% 変わる。
 */
export const ESCAPE_THRESHOLD = 6;

/** 近接で殴られ続けたときに逃げ出す累積ダメージ。遠距離より鈍い(熊は近くの敵には強気)。 */
export const ESCAPE_MELEE_THRESHOLD = 16;

/** 受けたダメージの記憶が消えるまで(tick)。これを過ぎると累積は 0 に戻る。 */
export const DAMAGE_MEMORY = 200;

/** 逃走を続ける時間(tick)。200 で10秒。 */
export const ESCAPE_TIME = 200;

/** 逃走先の距離(ブロック)。市街地から離れる向きへこれだけ走る。 */
export const ESCAPE_DISTANCE = 40;

// ---------------------------------------------------------------------------
// 探知（視界と嗅覚）
// ---------------------------------------------------------------------------

/**
 * 視界。**状態が上がるほど遠くまで・狭い角度で見る**（対象に集中する）。
 *
 *   calm    通常     … 何も気づいていない。広く浅く
 *   alert   警戒     … 匂いを嗅ぎ取った。首を上げて探す
 *   spotted 発見     … プレイヤーを見つけた
 *   chase   追跡     … 追いかけている。いちばん遠くまで届く
 *
 * fov は**視野角(度)**。真後ろは見えない。180 なら真横まで、120 なら斜め前まで。
 * 視界は**壁を通らない**（嗅覚と違うのはここ）。
 */
export const SIGHT = {
  calm: { range: 40, fov: 180 },
  alert: { range: 64, fov: 140 },
  spotted: { range: 90, fov: 120 },
  chase: { range: 120, fov: 120 },
};

/**
 * 嗅覚の届く距離(ブロック)。**視野角は無く、壁も通り抜ける。**
 *
 * 家の中で焼いている肉の匂いが外の熊に届く、というのがこの仕組みの肝。
 * 市街地の目安（プレイヤー100 / 料理150 / 牛200）に合わせてある。
 */
export const SMELL_RANGE = {
  cooking: 150,  // かまど・燻製器・焚き火が動いている（＝料理中）
  carcass: 200,  // 落ちている肉・死体
  cow: 200,
  sheep: 130,
  pig: 130,
  animal: 110,   // その他の動物
  food: 100,     // 落ちている食料
  player: 100,
};

/**
 * 匂いの強さ。**同じ距離なら強いほうへ向かう。**
 * 実際の比べ方は「強さ ÷ 距離」で、遠くの強い匂いと近くの弱い匂いが釣り合う。
 */
export const SMELL_STRENGTH = {
  cooking: 100,  // 焼いた肉
  carcass: 90,
  raw: 80,       // 生肉
  fish: 70,
  cow: 60,
  sheep: 45,
  pig: 45,
  animal: 35,
  fruit: 40,
  player: 10,
};

/** 料理中とみなすブロック。統合版は火の入ったかまどが別のIDになる。 */
export const COOKING_BLOCKS = [
  "minecraft:lit_furnace", "minecraft:lit_smoker", "minecraft:lit_blast_furnace",
  "minecraft:campfire", "minecraft:soul_campfire",
];

/** 匂いをたどる動物。名前ごとに強さと距離を変える。 */
export const SMELL_ANIMALS = {
  "minecraft:cow": "cow",
  "minecraft:mooshroom": "cow",
  "minecraft:sheep": "sheep",
  "minecraft:pig": "pig",
  "minecraft:chicken": "animal",
  "minecraft:rabbit": "animal",
  "minecraft:goat": "animal",
  "minecraft:horse": "animal",
  "minecraft:llama": "animal",
};

/**
 * 匂いを嗅ぎ直す間隔(tick)。
 * 半径200の実体探しは重いので、毎周期はやらずに間を空けて結果を使い回す。
 */
export const SMELL_INTERVAL = 60;

/** 匂いの記憶が薄れるまで(tick)。これを過ぎたら嗅ぎ直す。 */
export const SMELL_MEMORY = 200;

/** 見通しを確かめるときに、線上を何点まで読むか。多いほど正確だが重い。 */
export const SIGHT_SAMPLES = 20;

/**
 * この距離までは**向きに関係なく気づく**(ブロック)。
 *
 * 視野角だけで見分けると、真横にいる相手を見失う。しかも段階が上がるほど
 * 視野は狭くなるので、「見つけた瞬間に視野が 180→120 度へ狭まって見失い、
 * また見つけて…」を繰り返す（実際に机上試験で踏んだ）。
 * すぐ横の気配は角度に関わらず分かる、として抜け道を作っておく。
 */
export const SIGHT_NEAR = 12;

/** 警戒・発見の状態が続く時間(tick)。過ぎると1段下がる。 */
export const ALERT_DECAY = 200;

// ---------------------------------------------------------------------------
// 家とチェスト
// ---------------------------------------------------------------------------

/** 家(ドア)を探す半径(ブロック)。 */
export const HOUSE_RANGE = 24;

/** チェストを探す半径(ブロック)。指示書の「半径16〜32」の下限。市街地志向が高い個体は伸びる。 */
export const CHEST_RANGE = 16;

/** チェストを壊す確率。 */
export const BREAK_CHANCE = 0.3;

/** チェストを漁るのにかかる時間(tick)。この間その場に留まる。 */
export const LOOT_TIME = 40;

/** ドアを壊すのにかかる時間(tick)。 */
export const DOOR_BREAK_TIME = 30;

/**
 * ドアを壊す確率。開けられるドア(木)はまず開けようとし、
 * 開かない(鉄など)ときと、この確率を引いたときだけ壊す。
 */
export const DOOR_BREAK_CHANCE = 0.35;

/** 壊したドア・チェストのブロックを何に置き換えるか。 */
export const BROKEN_BLOCK = "minecraft:air";

/** 一度あさった家・チェストを覚えておく時間(tick)。24000 で1日。 */
export const LOOTED_MEMORY = 24000;

/** 1頭が同時に覚えていられる「あさった場所」の数。古いものから忘れる。 */
export const LOOTED_MEMORY_MAX = 64;

// ---------------------------------------------------------------------------
// ブロックの見分け
// ---------------------------------------------------------------------------

/** 家の入口とみなすブロック。統合版のIDで書くこと(Java版とは違う)。 */
export const DOOR_BLOCKS = [
  "minecraft:wooden_door", "minecraft:oak_door", "minecraft:spruce_door", "minecraft:birch_door",
  "minecraft:jungle_door", "minecraft:acacia_door", "minecraft:dark_oak_door", "minecraft:crimson_door",
  "minecraft:warped_door", "minecraft:mangrove_door", "minecraft:cherry_door", "minecraft:bamboo_door",
  "minecraft:pale_oak_door", "minecraft:iron_door", "minecraft:copper_door",
];

/** スクリプトから壊さないドア(壊すと家の見た目が崩れて困るもの)。今は無し。 */
export const DOOR_UNBREAKABLE = [];

// ---------------------------------------------------------------------------
// 窓からの侵入
// ---------------------------------------------------------------------------

/**
 * 窓(ガラス)を割って入るか。
 *
 * PLATEAUの都市ワールドには**ドアが1枚も無い**(生成側が door を置かない)。
 * ドアだけを入口にすると、その種のワールドでは家侵入もチェスト略奪も
 * 成立しない。窓なら建物のどこにでもある。
 *
 * 割るのはガラスと、その**上下1段ぶんの窓枠**だけ(WINDOW_MARGIN)。
 * それ以外の壁には手を出さない。
 */
export const WINDOW_ENTRY = true;

/**
 * 窓とみなすブロック。名前が `_glass` / `_glass_pane` で終わるものも拾うので、
 * ここは「名前で拾えないもの」と、よく使うものを明示するための一覧。
 *
 * PLATEAUの生成側が実際に置くのは
 *   ビル: 青45 / 水色25 / 透明20 / 遮光10
 *   一軒家: 薄灰・水色・灰・白・茶・遮光
 * (最新/engine_plateau/app/converter/facade.py の CITY_GLASS_BLOCKS /
 *  HOUSE_WINDOW_BLOCKS より)
 */
export const WINDOW_BLOCKS = [
  "minecraft:glass", "minecraft:tinted_glass", "minecraft:glass_pane",
  "minecraft:white_stained_glass", "minecraft:light_gray_stained_glass",
  "minecraft:gray_stained_glass", "minecraft:black_stained_glass",
  "minecraft:brown_stained_glass", "minecraft:red_stained_glass",
  "minecraft:orange_stained_glass", "minecraft:yellow_stained_glass",
  "minecraft:lime_stained_glass", "minecraft:green_stained_glass",
  "minecraft:cyan_stained_glass", "minecraft:light_blue_stained_glass",
  "minecraft:blue_stained_glass", "minecraft:purple_stained_glass",
  "minecraft:magenta_stained_glass", "minecraft:pink_stained_glass",
];

/**
 * 開口の下端が、熊の足元から何ブロック上までなら入れるか。
 *
 * 統合版のモブが登れるのは1段まで。**1のままにすること。**
 * 2にすると熊は窓を割ったのに入れず、外で立ち尽くす。
 */
export const WINDOW_STEP_UP = 1;

/**
 * ガラスの連なりの**上下に何段まで押し広げるか**。
 *
 * 生成側はふつうの家の窓をガラス1段(地面から3段目)で作る。ガラスだけを割ると
 * 穴が1段しか開かず、高さ1.4の熊は通れない。**熊が腕で窓枠ごと押し広げる**
 * ぶんとして、上下1段だけ余分に壊す。
 *
 * **ここが唯一、ガラス以外(壁)を壊す場所。** 増やすと家が崩れる。1のままにすること。
 */
export const WINDOW_MARGIN = 1;

/** 1つの窓で開ける穴の最大の高さ(段)。ガラス張りのビルで壁面が消えないようにする。 */
export const WINDOW_OPEN_MAX = 3;

/** 窓を割るのにかかる時間(tick)。ドアより手間取る。 */
export const WINDOW_BREAK_TIME = 40;

/**
 * 窓を割ろうとする確率。ドアの DOOR_BREAK_CHANCE にあたる。
 *
 * ドアには「開けて入る」という穏当な道があるが、**窓は割るしかない**。
 * だから全部の窓を必ず割る作りにすると、熊が見境なく建物を壊して回る。
 * ここを引かなかった熊は、その窓を「今はいい」と覚えて次へ行く。
 *
 * 実際の確率は**空腹と攻撃性で上がる**(windowBreakChance)。
 * 0 にすると窓を1枚も割らなくなる(ドアからは入る)。
 */
export const WINDOW_BREAK_CHANCE = 0.7;

/** 空腹が窓を割る気にどれだけ効くか。0 にすると空腹に関係なくなる。 */
export const WINDOW_HUNGER_WEIGHT = 0.6;

/** 中身を漁る対象のブロック。 */
export const CHEST_BLOCKS = [
  "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
];

/** 森とみなすブロック(いちばん上のブロックで判定する)。 */
export const FOREST_BLOCKS = [
  "minecraft:oak_leaves", "minecraft:spruce_leaves", "minecraft:birch_leaves",
  "minecraft:jungle_leaves", "minecraft:acacia_leaves", "minecraft:dark_oak_leaves",
  "minecraft:leaves", "minecraft:leaves2", "minecraft:azalea_leaves", "minecraft:cherry_leaves",
  "minecraft:mangrove_leaves", "minecraft:pale_oak_leaves",
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log",
  "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:log", "minecraft:log2",
];

/** 水路とみなすブロック。 */
export const WATER_BLOCKS = ["minecraft:water", "minecraft:flowing_water"];

/** 農地とみなすブロック。 */
export const FARM_BLOCKS = [
  "minecraft:farmland", "minecraft:wheat", "minecraft:potatoes", "minecraft:carrots",
  "minecraft:beetroot", "minecraft:pumpkin_stem", "minecraft:melon_stem", "minecraft:hay_block",
];

/**
 * 道路とみなすブロック。
 * PLATEAUの都市ワールドは道路をコンクリート系で敷いていることが多いので、
 * 実際のワールドに合わせてここを足し引きする。
 */
export const ROAD_BLOCKS = [
  "minecraft:gray_concrete", "minecraft:light_gray_concrete", "minecraft:black_concrete",
  "minecraft:stone", "minecraft:smooth_stone", "minecraft:cobblestone", "minecraft:gravel",
  "minecraft:andesite", "minecraft:polished_andesite", "minecraft:coal_block",
];

// ---------------------------------------------------------------------------
// 食料
// ---------------------------------------------------------------------------

/**
 * 熊が持ち去る食料。
 *
 * 統合版のスクリプトAPIには「これは食べ物か」を確実に返す部品が無い版がある。
 * 起動時に minecraft:food の部品が使えるか一度だけ試し(FOOD_COMPONENT_PROBE)、
 * 使えればそれを併用する。使えなくてもこの一覧で判定できる。
 *
 * 統合版は古い内部IDが返ることがある(cod→fish、mutton→muttonRaw、
 * melon_slice→melon など)ので、新旧どちらも入れてある。
 */
export const FOOD_ITEMS = [
  // 肉
  "minecraft:beef", "minecraft:cooked_beef", "minecraft:porkchop", "minecraft:cooked_porkchop",
  "minecraft:chicken", "minecraft:cooked_chicken", "minecraft:rabbit", "minecraft:cooked_rabbit",
  "minecraft:mutton", "minecraft:cooked_mutton", "minecraft:muttonRaw", "minecraft:muttonCooked",
  "minecraft:rotten_flesh",
  // 魚（熊の好物）
  "minecraft:cod", "minecraft:fish", "minecraft:cooked_cod", "minecraft:cooked_fish",
  "minecraft:salmon", "minecraft:cooked_salmon", "minecraft:tropical_fish", "minecraft:clownfish",
  "minecraft:pufferfish",
  // 農作物・果物
  "minecraft:apple", "minecraft:golden_apple", "minecraft:enchanted_golden_apple", "minecraft:appleEnchanted",
  "minecraft:carrot", "minecraft:golden_carrot", "minecraft:potato", "minecraft:baked_potato",
  "minecraft:poisonous_potato", "minecraft:beetroot", "minecraft:melon_slice", "minecraft:melon",
  "minecraft:sweet_berries", "minecraft:glow_berries", "minecraft:chorus_fruit", "minecraft:dried_kelp",
  "minecraft:wheat",
  // 加工品
  "minecraft:bread", "minecraft:cookie", "minecraft:cake", "minecraft:pumpkin_pie",
  "minecraft:mushroom_stew", "minecraft:beetroot_soup", "minecraft:rabbit_stew", "minecraft:suspicious_stew",
  "minecraft:honey_bottle", "minecraft:spider_eye",
];

/**
 * 起動時に ItemStack の minecraft:food 部品が使えるか試すか。
 * 使えれば FOOD_ITEMS に無い食べ物(他アドオンの食料など)も持ち去れる。
 */
export const FOOD_COMPONENT_PROBE = true;

/** 熊が1回の略奪で持ち去れるスタック数。 */
export const LOOT_STACKS = 6;

// ---------------------------------------------------------------------------
// 徘徊
// ---------------------------------------------------------------------------

/** 次のウェイポイントまでの距離の目安(ブロック)。 */
export const LEG_DISTANCE = { min: 24, max: 56 };

/**
 * 目印(誘導体)を熊から離してよい最大距離(ブロック)。
 *
 * **ワールドが動かしている範囲(ticking area)の内側に収めること。** その外に置くと、
 * 目印は「居るが動いていない」ので熊の索敵に映らず、熊は行き先を持てないまま
 * その場をうろつき、`詰まったので道のりを引き直す` を延々と出す
 * (実機のログで 489 行中 202 行がこれだった)。
 *
 * 統合版のシミュレーション距離の既定は4チャンク＝64m。目印を 56m に置くと、
 * 熊が少し動いただけで外へ出る。**32m** なら熊が動いても内側に留まる。
 *
 * 遠くの行き先は、この距離ずつ目印を置き直して繋いでいくので、
 * 短くしても「遠くまで歩く」ことは変わらない(道中の折り返しが増えるだけ)。
 */
export const WAYPOINT_MAX = 32;

/** ウェイポイントに着いたとみなす距離(ブロック)。 */
export const ARRIVE_DIST = 3.0;

/** 1本の道のりを諦めるまで(tick)。届かない場所を狙い続けないための歯止め。 */
export const LEG_TIMEOUT = 900;

/** 熊が「動いていない」とみなす1周期あたりの移動量(ブロック)。 */
export const STUCK_DIST = 0.6;

/** 何周期続けて動かなかったら詰まったとみなすか。 */
export const STUCK_LIMIT = 6;

/**
 * 詰まったときに助けるか。
 *
 * true だと、詰まった熊が**本当にブロックの中に食い込んでいるか**を確かめ、
 * 食い込んでいれば近くの立てる場所へ移す。食い込んでいなければ何もしない
 * （道のりの引き直しだけで済ませる）。false にすると引き直しだけになる。
 *
 * **「動かない＝救出」ではない。** ただ立ち止まっているだけの熊を動かすと、
 * 地形を無視した瞬間移動になって「徘徊」に見えなくなる。
 */
export const STUCK_RECOVER = true;

/** 埋まった熊を助けるときに、立てる場所を探す半径(ブロック)。 */
export const STUCK_RESCUE_RANGE = 3;

/**
 * 詰まったまま道のりを引き直す最短間隔(tick)。
 * 毎周期(0.5秒)引き直すと、その熊が走査の枠を占領して他の熊まで止まる。
 */
export const STUCK_REPLAN_WAIT = 60;

/** 同じ理由のログを繰り返し出さない間隔(tick)。連発を抑える。 */
export const LOG_REPEAT_INTERVAL = 200;

/** スポーン地点(縄張りの中心)から離れられる最大距離(ブロック)。超えたら戻る。 */
export const HOME_RANGE = 220;

// ---------------------------------------------------------------------------
// 個体差
// ---------------------------------------------------------------------------

/**
 * 個体特性。すべて 0.0〜1.0。spawn時に決まり、その熊が消えるまで変わらない。
 *
 *   aggression      … 攻撃性。高いほど遠くのプレイヤーにも向かう
 *   bravery         … 度胸。高いほど撃たれても逃げない
 *   hunger          … 空腹。高いほど食べ物を探す間隔が短い
 *   foodSeeking     … 食料優先。高いほど家・チェストを優先する
 *   urbanPreference … 市街地志向。高いほど町なかのルートを選び、探索半径も伸びる
 */
export const TRAITS = ["aggression", "bravery", "hunger", "foodSeeking", "urbanPreference"];

/** 特性の分布。0.5を中心に振れる幅。1.0にすると 0〜1 の一様乱数になる。 */
export const TRAIT_SPREAD = 0.9;

/**
 * 1周期あたり空腹がどれだけ増すか。
 *
 * **これが無いと空腹は減る一方**になる。食べると下がる仕組みだけがあって、
 * 上がる仕組みが無かったので、一度食べた熊は二度と腹が減らなかった。
 * 0.0015 で、満腹から空腹まで約6分。
 */
export const HUNGER_GAIN = 0.0015;

/**
 * 空腹・食料優先が「道中で家探しを始める」確率にどれだけ効くか。
 * 大きくするほど、腹の減った熊がすぐ家へ向かう。
 */
export const HOUSE_SEEK_CHANCE = 0.5;

// ---------------------------------------------------------------------------
// 徘徊ルート（指示書 Route A〜E）
// ---------------------------------------------------------------------------

/**
 * ルートは「行き先の種類」の並び。1つ着いたら次へ進み、最後まで行ったら先頭に戻る。
 *
 * 行き先の種類:
 *   forest  … 木・葉のある場所      water … 水面
 *   farm    … 畑・作物              road  … 道路
 *   high    … 周りより高い場所(山)  house … 家(ドア)
 *   edge    … 市街地の外れ(家が見える範囲のいちばん外)
 *   home    … 湧いた場所(縄張りの中心)
 *
 * weight は「その特性が高い個体ほど選ばれやすい」重み。
 */
export const ROUTES = {
  A: {
    label: "水路型",
    legs: ["forest", "water", "farm", "house"],
    weight: { foodSeeking: 1.0, urbanPreference: 0.3 },
  },
  B: {
    label: "道路型",
    legs: ["forest", "road", "house"],
    weight: { urbanPreference: 0.8 },
  },
  C: {
    label: "境界型",
    legs: ["high", "edge", "home"],
    weight: { bravery: -0.5, urbanPreference: -0.8 },
  },
  D: {
    label: "食料型",
    legs: ["house", "house", "house"],
    weight: { foodSeeking: 1.2, hunger: 0.8 },
  },
  E: {
    label: "侵入型",
    legs: ["house", "road", "house", "edge"],
    weight: { urbanPreference: 1.2, aggression: 0.4 },
  },
};

// ---------------------------------------------------------------------------
// 走査（重さの管理）
// ---------------------------------------------------------------------------

/**
 * 熊の面倒を見る間隔(tick)。指示書の「探索間隔：10〜20tick」。
 * **毎tickの全探索は禁止。** 1周期で全頭を1回ずつ見る。
 */
export const TICK_INTERVAL = 10;

/** 1周期に面倒を見る熊の最大数。増やすと重くなる。 */
export const BEARS_PER_TICK = 8;

/**
 * ブロック走査の1tickあたりの上限(個)。
 * 家探しは半径24×高さ8で約2万ブロックあるので、必ず何tickかに分けて読む。
 */
export const SCAN_BUDGET = 700;

/** 家を探すときに読む高さの幅(熊の足元からの相対)。 */
export const HOUSE_SCAN_Y = { from: -4, to: 4 };

/** チェストを探すときに読む高さの幅(熊の足元からの相対)。 */
export const CHEST_SCAN_Y = { from: -3, to: 4 };

/** 地形(森・水・畑・道路)を探すときの間引き。4なら4ブロックおきに1本だけ読む。 */
export const TERRAIN_STEP = 4;

/** 地形を探す半径(ブロック)。 */
export const TERRAIN_RANGE = 64;

/** 走査が同時に走る本数の上限。多いと1tickの予算を食い合って全部遅くなる。 */
export const SCAN_JOBS_MAX = 3;

/**
 * 走査の返事を待つ時間の上限(tick)。
 * 返事が来ないまま待ち続けると、その熊は一歩も動かなくなる。
 * 実機で「熊はいるのに何もしない」を出したので、必ず時間で待つのをやめる。
 */
export const PENDING_TIMEOUT = 200;

// ---------------------------------------------------------------------------
// 表示・記録
// ---------------------------------------------------------------------------

/** 状態が変わったときにログを出すか。/function bear_debug_on で切り替わる。 */
export const DEBUG_DEFAULT = false;

/** 熊の名札に今の状態を出すか(デバッグ時)。 */
export const DEBUG_NAMETAG = true;

/** 1つのワールドに置ける熊の数の上限。超えると自然湧きを断る。 */
export const MAX_BEARS = 24;

/** /function bear_spawn で一度に出す頭数。 */
export const SPAWN_COUNT = 3;

/** /function bear_spawn でプレイヤーから離す距離(ブロック)。 */
export const SPAWN_DISTANCE = 28;
