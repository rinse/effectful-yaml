/**
 * eff-yaml CLI の run() を偽の入出力で検査する。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const pkgVersion = createRequire(import.meta.url)('../package.json').version as string;

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function runCli(argv: string[], stdin = ''): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdin: (async function* () {
      yield stdin;
    })(),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe('eff-yaml CLI', () => {
  it('標準入力の文書を評価して YAML を標準出力に書く', async () => {
    const r = await runCli(
      ['-p', 'db_host=example.com'],
      'server: {host: {$std.param: db_host}, port: {$std.param: db_port, $default: 5432}}',
    );
    expect(r.code).toBe(0);
    // 島は二つの $std.param だけなので、原文のフロー形式が保たれる。
    expect(r.out).toBe('server: {host: "example.com", port: 5432}\n');
    expect(r.err).toBe('');
  });

  it('前置きの $ キーは出力から消え、データのキーのコメントは残る', async () => {
    const r = await runCli([], '$let:\n  greeting: hello\nmessage: ${greeting}   # 挨拶\n');
    expect(r.code).toBe(0);
    expect(r.out).toBe('message: hello   # 挨拶\n');
    expect(r.err).toBe('');
  });

  it('パラメータの値は YAML として解釈される', async () => {
    const r = await runCli(['-p', 'n=3'], 'value: {$std.param: n}');
    expect(r.code).toBe(0);
    expect(r.out).toBe('value: 3\n');
  });

  it('$std.log は標準エラー出力に出る', async () => {
    const r = await runCli([], '{$do: [{$std.log: working}, done]}');
    expect(r.code).toBe(0);
    expect(r.out).toBe('done\n');
    expect(r.err).toBe('working\n');
  });

  it('$std.fail は終了コード 1 とエラーメッセージになる', async () => {
    const r = await runCli([], '{$std.fail: boom}');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('failure: boom');
  });

  it('name=value の形でない --param は拒否する', async () => {
    const r = await runCli(['-p', 'oops'], 'null');
    expect(r.code).toBe(1);
    expect(r.err).toContain('name=value');
  });

  it('--version は eff-yaml とバージョンを標準出力に書く', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith('eff-yaml ')).toBe(true);
    expect(r.out).toContain(pkgVersion);
  });

  describe('--ops', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('モジュールの default export を登録演算として使う', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'ops.mjs');
      await writeFile(opsFile, "export default { 'str.upper': (s) => String(s).toUpperCase() };", 'utf8');
      const r = await runCli(['--ops', opsFile], 'a: {$str.upper: hello}');
      expect(r.code).toBe(0);
      expect(r.out).toBe('a: "HELLO"\n');
    });

    it('モジュールが投げた OperationFailure は文書側で捕捉できる', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'ops.mjs');
      // モジュールが別の複製の effectful-yaml を import していても通知として扱われる（名前と value で判定する）。
      await writeFile(
        opsFile,
        `class OperationFailure extends Error {
  constructor(value) { super(String(value)); this.name = 'OperationFailure'; this.value = value; }
}
export default { 'env.get': (name) => { throw new OperationFailure('environment variable not set: ' + name); } };
`,
        'utf8',
      );
      const ok = await runCli(['--ops', opsFile], 'home: {$std.opt: {$env.get: HOME}, $default: /}');
      expect(ok.code).toBe(0);
      expect(ok.out).toBe('home: "/"\n');
      const ng = await runCli(['--ops', opsFile], 'home: {$env.get: HOME}');
      expect(ng.code).toBe(1);
      expect(ng.err).toContain('failure: environment variable not set: HOME');
    });

    it('-o と組み合わせるとヘッダに --ops が含まれる', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'ops.mjs');
      const outFile = join(dir, 'out.yaml');
      await writeFile(opsFile, "export default { 'str.upper': (s) => String(s).toUpperCase() };", 'utf8');
      const r = await runCli(['--ops', opsFile, '-o', outFile], 'a: {$str.upper: hello}');
      expect(r.code).toBe(0);
      const written = await readFile(outFile, 'utf8');
      expect(written.split('\n')[0]).toContain(` --ops ${opsFile}`);
    });

    it('存在しないモジュールを指定すると終了コード 1 でエラーになる', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'nope.mjs');
      const r = await runCli(['--ops', opsFile], 'a: 1');
      expect(r.code).toBe(1);
      expect(r.err).not.toBe('');
    });

    it('default export が配列だと終了コード 1', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'bad.mjs');
      await writeFile(opsFile, 'export default [1, 2, 3];', 'utf8');
      const r = await runCli(['--ops', opsFile], 'a: 1');
      expect(r.code).toBe(1);
      expect(r.err).toContain('--ops');
    });

    it('default export の値が関数でないと終了コード 1', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'bad.mjs');
      await writeFile(opsFile, "export default { 'str.upper': 42 };", 'utf8');
      const r = await runCli(['--ops', opsFile], 'a: 1');
      expect(r.code).toBe(1);
      expect(r.err).toContain('--ops');
    });
  });

  describe('-o, --output', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('指定したファイルに書き、標準出力には出さない', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const outFile = join(dir, 'out.yaml');
      const r = await runCli(['-o', outFile], 'value: 1');
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      const written = await readFile(outFile, 'utf8');
      expect(written).toBe('# Code generated by eff-yaml; DO NOT EDIT.\nvalue: 1\n');
    });

    it('ファイル入力かつ -p 複数指定でヘッダにそのまま並べる', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const inFile = join(dir, 'config.eyaml');
      const outFile = join(dir, 'out.yaml');
      await writeFile(inFile, 'value: {$std.param: n}', 'utf8');
      const r = await run(['-p', 'env=prod', '-p', 'n=1', '-o', outFile, inFile], {
        stdin: (async function* () {})(),
        stdout: () => {},
        stderr: () => {},
      });
      expect(r).toBe(0);
      const written = await readFile(outFile, 'utf8');
      expect(written.split('\n')[0]).toBe(
        `# Code generated by eff-yaml from ${inFile} -p env=prod -p n=1; DO NOT EDIT.`,
      );
    });

    it('評価に失敗したときは出力ファイルを書かない', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const outFile = join(dir, 'out.yaml');
      const r = await runCli(['-o', outFile], '{$std.fail: boom}');
      expect(r.code).toBe(1);
      expect(r.err).toContain('failure: boom');
      await expect(readFile(outFile, 'utf8')).rejects.toThrow();
    });
  });

  describe('--check', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('--ops 付きで書いたファイルは --ops 付きの --check が最新と判定する', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const opsFile = join(dir, 'ops.mjs');
      const outFile = join(dir, 'out.yaml');
      await writeFile(opsFile, "export default { 'str.upper': (s) => String(s).toUpperCase() };", 'utf8');
      const argv = ['--ops', opsFile, '-o', outFile];
      await runCli(argv, 'a: {$str.upper: hello}');
      const r = await runCli([...argv, '--check'], 'a: {$str.upper: hello}');
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toBe('');
    });

    it('出力ファイルが最新なら 0 で何も出力しない', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const outFile = join(dir, 'out.yaml');
      await runCli(['-o', outFile], 'value: 1');
      const r = await runCli(['-o', outFile, '--check'], 'value: 1');
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toBe('');
    });

    it('出力ファイルが古いと 1 で、ファイル名・再生成コマンド・差分を書く', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const inFile = join(dir, 'config.eyaml');
      const outFile = join(dir, 'out.yaml');
      await writeFile(inFile, 'value: {$std.param: n}', 'utf8');
      await writeFile(outFile, `# Code generated by eff-yaml from ${inFile} -p n=1; DO NOT EDIT.\nvalue: 0\n`, 'utf8');
      let out = '';
      let err = '';
      const r = await run(['-p', 'n=1', '-o', outFile, '--check', inFile], {
        stdin: (async function* () {})(),
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
      });
      expect(r).toBe(1);
      expect(out).toBe('');
      expect(err).toContain(outFile);
      expect(err).toContain(`eff-yaml ${inFile} -p n=1 -o ${outFile}`);
      expect(err).toContain('-value: 0');
      expect(err).toContain('+value: 1');
    });

    it('出力ファイルが存在しないと 1 で、再生成コマンドだけを書く', async () => {
      dir = await mkdtemp(join(tmpdir(), 'eff-yaml-'));
      const outFile = join(dir, 'out.yaml');
      const r = await runCli(['-o', outFile, '--check'], 'value: 1');
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain(outFile);
      expect(r.err).toContain(`eff-yaml -o ${outFile}`);
    });

    it('-o なしの --check はエラーで終了コード 1', async () => {
      const r = await runCli(['--check'], 'value: 1');
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('--check');
      expect(r.err).toContain('-o');
    });
  });
});
