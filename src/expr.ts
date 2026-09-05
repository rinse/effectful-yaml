/**
 * `${式}` の式言語（参照・比較・算術・論理演算）と文字列補間。
 * 仕様: docs/grammar.md（草案 0.9）「参照と式」節。
 *
 * この式言語に作用は無い。Value と Env だけを相手にする純粋な関数として実装する。
 * 作用を起こしうるのはパスの部分性だけで、それも MissingPathError を投げるにとどめ、
 * std.fail への翻訳は評価器（eval.ts の compose）が行う。
 */
import { EffectfulYamlError, isClosure, lookupEnv, type Env, type Value } from './types.js';

/**
 * データ起因の部分性：存在しないキーと添字。
 * 文書の形の誤り（未定義の束縛、非コンテナの走査、型の不一致）とは区別され、
 * 評価器がこれを失敗作用 std.fail に翻訳するのでハンドラで捕捉できる。
 */
export class MissingPathError extends EffectfulYamlError {}

// ---------------------------------------------------------------------------
// トークナイザ
// ---------------------------------------------------------------------------

type Tok =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'id'; readonly v: string }
  | { readonly t: 'op'; readonly v: string }
  | { readonly t: 'eof' };

const TWO_CHAR_OPS: ReadonlySet<string> = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = '!<>+-*/%().[]';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(src[j]!)) j++;
      if (src[j] === '.' && src[j + 1] !== undefined && isDigit(src[j + 1]!)) {
        j++;
        while (j < n && isDigit(src[j]!)) j++;
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) {
          val += src[j + 1];
          j += 2;
        } else {
          val += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new EffectfulYamlError(`unterminated string literal in expression: ${src}`);
      toks.push({ t: 'str', v: val });
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j]!)) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      toks.push({ t: 'op', v: c });
      i += 1;
      continue;
    }
    throw new EffectfulYamlError(`unexpected character '${c}' in expression: ${src}`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type PathSeg = { readonly k: 'key'; readonly name: string } | { readonly k: 'idx'; readonly i: number };

type BinOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

type Node =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'null' }
  | { readonly k: 'ref'; readonly name: string; readonly path: readonly PathSeg[] }
  | { readonly k: 'not'; readonly e: Node }
  | { readonly k: 'bin'; readonly op: BinOp; readonly l: Node; readonly r: Node };

// ---------------------------------------------------------------------------
// パーサー（再帰下降、grammar.md の EBNF をそのままなぞる）
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly toks: readonly Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos]!;
  }
  private advance(): Tok {
    return this.toks[this.pos++]!;
  }
  private expectOp(v: string): void {
    const t = this.advance();
    if (t.t !== 'op' || t.v !== v) {
      throw new EffectfulYamlError(`expected '${v}' in expression`);
    }
  }

  parseExpr(): Node {
    return this.parseOr();
  }

  finish(): void {
    if (this.peek().t !== 'eof') {
      throw new EffectfulYamlError('unexpected trailing tokens in expression');
    }
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '||') {
        this.advance();
        left = { k: 'bin', op: '||', l: left, r: this.parseAnd() };
        continue;
      }
      return left;
    }
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '&&') {
        this.advance();
        left = { k: 'bin', op: '&&', l: left, r: this.parseNot() };
        continue;
      }
      return left;
    }
  }

  private parseNot(): Node {
    const t = this.peek();
    if (t.t === 'op' && t.v === '!') {
      this.advance();
      return { k: 'not', e: this.parseNot() };
    }
    return this.parseCompare();
  }

  private static readonly COMPARE_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);

  private parseCompare(): Node {
    const left = this.parseAdd();
    const t = this.peek();
    if (t.t === 'op' && Parser.COMPARE_OPS.has(t.v)) {
      this.advance();
      return { k: 'bin', op: t.v as BinOp, l: left, r: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.advance();
        left = { k: 'bin', op: t.v, l: left, r: this.parseMul() };
        continue;
      }
      return left;
    }
  }

  private parseMul(): Node {
    let left = this.parseUnit();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        this.advance();
        left = { k: 'bin', op: t.v, l: left, r: this.parseUnit() };
        continue;
      }
      return left;
    }
  }

  private parseUnit(): Node {
    const t = this.advance();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'ref', name: t.v, path: this.parsePath() };
    }
    throw new EffectfulYamlError('unexpected token in expression');
  }

  private parsePath(): PathSeg[] {
    const path: PathSeg[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '.') {
        this.advance();
        const nameTok = this.advance();
        if (nameTok.t !== 'id') {
          throw new EffectfulYamlError("expected a name after '.' in reference");
        }
        path.push({ k: 'key', name: nameTok.v });
        continue;
      }
      if (t.t === 'op' && t.v === '[') {
        this.advance();
        const numTok = this.advance();
        if (numTok.t !== 'num' || !Number.isInteger(numTok.v) || numTok.v < 0) {
          throw new EffectfulYamlError('expected a natural number index in reference');
        }
        this.expectOp(']');
        path.push({ k: 'idx', i: numTok.v });
        continue;
      }
      return path;
    }
  }
}

