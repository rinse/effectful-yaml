/**
 * ブラウザ向けバンドル用の node:util シム。
 * src/index.ts が preserve.ts（isDeepStrictEqual を使う）を再エクスポートするので、
 * esbuild は node:util を解決しないとバンドルできない。playground/entry.ts は
 * renderPreserving を再エクスポートしないので、この関数はバンドルからは
 * tree-shaking で消える。
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
