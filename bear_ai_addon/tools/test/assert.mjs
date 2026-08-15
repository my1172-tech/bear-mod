/** 机上試験の小さな判定係。落ちたら終了コード 1 で終わる。 */

let passed = 0;
const failures = [];

export function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failures.push(label);
    console.log(`  NG   ${label}`);
  }
  return !!cond;
}

export function fail(label) {
  failures.push(label);
  console.log(`  NG   ${label}`);
}

export function near(value, expect, tolerance, label) {
  return ok(Math.abs(value - expect) <= tolerance, `${label} (${value} ≒ ${expect}±${tolerance})`);
}

export function report(title) {
  console.log(`\n[${title}] 通過 ${passed} / 失敗 ${failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}