function parse(source: string): Node {
  const parser = new Parser(tokenize(source));
  const node = parser.parseExpr();
  parser.finish();
  return node;
}

// ---------------------------------------------------------------------------
// 評価器
// ---------------------------------------------------------------------------

function isPlainObject(v: Value): v is { [key: string]: Value } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isClosure(v);
}

function deepEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]!));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k]!, b[k]!))
    );
  }
  return false;
}

function requireBoolean(v: Value, op: string): boolean {
  if (typeof v !== 'boolean') {
    throw new EffectfulYamlError(`'${op}' requires a boolean operand, got: ${JSON.stringify(v)}`);
  }
  return v;
}

function requireNumber(v: Value, op: string): number {
  if (typeof v !== 'number') {
    throw new EffectfulYamlError(`'${op}' requires a numeric operand, got: ${JSON.stringify(v)}`);
  }
  return v;
}

function evalNode(node: Node, env: Env): Value {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'str':
      return node.v;
    case 'bool':
      return node.v;
    case 'null':
      return null;
    case 'not':
      return !requireBoolean(evalNode(node.e, env), '!');
    case 'ref': {
      const base = lookupEnv(env, node.name);
      if (base === undefined) {
        throw new EffectfulYamlError(`undefined reference: ${node.name}`);
      }
      let cur: Value = base;
      for (const seg of node.path) {
        if (seg.k === 'key') {
          if (!isPlainObject(cur)) {
            throw new EffectfulYamlError(`cannot access key '.${seg.name}' of a non-mapping value`);
          }
          if (!Object.prototype.hasOwnProperty.call(cur, seg.name)) {
            throw new MissingPathError(`missing key '${seg.name}'`);
          }
          cur = cur[seg.name]!;
        } else {
          if (!Array.isArray(cur)) {
            throw new EffectfulYamlError(`cannot access index [${seg.i}] of a non-list value`);
          }
          if (seg.i >= cur.length) {
            throw new MissingPathError(`index [${seg.i}] out of range`);
          }
          cur = cur[seg.i]!;
        }
      }
      return cur;
    }
    case 'bin':
      return evalBin(node, env);
  }
}

function evalBin(node: Extract<Node, { k: 'bin' }>, env: Env): Value {
  const { op } = node;
  if (op === '&&') {
    const l = requireBoolean(evalNode(node.l, env), '&&');
    return l ? requireBoolean(evalNode(node.r, env), '&&') : false;
  }
  if (op === '||') {
    const l = requireBoolean(evalNode(node.l, env), '||');
    return l ? true : requireBoolean(evalNode(node.r, env), '||');
  }
  if (op === '==' || op === '!=') {
    const eq = deepEqual(evalNode(node.l, env), evalNode(node.r, env));
    return op === '==' ? eq : !eq;
  }
  const l = requireNumber(evalNode(node.l, env), op);
  const r = requireNumber(evalNode(node.r, env), op);
  switch (op) {
    case '<':
      return l < r;
    case '<=':
      return l <= r;
    case '>':
      return l > r;
    case '>=':
      return l >= r;
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      if (r === 0) throw new EffectfulYamlError('division by zero');
      return l / r;
    case '%':
      if (r === 0) throw new EffectfulYamlError('modulo by zero');
      return l % r;
  }
}

