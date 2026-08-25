/**
 * ブラウザ向けバンドル用の node:util シム。
 * src/preserve.ts が isDeepStrictEqual を使うが、preserve.ts 自体は
 * src/index.ts からの再エクスポート経由でバンドルの依存グラフに載る
 * （entry.ts は renderPreserving を使わないが、静的な再エクスポートなので
 * esbuild は preserve.ts を解決しないとバンドルできない）。実際には
 * entry.ts から renderPreserving を辿る経路が無いため、この関数の本体は
 * 現状 tree-shaking で出力から消える（＝ここでの正しさは import 解決を
 * 通すためだけに効いており、今のところ実行時には走らない）。将来
 * entry.ts が renderPreserving を再エクスポートした場合に初めて生きる。
 *
 * ponytail: JSON 相当の値（Value 型: 文字列・数値・真偽・null・配列・
 * プレーンオブジェクト）だけを比較できれば十分なので、Node の完全な
 * 意味論（循環参照・Symbol・型付き配列等）は再現しない。
 */
export function isDeepStrictEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = /** @type {unknown[]} */ (b);
    return a.length === bArr.length && a.every((v, i) => isDeepStrictEqual(v, bArr[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(/** @type {object} */ (b));
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && isDeepStrictEqual(a[k], b[k]))
  );
}
