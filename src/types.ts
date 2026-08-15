/**
 * effectful-yaml の値・環境・計算表現。
 * 仕様: docs/grammar.md（草案 0.3）
 */
import { empty, get, insert, type PMap } from './pmap.js';

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
 * レキシカル環境。名前 -> 値の永続平衡木（src/pmap.ts）と、$handle の節の本体でだけ
 * 束縛される継続 resume の組。木は不変なので、閉包が捕まえた環境は後から変化しない
 * （拡張は経路だけを作り直し、元の木はそのまま残る）。
 * 読み書きとも最悪 O(log 束縛数)：get は根から降りるだけ、insert の複製は経路上のノードだけ。
 * シャドーイングは同じキーの上書き、resume の入れ替えはフィールドの差し替えで表す。
 */
export interface Env {
  readonly vars: PMap<Value>;
  readonly resume?: (v: Value) => Comp;
}

export const emptyEnv: Env = { vars: empty };

/** 束縛を一つ足した環境。resume は引き継ぐ（$let を挟んでも節の継続は見えたまま）。 */
export const extendEnv = (env: Env, name: string, value: Value): Env => ({
  vars: insert(env.vars, name, value),
  resume: env.resume,
});

export const lookupEnv = (env: Env, name: string): Value | undefined => get(env.vars, name);

/** $handle の節の本体でだけ束縛される継続。 */
export const resumeOf = (env: Env): ((v: Value) => Comp) | undefined => env.resume;

/**
 * freer モナド風の計算表現。
 * 評価器はこの木を返し、ハンドラは Comp → Comp の純粋変換として実装する。
 * resume が純粋クロージャなので、同じ継続を何度でも呼べる（$handle の多重 resume）。
 *
 * bind は継続を「呼ばずに」節として積むだけである。これが表現の不変条件を決める。
 *
 *   消費側は必ず force() を通してから tag を見る。生の Comp に bind が残っている。
 *
 * bind が即座に f を呼ばないのは、そうしないと逐次組み立て
 * （リストの要素、マッピングの値、$do の文の並び）が要素数ぶんの再帰になり、
 * 数千要素でスタックが溢れるからである。積むだけなら深さは force() のループが引き受ける。
 */
export type Comp =
  | { readonly tag: 'pure'; readonly value: Value }
  | {
      readonly tag: 'op';
      readonly name: string;
      readonly arg: Value;
      readonly resume: (v: Value) => Comp;
    }
  | { readonly tag: 'bind'; readonly comp: Comp; readonly fn: (v: Value) => Comp };

/** force() が返す形。bind を剥がし終えた Comp。 */
export type Forced = Extract<Comp, { tag: 'pure' | 'op' }>;

export const pure = (value: Value): Comp => ({ tag: 'pure', value });

export const perform = (name: string, arg: Value): Comp => ({
  tag: 'op',
  name,
  arg,
  resume: pure,
});

export const bind = (c: Comp, f: (v: Value) => Comp): Comp => ({ tag: 'bind', comp: c, fn: f });

/**
 * bind を剥がして pure か op にする。
 * モナド結合律 `(m >>= f) >>= g  ==  m >>= (\v -> f v >>= g)` で右結合化するだけで、
 * 演算そのものは実行しない。一段ごとに O(1)、再帰は使わない。
 *
 * 右結合化が作る合成継続 `g_k = v => bind(f_k(v), g_{k+1})` は、呼ぶと元の f_k だけを
 * 呼び、g_{k+1} は bind へ「データとして」渡す。だから合成が何段積もうと入れ子の呼び出しにならず、
 * ほどくのはこのループの仕事になる。resume の作り直しも一段ぶん O(1) で済む。
 */
export function force(c: Comp): Forced {
  let cur = c;
  for (;;) {
    if (cur.tag !== 'bind') return cur;
    const outer = cur;
    const m = outer.comp;
    if (m.tag === 'pure') {
      cur = outer.fn(m.value);
      continue;
    }
    if (m.tag === 'op') {
      return {
        tag: 'op',
        name: m.name,
        arg: m.arg,
        resume: (v) => bind(m.resume(v), outer.fn),
      };
    }
    cur = { tag: 'bind', comp: m.comp, fn: (v) => bind(m.fn(v), outer.fn) };
  }
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
