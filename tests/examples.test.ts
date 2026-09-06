/**
 * examples/ の文書を評価して結果を固定する。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateYaml, type EvaluateOptions } from '../src/index.js';

async function runExample(name: string, options?: EvaluateOptions) {
  const doc = await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
  return evaluateYaml(doc, options);
}

describe('examples', () => {
  it('external-params.yaml は未渡しなら $default、渡せばその値を使う', async () => {
    await expect(runExample('external-params.yaml')).resolves.toEqual({
      param: { number: 80, object: { yaml: false } },
    });
    await expect(
      runExample('external-params.yaml', { params: { x: 8080, y: { yaml: true } } }),
    ).resolves.toEqual({
      param: { number: 8080, object: { yaml: true } },
    });
  });

  it('fizzbuzz.yaml は 1..15 の fizzbuzz を選択で並べる', async () => {
    await expect(runExample('fizzbuzz.yaml')).resolves.toEqual([
      1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz',
    ]);
  });

  it('handling-effects.yaml は自作の eff.throw を再開で、標準演算 std.each を自作の節で処理する', async () => {
    const logs: unknown[] = [];
    await expect(runExample('handling-effects.yaml', { onLog: (v) => logs.push(v) })).resolves.toEqual({
      'handling-user-defined-effects': { key1: 'Hello!', key2: 'Beautiful', key3: 'World!' },
      // 継続はハンドラ本体全体に及ぶので、マッピング全体が分岐ごとに複製される。
      'handling-system-defined-effects': [
        { key1: 'Hello!', key2: 2, key3: 'World!' },
        { key1: 'Hello!', key2: 4, key3: 'World!' },
        { key1: 'Hello!', key2: 6, key3: 'World!' },
      ],
    });
    expect(logs).toEqual(['[WARN] Error!']);
  });

  it('handler-values.yaml は $std.handler の値を引数で調整して複数の本体に掛ける', async () => {
    await expect(runExample('handler-values.yaml')).resolves.toEqual({ n: 0, s: '', ok: 7 });
  });

  it('list-operations.yaml は map / filter / flatMap / firstItem を固定する', async () => {
    await expect(runExample('list-operations.yaml')).resolves.toEqual({
      map: [2, 3, 4],
      filter: [1, 3, 5, 7],
      flatMap: [1, 1, 2, 2, 3, 3],
      firstItem: 1,
    });
  });

  it('maybe.yaml は失敗を $std.opt が null または $default に翻訳する', async () => {
    const logs: unknown[] = [];
    await expect(runExample('maybe.yaml', { onLog: (v) => logs.push(v) })).resolves.toEqual({
      'without-default': null,
      'with-default': 'Good to go!',
    });
    expect(logs).toEqual(['[DEBUG] Hello, without default!', '[DEBUG] Hello, with default!']);
  });

  it('object-operations.yaml は mapValues / mapKeys / lookup を固定する', async () => {
    await expect(runExample('object-operations.yaml')).resolves.toEqual({
      mapValues: { x: 'hello, world', y: 'world, world' },
      mapKeys: { x1: 'hello', y1: 'world' },
      lookingUp: 10,
    });
  });

  it('state.yaml は状態の貫流・入れ子・$do 文の $std.state を固定する', async () => {
    await expect(runExample('state.yaml')).resolves.toEqual({
      'set-and-get': 'world',
      'catch-uninitialized-cell-error': 'Uninitialized value!',
      'nested-states': ['hello', ['bonjour', 'marie'], 'world'],
      'with-do': ['hello', 'world'],
    });
  });
});
