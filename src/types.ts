/**
 * effectful-yaml の値・環境・計算表現。
 * 仕様: docs/grammar.md（草案 0.3）
 */

/** 評価結果の値。YAML のデータ値に、言語内部の関数値（Closure / OpRef）を加えたもの。 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value }
  | Closure
  | OpRef;

/**
 * $fn が作る閉包。YAML データからは決して作れない値なので、
 * データとの混同を避けるためクラス（instanceof で判別可能）にする。
 * body は未評価の YAML ノードを保持する。
 */
export class Closure {
  constructor(
    readonly param: string,
    readonly body: unknown,
    readonly env: Env,
  ) {}
}

/** $op が作る、演算への参照（イータ展開）。 */
export class OpRef {
  constructor(readonly name: string) {}
}

export const isClosure = (v: unknown): v is Closure => v instanceof Closure;
export const isOpRef = (v: unknown): v is OpRef => v instanceof OpRef;

/**
 * レキシカル環境。拡張はコピーで行い、閉包が捕まえた環境は決して変化しない。
 * resume は $handle の節の本体でだけ束縛される継続（レキシカルスコープ）。
 */
export interface Env {
  readonly vars: ReadonlyMap<string, Value>;
  readonly resume?: (v: Value) => Comp;
}

export const emptyEnv: Env = { vars: new Map() };

// ponytail: 拡張のたびに Map を全コピーする O(n)。文書の束縛数は小さい前提。
// 実測で問題になったら親チェーン式の永続構造にする。
export function extendEnv(env: Env, name: string, value: Value): Env {
  const vars = new Map(env.vars);
  vars.set(name, value);
  return env.resume !== undefined ? { vars, resume: env.resume } : { vars };
}

export function lookupEnv(env: Env, name: string): Value | undefined {
  return env.vars.get(name);
}

/**
 * freer モナド風の計算表現。
 * 評価器はこの木を返し、ハンドラは Comp → Comp の純粋変換として実装する。
 * resume が純粋クロージャなので、同じ継続を何度でも呼べる（$handle の多重 resume）。
 */
export type Comp =
  | { readonly tag: 'pure'; readonly value: Value }
  | {
      readonly tag: 'op';
      readonly name: string;
      readonly arg: Value;
      readonly resume: (v: Value) => Comp;
    };

export const pure = (value: Value): Comp => ({ tag: 'pure', value });

export const perform = (name: string, arg: Value): Comp => ({
  tag: 'op',
  name,
  arg,
  resume: pure,
});

// ponytail: 左結合の bind 連鎖は O(n^2)。文書が大きくなり実測で問題になったら
// 継続キュー（右結合化）にする。
export function bind(c: Comp, f: (v: Value) => Comp): Comp {
  if (c.tag === 'pure') return f(c.value);
  return { tag: 'op', name: c.name, arg: c.arg, resume: (v) => bind(c.resume(v), f) };
}

/** 言語仕様の「エラー」。fail 作用（$fail）とは別物で、ハンドラでは捕捉できない。 */
export class EffectfulYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectfulYamlError';
  }
}

/** 選択の作用に属する演算。境界にこれが残ると値はリストになる。 */
export const CHOICE_OPS: ReadonlySet<string> = new Set(['each', 'where']);

/** 状態の作用に属する演算。 */
export const STATE_OPS: ReadonlySet<string> = new Set(['get', 'set']);

/** 標準演算（ドットなしで $op から参照できるもの）。 */
export const STD_OPS: ReadonlySet<string> = new Set([
  'each',
  'where',
  'param',
  'get',
  'set',
  'log',
  'fail',
]);
