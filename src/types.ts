/**
 * effectful-yaml の値・環境・計算表現。
 * 仕様: docs/grammar.md（草案 0.11）
 */
import type { KNode } from './desugar.js';
import { empty, get, insert, type PMap } from './pmap.js';

/** 評価結果の値。YAML のデータ値に、言語内部の関数値（Closure）を加えたもの。 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | { [key: string]: Value }
  | Closure;

/**
 * $fn が作る閉包。YAML データからは決して作れない値なので、
 * データとの混同を避けるためクラス（instanceof で判別可能）にする。
 * body は未評価のカーネル AST を保持する。
 * params は 1 個以上。先頭が次の適用で束縛され、2 個以上残っていれば
 * 適用は残りを待つ閉包を返す（$fn の列の形のカリー化展開に一致する）。
 */
export class Closure {
  constructor(
    readonly params: readonly string[],
    readonly body: KNode,
    readonly env: Env,
  ) {}
}

export const isClosure = (v: unknown): v is Closure => v instanceof Closure;

/**
 * レキシカル環境。名前 -> 値の永続平衡木（src/pmap.ts）と、`$with` の節の本体でだけ
 * 束縛される継続 resume の組。失敗位置は AST のノードが持つので環境には入らない。木は不変なので、閉包が捕まえた環境は後から変化しない
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

/** `$with` の節の本体でだけ束縛される継続。 */
export const resumeOf = (env: Env): ((v: Value) => Comp) | undefined => env.resume;

/**
 * freer モナド風の計算表現。
 * 評価器はこの木を返し、ハンドラは Comp → Comp の純粋変換として実装する。
 * resume が純粋クロージャなので、同じ継続を何度でも呼べる（`$with` の多重 resume）。
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
      /** 呼び出し位置で std.fail を起こして続ける継続。ハンドラは resume と同じ包み直しを施す。 */
      readonly raise: (v: Value) => Comp;
      /**
       * 演算を起こした文書内の位置。境界を抜けてドライバに届いた失敗とホスト演算のエラーに添える。
       * 演算は組み立て時に位置を捕まえるしかない（ドライバまで来ると評価器の文脈は残っていない）。
       * ハンドラに捕まった演算では捨てられる（捕まった失敗は値なので位置を持たない）。
       */
      readonly path?: string;
    }
  | { readonly tag: 'bind'; readonly comp: Comp; readonly fn: (v: Value) => Comp };

/** force() が返す形。bind を剥がし終えた Comp。 */
export type Forced = Extract<Comp, { tag: 'pure' | 'op' }>;

export const pure = (value: Value): Comp => ({ tag: 'pure', value });

export const perform = (name: string, arg: Value, path?: string): Comp => ({
  tag: 'op',
  name,
  arg,
  resume: pure,
  raise: (v) => perform('std.fail', v, path),
  path,
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
        raise: (v) => bind(m.raise(v), outer.fn),
        path: m.path,
      };
    }
    cur = { tag: 'bind', comp: m.comp, fn: (v) => bind(m.fn(v), outer.fn) };
  }
}

/** 言語仕様の「エラー」。fail 作用（$fail）とは別物で、ハンドラでは捕捉できない。 */
export class EffectfulYamlError extends Error {
  /** 失敗した値の文書内の位置（`server.hosts[2]`）。文書全体や位置を辿れない経路では undefined。 */
  path?: string;

  constructor(message: string) {
    super(message);
    this.name = 'EffectfulYamlError';
  }
}

/** メッセージの末尾に添える失敗位置の表記。位置が無ければ何も添えない。 */
export const atSuffix = (path: string | undefined): string =>
  path === undefined || path === '' ? '' : ` (at ${path})`;

/**
 * 失敗位置をエラーに一度だけ添える。二度目以降は無視するので、内側（＝より深い位置）が勝つ。
 * 新しいエラーを作らずその場で書き換えるのは、MissingPathError などの下位クラスを保つためである
 * （包み直すと instanceof で分岐している捕捉可能性の判定が変わってしまう）。
 */
export function attachPath<E>(e: E, path: string | undefined): E {
  if (e instanceof EffectfulYamlError && e.path === undefined && atSuffix(path) !== '') {
    e.path = path;
    e.message += atSuffix(path);
  }
  return e;
}

/**
 * ホスト演算が「データ起因の失敗」を通知する例外。
 * ドライバが演算の呼び出し位置の std.fail に翻訳するので、文書側のハンドラが捕捉できる。
 * これ以外の例外は捕捉できない文書のエラーである。
 */
export class OperationFailure extends Error {
  constructor(readonly value: Value) {
    super(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
    this.name = 'OperationFailure';
  }
}

/**
 * ホスト演算が投げた例外が失敗の通知かどうか。
 * `--ops` のモジュールが別の複製の effectful-yaml から OperationFailure を import していると
 * instanceof は偽になるので、名前と value の有無でも判定する。
 */
export const isOperationFailure = (e: unknown): e is OperationFailure =>
  e instanceof OperationFailure ||
  (e instanceof Error && e.name === 'OperationFailure' && 'value' in e);

/** 値を人が読む形にする（エラー文言と、文字列そのものの表示）。 */
export function describe(v: Value): string {
  if (typeof v === 'string') return v;
  if (isClosure(v)) return '<function>';
  return JSON.stringify(v) ?? String(v);
}

/**
 * 第一階の標準演算（値から値を計算するだけ）。導出できないが評価器の協力も要らないので、
 * カーネルではなく「処理系が事前登録する演算」として供給の層に置く。
 * ホスト登録の演算と同じ経路（境界を抜けてドライバへ）を通る。
 */
export const BUILTIN_OPS: Readonly<Record<string, (arg: Value) => Value>> = {
  'std.range': (n) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new EffectfulYamlError(`$std.range requires a natural number, got: ${describe(n)}`);
    }
    return Array.from({ length: n }, (_, i) => i);
  },
};