/** `${式}` の中身（`${` `}` を含まない）をパースして評価する。 */
export function evalExpr(source: string, env: Env): Value {
  return evalNode(parse(source), env);
}

// ---------------------------------------------------------------------------
// 補間
// ---------------------------------------------------------------------------

type Segment = { readonly kind: 'lit'; readonly text: string } | { readonly kind: 'expr'; readonly src: string };

/**
 * `${...}` の閉じ括弧を探す。式言語には文字列リテラル以外に `{` `}` が現れないため、
 * シングルクォート文字列の中の `}` だけを除外すればよい。
 */
function findExprEnd(s: string, start: number): number {
  let i = start;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") inString = false;
      i += 1;
      continue;
    }
    if (c === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (c === '}') return i;
    i += 1;
  }
  return -1;
}

/**
 * 左から右への素朴な走査で `$$` エスケープと `${式}` を切り出す。
 * `$$` は `${...}` として認識される前に literal `$` へ落とすので、
 * `$${x}` は `$` + `{x}`（プレーンな文字列）になる。
 */
function splitInterpolation(s: string): Segment[] {
  const segments: Segment[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    if (s[i] === '$' && s[i + 1] === '{') {
      if (buf.length > 0) {
        segments.push({ kind: 'lit', text: buf });
        buf = '';
      }
      const start = i + 2;
      const end = findExprEnd(s, start);
      if (end === -1) {
        throw new EffectfulYamlError(`unterminated \${...} in: ${s}`);
      }
      segments.push({ kind: 'expr', src: s.slice(start, end) });
      i = end + 1;
      continue;
    }
    buf += s[i];
    i += 1;
  }
  if (buf.length > 0) segments.push({ kind: 'lit', text: buf });
  return segments;
}

function stringifyForInterpolation(v: Value): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  throw new EffectfulYamlError('cannot interpolate a list, mapping, null, or function value into a string');
}

/**
 * `${式}` を含む生の YAML スカラー文字列を解決する。
 * 文字列全体がちょうど一つの `${式}` なら値そのもの（型を問わない）、
 * それ以外は各 `${式}` を文字列化して埋め込んだ文字列を返す。
 */
export function interpolate(scalar: string, env: Env): Value {
  const segments = splitInterpolation(scalar);
  if (segments.length === 1 && segments[0]!.kind === 'expr') {
    return evalExpr(segments[0]!.src, env);
  }
  let out = '';
  for (const seg of segments) {
    out += seg.kind === 'lit' ? seg.text : stringifyForInterpolation(evalExpr(seg.src, env));
  }
  return out;
}


/**
 * スカラー全体がちょうど一つの `${参照名}` なら、その参照名を区画に分けて返す。
 * `${a.b[0]}` は `['a', 'b', '0']`。演算や補間を含むスカラーは undefined。
 * 参照名の文法（grammar.md「参照と式」）を走査側が持ち直さずに済むよう、
 * 評価前の検査もこの式言語のパーサーを通す。パースできない文字列は
 * ここではエラーにせず undefined を返し、報告は評価時に任せる。
 */
export function refPathOf(scalar: string): string[] | undefined {
  let only: Segment | undefined;
  try {
    const segments = splitInterpolation(scalar);
    only = segments.length === 1 ? segments[0] : undefined;
  } catch {
    return undefined;
  }
  if (only === undefined || only.kind !== 'expr') return undefined;
  let node: Node;
  try {
    node = parse(only.src);
  } catch {
    return undefined;
  }
  if (node.k !== 'ref') return undefined;
  return [node.name, ...node.path.map((seg) => (seg.k === 'key' ? seg.name : String(seg.i)))];
}
