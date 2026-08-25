#!/usr/bin/env node
/**
 * playground/ を site/ にビルドする。
 * - playground/entry.ts を esbuild でバンドルして site/effectful-yaml.js を作る
 * - index.html / style.css / app.js を site/ へコピー
 * - examples/*.yaml を site/examples/ へコピーし、ファイル名一覧を index.json として書き出す
 */
import * as esbuild from 'esbuild';
import { mkdir, cp, readdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const siteDir = path.join(root, 'site');

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'playground/entry.ts')],
  outfile: path.join(siteDir, 'effectful-yaml.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  // src/index.ts が src/preserve.ts を再エクスポートしており、preserve.ts は
  // node:util の isDeepStrictEqual を使う。ブラウザには node:util が無いので
  // 同等の最小シムに差し替える。
  alias: { 'node:util': path.join(root, 'scripts/node-util-shim.mjs') },
});

for (const file of ['index.html', 'style.css', 'app.js']) {
  await cp(path.join(root, 'playground', file), path.join(siteDir, file));
}

const examplesDir = path.join(root, 'examples');
const siteExamplesDir = path.join(siteDir, 'examples');
await mkdir(siteExamplesDir, { recursive: true });
const names = (await readdir(examplesDir)).filter((name) => name.endsWith('.yaml')).sort();
for (const name of names) {
  await cp(path.join(examplesDir, name), path.join(siteExamplesDir, name));
}
await writeFile(path.join(siteExamplesDir, 'index.json'), JSON.stringify(names, null, 2));

console.log(`built site/ with ${names.length} example(s)`);
