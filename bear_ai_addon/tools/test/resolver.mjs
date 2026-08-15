/**
 * "@minecraft/server" の読み込みを、机上試験用の偽物(mcstub.mjs)に差し替える。
 *
 * これで **本物のスクリプトをそのまま** Node で動かせる。
 * 試験用にコードを写して直すと、写し間違いで「試験は通るが実機は動かない」に
 * なるので、写さない。
 */

export async function resolve(specifier, context, next) {
  if (specifier === "@minecraft/server") {
    return { url: new URL("./mcstub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
