/**
 * examples/ の文書を評価して結果を固定する。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateYaml } from '../src/index.js';

async function runExample(name: string) {
  const doc = await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
  return evaluateYaml(doc);
}

describe('examples', () => {
  it('hello100.eyaml は hello を 100 個並べる', async () => {
    await expect(runExample('hello100.eyaml')).resolves.toEqual(Array(100).fill('hello'));
  });

  it('range.yaml は自己適用の range で hello を 100 個並べる', async () => {
    await expect(runExample('range.yaml')).resolves.toEqual(Array(100).fill('hello'));
  });

  it('docker-compose.yaml のような作用を含まない文書は、それ自身に評価される（identity）', async () => {
    await expect(runExample('docker-compose.yaml')).resolves.toEqual({
      services: {
        nginx: {
          image: 'nginx:alpine',
          ports: ['8080:80'],
        },
      },
    });
  });
});
