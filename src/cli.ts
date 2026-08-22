/**
 * eff-yaml CLI の本体。
 * 入出力を注入できるよう run() に切り出し、プロセスへの接続は bin.ts が行う。
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { evaluateYaml, renderPreserving, type Value } from './index.js';

export interface CliIo {
  stdin: AsyncIterable<Buffer | string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `\
Usage: eff-yaml [file] [-p name=value]...

effectful-yaml 文書を評価し、結果を YAML で標準出力に書く。
$std.log の中身は標準エラー出力に書く。

  file             入力ファイル。省略時と "-" は標準入力。
  -p, --param      起動時パラメータ。値は YAML として解釈する。繰り返し可。
  -h, --help       このヘルプ。
`;

function logLine(v: Value): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
}

function parseParams(pairs: string[]): Record<string, Value> {
  const params: Record<string, Value> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--param には name=value の形を渡す: ${pair}`);
    params[pair.slice(0, eq)] = parse(pair.slice(eq + 1)) as Value;
  }
  return params;
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let source = '';
  for await (const chunk of stream) source += chunk;
  return source;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        param: { type: 'string', short: 'p', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (positionals.length > 1) throw new Error(`入力ファイルは一つだけ指定できる: ${positionals.join(', ')}`);
    const file = positionals[0];
    const source = file === undefined || file === '-' ? await readAll(io.stdin) : await readFile(file, 'utf8');
    const value = await evaluateYaml(source, {
      params: parseParams(values.param ?? []),
      onLog: (v) => io.stderr(logLine(v) + '\n'),
    });
    io.stdout(renderPreserving(source, value));
    return 0;
  } catch (e) {
    io.stderr(`eff-yaml: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
