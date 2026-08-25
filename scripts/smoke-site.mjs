#!/usr/bin/env node
/**
 * site/ ビルド後の煙テスト。site/effectful-yaml.js を実際に import して
 * サンプルを評価し、結果が既知の値と一致するかを確認する。
 *
 * ブラウザには process / Buffer が無い。Node ではこれらが暗黙の
 * グローバルとして存在するため、バンドルへの混入は import 解決の
 * エラーにならず素通りしてしまう（node:util 等の import 文と違い、
 * バンドル時に検出できない）。ここでは import 前に両方を消し、
 * 評価がバレなく走ることでバンドルが実際に参照していないことを確認する。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const siteDir = path.join(root, 'site');

for (const name of ['index.html', 'examples/index.json']) {
  assert.ok(existsSync(path.join(siteDir, name)), `site/${name} が存在しません`);
}

const cases = [
  {
    file: 'fizzbuzz.yaml',
    expected: [1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz'],
  },
  {
    file: 'state.yaml',
    expected: {
      'set-and-get': 'world',
      'catch-uninitialized-cell-error': 'Uninitialized value!',
      'nested-states': ['hello', ['bonjour', 'marie'], 'world'],
      'with-do': ['hello', 'world'],
    },
  },
];
const sources = new Map();
for (const { file } of cases) {
  sources.set(file, await readFile(path.join(siteDir, 'examples', file), 'utf8'));
}

delete globalThis.process;
delete globalThis.Buffer;

const { evaluateYaml } = await import(path.join(siteDir, 'effectful-yaml.js'));

for (const { file, expected } of cases) {
  const result = await evaluateYaml(sources.get(file));
  assert.deepStrictEqual(result, expected, `${file} の評価結果が期待値と一致しません`);
  console.log(`ok: ${file}`);
}

console.log('smoke-site: all checks passed (process/Buffer 非依存も確認)');
