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
  it('hello100.eyaml は hello を 100 個並べる', async () => {
    await expect(runExample('hello100.eyaml')).resolves.toEqual(Array(100).fill('hello'));
  });

  it('range.yaml は $std.range と $collect で hello を 100 個並べる', async () => {
    await expect(runExample('range.yaml')).resolves.toEqual(Array(100).fill('hello'));
  });

  it('throw.yaml は $.throw をハンドラが失敗に翻訳し、打ち切りで終わる', async () => {
    const logs: unknown[] = [];
    await expect(runExample('throw.yaml', { onLog: (v) => logs.push(v) })).rejects.toThrow(
      'failure: error message',
    );
    // 打ち切りなので start だけが流れ、unreachable には到達しない。
    expect(logs).toEqual(['start']);
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
