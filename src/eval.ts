/**
 * 評価器。
 * 仕様: docs/grammar/effects.md（草案 0.13）、とりわけ「作用境界」「合成・部分処理・境界」。
 *
 * 入力はカーネルの AST（src/desugar.ts）である。導出形はすべて脱糖済みなので、
 * ここで扱うのはカーネルの 5 形（参照・$let・$if・$fn と呼び出し・$handler）と、
 * 初期環境が与える値、すなわち std の演算と関数（仕様が「等価な組み込みで最適化してよい」と
 * 定めるもの）とホストの値である。
 *
 * Comp（freer モナド風の計算表現）を組み立てる。
 * ハンドラは Comp → Comp の純粋変換なので、節は $resume を何度でも呼べる。
 *
 * 作用境界は、文書全体と、データの中に現れた最も外側の `$` 式だけである。
 * 境界の内側には、明示のハンドラ（$handler）を除いて作用を堰き止める場所はない。
 * データ構成（リストの要素、`$` キーを持たないマッピングの値）も、呼び出しの引数と本体も、
 * std.collect の対象と関数本体も、すべて合成であり、作用はそのまま周囲へ合流する。
 * 境界の位置は脱糖器が決め、boundary ノードとして AST に現れる。
 */
import {
  clauseKeyName,
  desugar,
  unhandledOpMessage,
  type ClauseKey,
  type KNode,
} from './desugar.js';
import { interpolate, MissingPathError } from './expr.js';
import { typecheck } from './typecheck.js';
import { empty, get, insert, type PMap } from './pmap.js';
import {
  attachPath,
  bind,
  Closure,
  describe,
  EffectfulYamlError,
  emptyEnv,
  extendEnv,
  force,
  isClosure,
  isFunctionValue,
  isNonData,
  isOperation,
  isOperationFailure,
  lookupEnv,
  Native,
  Operation,
  perform,
  pure,
  resumeOf,
  STD_FUNCTIONS,
  STD_OPS,
  type Comp,
  type Env,
  type NativeCtx,
  type Value,
} from './types.js';

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

type ValueMap = { [key: string]: Value };

// ---------------------------------------------------------------------------
// 失敗位置
//
// 位置は「出力の値の中でのその値の場所」であり、キーを `.` で、リストの添字を `[2]` で連ねる
// （キーの `.` はエスケープしない）。脱糖器がノードごとに決めた位置であり、式の値がそのまま
// 出力の値になる経路をたどる間だけ伸びる。伸びない位置で起きた失敗は、それを含む直近の
// 伸びた位置で報告される。
//
// Comp は遅延して組み立てられ、bind の継続はドライバのスタックで走るので、
// 呼び出しを try/catch で囲んでも継続の中で起きたエラーは捕まらない（位置ともずれる）。
// そこで位置は二つの経路で運ぶ。
//   - ノードの評価を包む at: 評価器の中で投げられるエラー用。継続はこれをレキシカルに捕まえる。
//   - op の path: 境界を抜けてドライバに届く失敗とホスト演算のエラー用。
// ---------------------------------------------------------------------------

/** f の中で投げられたエラーに失敗位置を添える。 */
function at<T>(path: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw attachPath(e, path);
  }
}

/** 継続の中で投げられたエラーにも失敗位置が乗る bind。 */
const bindAt = (path: string, c: Comp, f: (v: Value) => Comp): Comp =>
  bind(c, (v) => at(path, () => f(v)));

/** データのマッピングか。関数（閉包・Native）と演算はデータではない。 */
const isValueMap = (v: Value): v is ValueMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isNonData(v);

/** パスの残りの区画（マッピングのキーアクセス）をたどる。たどれないことは文書の誤りなのでエラーの語彙で報せる。 */
function walkKeys(cur: Value, keys: readonly string[]): Value {
  for (const seg of keys) {
    if (!isValueMap(cur)) {
      throw new EffectfulYamlError(`cannot access key '.${seg}' of a non-mapping value`);
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      throw new EffectfulYamlError(`missing key '${seg}'`);
    }
    cur = cur[seg]!;
  }
  return cur;
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string') {
    throw new EffectfulYamlError(`${what} must be a string, got: ${JSON.stringify(v)}`);
  }
  return v;
}

function requireBoolean(v: Value, what: string): boolean {
  if (typeof v !== 'boolean') {
    throw new EffectfulYamlError(`${what} requires a boolean, got: ${JSON.stringify(v)}`);
  }
  return v;
}

/** 構造を回る形（std.each の分岐、std.collect の対象）。マッピングは {key, value} に分解する。 */
function entriesOf(arg: Value, what: string): Value[] {
  if (Array.isArray(arg)) return arg;
  if (isValueMap(arg)) return Object.entries(arg).map(([key, value]) => ({ key, value }));
  throw new EffectfulYamlError(`${what} requires a list or mapping, got: ${describe(arg)}`);
}

/**
 * $std.lookup の意味（展開と等価な O(1) の照会）。無いキーは呼び出し位置の std.fail。
 * in がマッピングでない・key が文字列でないのは型の誤りなのでエラー。
 */
function lookupComp(arg: Value, path: string, what: string): Comp {
  if (!isValueMap(arg)) {
    throw new EffectfulYamlError(`${what} requires a mapping {in, key}, got: ${describe(arg)}`);
  }
  const m = arg['in'];
  const k = requireString(arg['key'], `${what} key`);
  if (m === undefined || !isValueMap(m)) {
    throw new EffectfulYamlError(`${what} 'in' must be a mapping, got: ${describe(m ?? null)}`);
  }
  return Object.prototype.hasOwnProperty.call(m, k)
    ? pure(m[k]!)
    : perform('std.fail', `missing key '${k}'`, path);
}

/**
 * $std.merge の意味（展開と等価な直接のマージ）。値は後勝ち、キーの位置は初出。
 * 引数がリストでない・要素がマッピングでないのは型の誤りなのでエラー。
 */
function mergeComp(arg: Value, what: string): Comp {
  if (!Array.isArray(arg)) {
    throw new EffectfulYamlError(`${what} requires a list of mappings, got: ${describe(arg)}`);
  }
  const out: Record<string, Value> = {};
  for (const m of arg) {
    if (!isValueMap(m)) {
      throw new EffectfulYamlError(`${what} element must be a mapping, got: ${describe(m)}`);
    }
    for (const [k, v] of Object.entries(m)) setOwn(out, k, v);
  }
  return pure(out);
}

// ---------------------------------------------------------------------------
// 汎用ハンドラ（部分処理）
// ---------------------------------------------------------------------------

/** 演算の節。resume は「残りの計算（同じハンドラが効き続ける）」。 */
type Handler = (arg: Value, resume: (v: Value) => Comp, what: string) => Comp;

/**
 * 部分処理の汎用コンビネータ。
 * clauses に挙げた演算だけを横取りし、それ以外の演算は resume を包み直して外側へ透過させる。
 * 節へ渡す resume は自分自身で包み直すので、ハンドラは深い（再開後にも効き続ける）。
 */
function handleOps(
  comp: Comp,
  clauses: ReadonlyMap<string, Handler>,
  ret: (v: Value) => Comp = pure,
): Comp {
  const rec = (c0: Comp): Comp => {
    const c = force(c0);
    if (c.tag === 'pure') return ret(c.value);
    const clause = clauses.get(c.name);
    // 節はその場で resume することがある（std.log の節など）。そこで直に rec を呼ぶと
    // 演算の回数だけ入れ子になるので、bind の節を一枚かませて force のループへ返す。
    const next = (v: Value): Comp => bind(pure(null), () => rec(c.resume(v)));
    // raise された std.fail も同じ形で包み直す。rec を通すことで、raise された std.fail を
    // このハンドラ自身の節（たとえば $default の展開の std.fail 節）が捕捉できる。
    const nextRaise = (v: Value): Comp => bind(pure(null), () => rec(c.raise(v)));
    if (clause !== undefined) return clause(c.arg, next, c.what);
    return {
      tag: 'op',
      name: c.name,
      arg: c.arg,
      resume: next,
      raise: nextRaise,
      path: c.path,
      what: c.what,
    };
  };
  return rec(comp);
}

const asList = (v: Value): Value[] => v as Value[];

/**
 * 逐次組み立て（リストの要素、マッピングのエントリ、選択の分岐）を O(1) で積むための
 * 不変の cons リスト。積む向きは末尾追加（新しい要素が head）なので文書順とは逆になる。
 * 節の多重 $resume で同じ継続が再入しても、cons セルは不変でクロージャが
 * 捕まえているだけなので、後から生えた枝が先の枝を汚すことはない
 * （破壊的な push/代入だと共有した配列やオブジェクトを取り合ってしまう）。
 */
type Cons<T> = { readonly head: T; readonly tail: Cons<T> | null };

/** cons を文書順の配列に戻す。 */
function toDocumentOrder<T>(c: Cons<T> | null): T[] {
  const out: T[] = [];
  for (let cur = c; cur !== null; cur = cur.tail) out.push(cur.head);
  out.reverse();
  return out;
}

/** 選択の各分岐（要素数はまちまち）を文書順に平坦化する。O(総要素数)。 */
function flattenChunks(chunks: Cons<readonly Value[]> | null): Value[] {
  const out: Value[] = [];
  for (const chunk of toDocumentOrder(chunks)) for (const v of chunk) out.push(v);
  return out;
}

/**
 * マッピングへの書き込み。キーが __proto__ のとき素の代入はプロトタイプを差し替えて
 * キーを失わせるので、常に自身のプロパティとして定義する（{...acc, [k]: v} と同じ挙動）。
 */
function setOwn(out: ValueMap, key: string, v: Value): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = v;
  }
}

/**
 * キーと値の対の cons をマッピングへ実体化する。文書順に前方代入するので、
 * 重複キーは「最初の出現位置に、最後の値」になる。
 */
function materializeMap(entries: Cons<readonly [string, Value]> | null): ValueMap {
  const out: ValueMap = {};
  for (const [key, v] of toDocumentOrder(entries)) setOwn(out, key, v);
  return out;
}

/** 選択を処理し、全分岐の結果を文書順に並べたリストにする（std.list）。 */
function collectChoice(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Handler>([
      [
        'std.each',
        (arg, k, what) => {
          const items = entriesOf(arg, what);
          const go = (i: number, chunks: Cons<readonly Value[]> | null): Comp =>
            i >= items.length
              ? pure(flattenChunks(chunks))
              : bind(k(items[i]!), (branch) => go(i + 1, { head: asList(branch), tail: chunks }));
          return go(0, null);
        },
      ],
    ]),
    (v) => pure([v]),
  );
}

/**
 * 選択と失敗を処理し、成功した最初の分岐を [v]、全滅を [] で表す（std.first）。
 * go(i) は成功を得た時点で go(i + 1) を呼ばないので、最初の成功より後の分岐は
 * 評価されず、その作用も起きない。
 */
function collectFirst(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Handler>([
      [
        'std.each',
        (arg, k, what) => {
          const items = entriesOf(arg, what);
          const go = (i: number): Comp =>
            i >= items.length
              ? pure([])
              : bind(k(items[i]!), (r) => (asList(r).length > 0 ? pure(r) : go(i + 1)));
          return go(0);
        },
      ],
      ['std.fail', () => pure([])],
    ]),
    (v) => pure([v]),
  );
}

/**
 * 状態を処理する（std.state、および境界の既定の `$handler: {$std.state: {}}`）。
 * 記憶を再帰の引数として持ち回るので、外側のハンドラが複数回 resume すると
 * 各再開はその演算の時点の記憶から分岐する（= ハンドラは自分より内側だけを見る）。
 */
function handleState(comp: Comp, init: PMap<Value>): Comp {
  // 記憶は再帰ではなくループの変数として持ち回る（文の数だけ入れ子にならないように）。
  // 記憶も環境と同じ永続平衡木である。std.set ごとの全コピーだと書き込み回数 x セル数で
  // 二乗になるが、木なら書き込みごとに O(log セル数)。セルの値は Value（undefined を
  // 含まない）ので、get の undefined は「未作成」の合図として使える。
  const rec = (c0: Comp, s0: PMap<Value>): Comp => {
    let c = force(c0);
    let s = s0;
    for (;;) {
      if (c.tag === 'pure') return pure(c.value);
      if (c.name === 'std.get') {
        const name = requireString(c.arg, '$std.get cell name');
        const v = get(s, name);
        if (v === undefined) {
          // 未初期化のセルは失敗作用。仕様の展開では節の本体の `${hits[0]}` が起こすので、
          // このハンドラ自身では捕まらず外側へ抜ける（外側が再開すればその値が読み出しの値）。
          const m = c;
          const here = s;
          return {
            tag: 'op',
            name: 'std.fail',
            arg: `uninitialized cell: ${name}`,
            resume: (x) => rec(m.resume(x), here),
            // このノードは手組みの std.fail であり、ドライバが raise を呼ぶことはないので、
            // resume と同じ包み方で型を満たすだけでよい。
            raise: (x) => rec(m.raise(x), here),
            // 失敗位置は読み出しを起こした $std.get の位置である。
            path: m.path,
            what: '$std.fail',
          };
        }
        c = force(c.resume(v));
        continue;
      }
      if (c.name === 'std.set') {
        if (!isValueMap(c.arg)) {
          throw new EffectfulYamlError(`$std.set requires a mapping, got: ${describe(c.arg)}`);
        }
        let next = s;
        for (const [cell, v] of Object.entries(c.arg)) next = insert(next, cell, v);
        c = force(c.resume(null));
        s = next;
        continue;
      }
      const m = c;
      const here = s;
      return {
        tag: 'op',
        name: m.name,
        arg: m.arg,
        resume: (v) => rec(m.resume(v), here),
        raise: (v) => rec(m.raise(v), here),
        path: m.path,
        what: m.what,
      };
    }
  };
  return rec(comp, init);
}

// ---------------------------------------------------------------------------
// 評価器
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** 起動時パラメータ（$std.param が読む）。 */
  params?: Record<string, Value>;
  /**
   * ホストの演算。名前はドット入り（vault.read 等）で、初期環境の束縛になる。
   * 文書の `$handler` が横取りでき、境界に達したときだけこの実装が既定ハンドラとして走る。
   * 実装は非同期でもよい。
   */
  ops?: Record<string, HostImpl>;
  /**
   * ホストの関数。名前の綴りは演算と同じだが、作用ではないので横取りできず、
   * 作用シグネチャにも現れない。実装は非同期でもよい。
   */
  functions?: Record<string, HostImpl>;
  /** $std.log の既定の受け皿。 */
  onLog?: (value: Value) => void;
}

/** ホストの実装。失敗を通知するときは OperationFailure を投げる。 */
export type HostImpl = (arg: Value) => Value | Promise<Value>;

/**
 * 既定のパラメータハンドラが「渡されていない」を伝える番兵。
 * 同一性でだけ判定し、文書からは作れない。
 *
 * 未渡しの std.fail は呼び出し位置で起こす。
 * 既定ハンドラは境界にあるので、そこで失敗を起こしても呼び出し位置を包む
 * ハンドラ（$default の展開）はもう戻ってしまっている。仕様が「$default が
 * なければ std.fail が境界まで伝播する」と言うとおり、失敗は呼び出し位置で生じる。
 */
const ABSENT: Value = Object.freeze({});

/**
 * ホストの関数を呼ぶための内部演算名。評価器は同期に Comp を組むので、非同期の実装へ
 * 渡すには一度ドライバまで抜ける必要がある。末尾の `!` は識別子に使えないので、
 * 節のキーがこの名前に解決することはない（＝横取りできない）。
 */
const HOST_FN_MARK = '!';
const hostFnOp = (name: string): string => `${name}${HOST_FN_MARK}`;

/**
 * 本体の閉包を受け取る関数（std.list など）の引数を本体として走らせる。
 * 引数が関数でなければ、呼び出しではなく引数の型の誤りとして名乗る。
 */
function runBody(run: Value, ctx: NativeCtx): Comp {
  if (!isFunctionValue(run)) {
    throw new EffectfulYamlError(
      `${ctx.what} requires a function taking the body, got: ${describe(run)}`,
    );
  }
  return ctx.apply(run, null, ctx.what);
}

/** std の関数。ctx.apply で引数の関数値を適用し、ctx.what で利用者が書いた形を名乗る。 */
const STD_NATIVES: Readonly<Record<string, Native>> = {
  where: new Native('std.where', (cond, ctx) =>
    // {$if: 条件, $then: null, $else: {$std.each: []}}
    requireBoolean(cond, ctx.what) ? pure(null) : perform('std.each', [], ctx.path, ctx.what),
  ),
  range: new Native('std.range', (n, ctx) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new EffectfulYamlError(`${ctx.what} requires a natural number, got: ${describe(n)}`);
    }
    return pure(Array.from({ length: n }, (_, i) => i));
  }),
  collect: new Native('std.collect', collectNative),
  lookup: new Native('std.lookup', (arg, ctx) => lookupComp(arg, ctx.path, ctx.what)),
  merge: new Native('std.merge', (arg, ctx) => mergeComp(arg, ctx.what)),
  list: new Native('std.list', (run, ctx) => collectChoice(runBody(run, ctx))),
  mapping: new Native('std.mapping', (run, ctx) =>
    bind(collectChoice(runBody(run, ctx)), (vs) => pure(toMapping(asList(vs)))),
  ),
  first: new Native('std.first', (run, ctx) =>
    bind(collectFirst(runBody(run, ctx)), (r) =>
      asList(r).length > 0
        ? pure(asList(r)[0]!)
        : perform('std.fail', `every branch of ${ctx.what} failed or was cut`, ctx.path),
    ),
  ),
  // 初期値と本体の閉包をとるカリー化された関数。部分適用が本体を待つ関数になる。
  state: new Native('std.state', (init, ctx) =>
    pure(
      new Native('std.state', (run, inner) =>
        handleState(runBody(run, inner), cellsOf(init)),
      ),
    ),
  ),
};

/** std.collect の意味（展開と等価な組み込みの畳み込み）。 */
function collectNative(arg: Value, ctx: NativeCtx): Comp {
  const what = ctx.what;
  if (!isValueMap(arg)) {
    throw new EffectfulYamlError(`${what} requires a mapping {in, with, into}, got: ${describe(arg)}`);
  }
  const into = arg['into'] ?? 'list';
  if (into !== 'list' && into !== 'mapping') {
    throw new EffectfulYamlError(`${what} 'into' must be 'list' or 'mapping', got: ${describe(into)}`);
  }
  const f = arg['with'];
  if (f === undefined) throw new EffectfulYamlError(`${what} requires 'with'`);
  const items = entriesOf(arg['in'] ?? null, `${what} 'in'`);
  const path = ctx.path;
  const go = (i: number, chunks: Cons<readonly Value[]> | null): Comp => {
    if (i >= items.length) {
      const flat = flattenChunks(chunks);
      return pure(into === 'mapping' ? toMapping(flat) : flat);
    }
    return bindAt(path, ctx.apply(f, items[i]!, `${what} with`), (r) => {
      if (!Array.isArray(r)) {
        throw new EffectfulYamlError(
          `${what} requires the 'with' function to return a list, got: ${describe(r)}`,
        );
      }
      return go(i + 1, { head: r, tail: chunks });
    });
  };
  return go(0, null);
}

/** 初期環境。束縛 `std` と、ホストが与えた束縛からなる。 */
function initialEnv(
  ops: Readonly<Record<string, HostImpl>>,
  functions: Readonly<Record<string, HostImpl>>,
): Env {
  const std: ValueMap = {};
  for (const name of STD_OPS) std[name] = new Operation(`std.${name}`);
  for (const name of STD_FUNCTIONS) std[name] = STD_NATIVES[name]!;
  let env = extendEnv(emptyEnv, 'std', std);
  const roots: ValueMap = {};
  const place = (name: string, value: Value): void => {
    const segs = name.split('.');
    let cur = roots;
    for (const seg of segs.slice(0, -1)) {
      const next = cur[seg];
      if (next === undefined) {
        const fresh: ValueMap = {};
        setOwn(cur, seg, fresh);
        cur = fresh;
      } else if (isValueMap(next)) {
        cur = next as ValueMap;
      } else {
        throw new EffectfulYamlError(`host name conflicts with another host name: ${name}`);
      }
    }
    const last = segs[segs.length - 1]!;
    if (cur[last] !== undefined) {
      throw new EffectfulYamlError(`host name conflicts with another host name: ${name}`);
    }
    setOwn(cur, last, value);
  };
  for (const name of Object.keys(ops)) place(name, new Operation(name));
  for (const name of Object.keys(functions)) {
    place(name, new Native(name, (arg, ctx) => perform(hostFnOp(name), arg, ctx.path, ctx.what)));
  }
  for (const [name, value] of Object.entries(roots)) env = extendEnv(env, name, value);
  return env;
}

const HOST_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ホストが与える名前の検査。名前は束縛とキーの形（2 区画以上）であり、
 * グローバルな名前空間は言語の予約キーのため、`std` は標準のためにあるので、
 * ホストはそれ以外の束縛名を使う。同じ名前を演算と関数の両方に与えることはできない。
 */
function validateHostNames(
  ops: Readonly<Record<string, unknown>>,
  functions: Readonly<Record<string, unknown>>,
): void {
  for (const [kind, table] of [
    ['operation', ops],
    ['function', functions],
  ] as const) {
    for (const name of Object.keys(table)) {
      const segs = name.split('.');
      if (segs.length < 2 || !segs.every((seg) => HOST_SEGMENT.test(seg))) {
        throw new EffectfulYamlError(
          `host ${kind} name must be a dotted path of names (binding.key): ${name}`,
        );
      }
      if (segs[0] === 'std') {
        throw new EffectfulYamlError(
          `host cannot register ${kind === 'operation' ? 'an operation' : 'a function'} in the std namespace: $${name}`,
        );
      }
    }
  }
  for (const name of Object.keys(ops)) {
    if (Object.prototype.hasOwnProperty.call(functions, name)) {
      throw new EffectfulYamlError(
        `host name registered both as an operation and as a function: ${name}`,
      );
    }
  }
}

class Evaluator {
  constructor(
    private readonly params: Record<string, Value>,
    private readonly onLog: (v: Value) => void,
  ) {}

  /**
   * 作用境界（文書全体、およびデータの中に現れた最も外側の `$` 式）。
   * 残る作用を既定ハンドラ一式（失敗・パラメータ・ログ・状態）で処理し尽くす。
   * 選択と失敗と登録演算だけは外（トップレベルのドライバ）へ委ねる。
   * 選択を処理するのは明示のハンドラだけなので、境界に達した選択はドライバのエラーになる。
   */
  private boundary(comp: Comp): Comp {
    return this.handleParam(this.handleLog(handleState(comp, empty)));
  }

  private handleLog(comp: Comp): Comp {
    return handleOps(
      comp,
      new Map<string, Handler>([
        [
          'std.log',
          (v, k) => {
            this.onLog(v);
            return k(null);
          },
        ],
      ]),
    );
  }

  /** パラメータ表を読むだけの全域なハンドラ。未渡しは ABSENT で返す（判断は呼び出し位置）。 */
  private handleParam(comp: Comp): Comp {
    return handleOps(
      comp,
      new Map<string, Handler>([
        [
          'std.param',
          (arg, k) => {
            const name = requireString(arg, '$std.param name');
            return k(
              Object.prototype.hasOwnProperty.call(this.params, name)
                ? this.params[name]!
                : ABSENT,
            );
          },
        ],
      ]),
    );
  }

  /** ノードの評価。投げられたエラーにはこのノードの失敗位置が乗る（内側が勝つ）。 */
  eval(node: KNode, env: Env): Comp {
    return at(node.path, () => this.step(node, env));
  }

  private step(node: KNode, env: Env): Comp {
    switch (node.k) {
      case 'lit':
        return pure(node.value);
      case 'str':
        // 欠落したキーと添字は失敗作用（捕捉できる）。束縛の未定義や非コンテナの走査、
        // 型の不一致は文書の誤りなので、そのままエラーとして投げ抜ける。
        try {
          return pure(interpolate(node.raw, env));
        } catch (e) {
          if (e instanceof MissingPathError) return perform('std.fail', e.message, node.path);
          throw e;
        }
      case 'list': {
        // データ構成は作用を起こさないが、遮りもしない（bind でつなぐだけ）。
        const items = node.items;
        const go = (i: number, acc: Cons<Value> | null): Comp =>
          i >= items.length
            ? pure(toDocumentOrder(acc))
            : bind(this.eval(items[i]!, env), (v) => go(i + 1, { head: v, tail: acc }));
        return go(0, null);
      }
      case 'map': {
        const entries = node.entries;
        const go = (i: number, acc: Cons<readonly [string, Value]> | null): Comp => {
          if (i >= entries.length) return pure(materializeMap(acc));
          const [key, valueNode] = entries[i]!;
          return bind(this.eval(valueNode, env), (v) => go(i + 1, { head: [key, v], tail: acc }));
        };
        return go(0, null);
      }
      case 'boundary':
        return this.boundary(this.eval(node.body, env));
      case 'let':
        // 右辺は合成。ここの作用は束縛先ではなく後続の計算へ合流する。
        return this.letBind(node, 0, env);
      case 'if':
        return bindAt(node.path, this.eval(node.cond, env), (cond) =>
          this.eval(requireBoolean(cond, node.what) ? node.then : node.else, env),
        );
      case 'fn':
        return pure(new Closure(node.params, node.body, env));
      case 'call': {
        // 先頭区画は束縛の解決、残りの区画は値のマッピングのキーアクセス。
        // エラーの語彙は式の参照 ${a.self}（expr.ts の evalNode の case 'ref'）に揃える。
        const head = lookupEnv(env, node.head);
        if (head === undefined) {
          throw new EffectfulYamlError(`undefined reference: ${node.head}`);
        }
        const f = walkKeys(head, node.keys);
        if (node.functionOnly && !isFunctionValue(f)) {
          throw new EffectfulYamlError(
            `$handler requires a mapping of clauses or a function, got: ${describe(f)}`,
          );
        }
        // 引数は値渡しだが合成である。引数の評価で起きた作用は堰き止めない。
        return bindAt(node.path, this.eval(node.arg, env), (arg) =>
          this.apply(f, arg, node.what, node.path),
        );
      }
      case 'handle':
        return this.handle(node, env);
      case 'resume': {
        const k = resumeOf(env);
        if (k === undefined) {
          throw new EffectfulYamlError('$resume is only allowed inside a $handler clause');
        }
        return bind(this.eval(node.arg, env), k);
      }
      case 'err':
        throw new EffectfulYamlError(node.message);
    }
  }

  /**
   * 呼び出し。値が関数（閉包・Native）なら適用し、演算なら作用を起こす。
   * データにたどり着けば文書の誤りである。引数も本体も合成である。
   */
  private apply(f: Value, arg: Value, what: string, path: string): Comp {
    if (isClosure(f)) return this.enter(f, extendEnv(f.env, f.params[0]!, arg));
    if (f instanceof Native) {
      return f.impl(arg, { apply: (g, a, w) => this.apply(g, a, w, path), path, what });
    }
    if (isOperation(f)) {
      // std.param だけは未渡しの判定が呼び出し位置に属する（$default が捕捉できる位置で失敗させる）。
      if (f.name === 'std.param') {
        const key = requireString(arg, `${what} name`);
        return bind(perform('std.param', key, path, what), (v) =>
          v === ABSENT ? perform('std.fail', `parameter not provided: ${key}`, path) : pure(v),
        );
      }
      return perform(f.name, arg, path, what);
    }
    throw new EffectfulYamlError(`${what} is not a function: ${describe(f)}`);
  }

  /**
   * 先頭パラメータを束縛し終えた閉包に入る。パラメータが 2 個以上残っていれば
   * 部分適用であり、本体は走らせず残りを待つ閉包を返す（$fn の列のカリー化展開と等価）。
   */
  private enter(f: Closure, inner: Env): Comp {
    return f.params.length > 1
      ? pure(new Closure(f.params.slice(1), f.body, inner))
      : this.eval(f.body, inner);
  }

  /** 束縛の並びを文書順に評価して環境を伸ばし、本体を評価する。名前の無い束縛は値を捨てる。 */
  private letBind(node: Extract<KNode, { k: 'let' }>, i: number, env: Env): Comp {
    const bindings = node.bindings;
    if (i >= bindings.length) return this.eval(node.body, env);
    const b = bindings[i]!;
    return bindAt(node.path, this.eval(b.rhs, env), (v) =>
      this.letBind(node, i + 1, b.name === null ? env : extendEnv(env, b.name, v)),
    );
  }

  /**
   * ハンドラ。節の名前を `$handler` の位置の環境で解決し、節の関数もそこで閉包にする。
   * ローカル作用の宣言は評価のたびに新しい演算の値を作り、その名前を本体の環境に束縛する
   * （束縛が見えるのは本体だけであり、節と return 節からは見えない）。
   */
  private handle(node: Extract<KNode, { k: 'handle' }>, env: Env): Comp {
    const clauses = new Map<string, Handler>();
    let inner = env;
    for (const c of node.clauses) {
      const op = this.operationOf(c.key, env);
      if (c.key.kind === 'local') inner = extendEnv(inner, c.key.name, op);
      const closure = this.closureOf(c.fn, clauseKeyName(c.key), env);
      clauses.set(op.name, (arg, resume) => {
        // 節の本体でだけ resume が見える（外側の resume は入れ替わる）。
        // 本体の中で作られた閉包も env ごと resume を捕まえるので、そこからも再開できる。
        const clauseEnv: Env = {
          vars: insert(closure.env.vars, closure.params[0]!, arg),
          resume,
        };
        return this.enter(closure, clauseEnv);
      });
    }
    const ret =
      node.ret === undefined
        ? pure
        : ((): ((v: Value) => Comp) => {
            const retClosure = this.closureOf(node.ret!, 'return', env);
            return (v) =>
              this.enter(retClosure, extendEnv(retClosure.env, retClosure.params[0]!, v));
          })();
    // 節の本体が起こす作用はこのハンドラ自身では捕まらない（handleOps は継続だけを包み直す）。
    return handleOps(this.eval(node.body, inner), clauses, ret);
  }

  /** 節のキーが指す演算。ローカル作用の宣言は評価ごとに一意な内部名の演算を鋳造する。 */
  private operationOf(key: ClauseKey, env: Env): Operation {
    if (key.kind === 'local') {
      return new Operation(`${key.name}@${key.spath}#${localOpCounter++}`);
    }
    const head = lookupEnv(env, key.head);
    if (head === undefined) throw new EffectfulYamlError(`undefined reference: ${key.head}`);
    const v = walkKeys(head, key.keys);
    if (!isOperation(v)) {
      throw new EffectfulYamlError(
        `$handler clause '${clauseKeyName(key)}' must name an operation, got: ${describe(v)}`,
      );
    }
    return v;
  }

  private closureOf(fn: KNode, name: string, env: Env): Closure {
    const comp = force(this.eval(fn, env));
    if (comp.tag !== 'pure' || !isClosure(comp.value)) {
      throw new EffectfulYamlError(`$handler clause '${name}' must be a function ($fn)`);
    }
    return comp.value;
  }
}

/** ローカル作用の内部名に添える実行時の連番。宣言ごと・評価ごとに別の演算にする。 */
let localOpCounter = 0;

/** std.state の初期値からセルの記憶を作る。 */
function cellsOf(cells: Value): PMap<Value> {
  if (!isValueMap(cells)) {
    throw new EffectfulYamlError(`$std.state requires a mapping of cells, got: ${describe(cells)}`);
  }
  let init: PMap<Value> = empty;
  for (const [cell, v] of Object.entries(cells)) init = insert(init, cell, v);
  return init;
}

/**
 * エントリの列をマッピングにする（std.collect の into: mapping の契約）。
 * std.mapping はこの上の導出なので、集めた分岐にも同じ検査が効く。
 * 契約違反はデータの変動ではなく文書の誤りなので、失敗作用ではなくエラーにする。
 */
function toMapping(entries: readonly Value[]): Value {
  const out: ValueMap = {};
  for (const b of entries) {
    if (!isValueMap(b)) {
      throw new EffectfulYamlError(`$std.collect entry must be a {key, value} mapping, got: ${describe(b)}`);
    }
    const keys = Object.keys(b);
    if (keys.length !== 2 || !('key' in b) || !('value' in b)) {
      throw new EffectfulYamlError(
        `$std.collect entry must have exactly the keys 'key' and 'value', got: ${keys.join(', ')}`,
      );
    }
    const key = b['key']!;
    if (typeof key !== 'string') {
      throw new EffectfulYamlError(`$std.collect key must be a string, got: ${describe(key)}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new EffectfulYamlError(`duplicate key in $std.collect: ${key}`);
    }
    setOwn(out, key, b['value']!);
  }
  return out;
}

/**
 * 関数と演算が文書の値に残ることはエラー。
 * 閉包と Native に加え、ホストが params で注入した生の関数も拒む。
 */
function assertNoNonData(v: Value): void {
  if (isOperation(v)) {
    throw new EffectfulYamlError('an operation value cannot escape into the document value');
  }
  if (isNonData(v) || typeof v === 'function') {
    throw new EffectfulYamlError('a function value cannot escape into the document value');
  }
  if (Array.isArray(v)) {
    for (const x of v) assertNoNonData(x);
    return;
  }
  if (isValueMap(v)) for (const x of Object.values(v)) assertNoNonData(x);
}

/** 値の中に関数値か演算の値が含まれるか。ホストの実装へ渡る直前の引数の検査に使う。 */
function containsNonData(v: Value): boolean {
  if (isNonData(v) || typeof v === 'function') return true;
  if (Array.isArray(v)) return v.some(containsNonData);
  if (isValueMap(v)) return Object.values(v).some(containsNonData);
  return false;
}

// ---------------------------------------------------------------------------
// トップレベルのドライバ
// ---------------------------------------------------------------------------

/**
 * 境界の既定ハンドラを通り抜けて残るのは、選択と失敗と、ホストの演算と関数の呼び出しである。
 * どのハンドラにも捕まらなかった選択と失敗は文書全体のエラーにし、ホストの呼び出しは
 * その実装へ渡す（実装は非同期でよい）。
 */
async function drive(
  comp: Comp,
  ops: Readonly<Record<string, HostImpl>>,
  functions: Readonly<Record<string, HostImpl>>,
): Promise<Value> {
  let c = force(comp);
  for (;;) {
    if (c.tag === 'pure') return c.value;
    // ここまで来た失敗は文書内のどのハンドラにも捕まらなかったものなので、
    // 起こした位置を添えてよい（捕まった失敗は値に翻訳済みで、ここには現れない）。
    if (c.name === 'std.fail') {
      throw attachPath(new EffectfulYamlError(`failure: ${describe(c.arg)}`), c.path);
    }
    // 選択を値にするのは明示のハンドラだけである。捕まえ手なく境界に達した選択は、
    // 形が書かれていない（言語仕様の作用境界）ので、値にせずここで報せる。
    if (c.name === 'std.each') {
      throw attachPath(
        new EffectfulYamlError(
          `unhandled choice: ${c.what} reached the boundary; no enclosing handler handles std.each`,
        ),
        c.path,
      );
    }
    // ホストの関数は内部演算名（末尾の `!`）でここまで来る。ローカル作用の内部名（`@` を含む）は
    // どの表にも無いので、unhandledOpMessage が脱出として報せる。
    const isFn = c.name.endsWith(HOST_FN_MARK);
    const name = isFn ? c.name.slice(0, -HOST_FN_MARK.length) : c.name;
    const host = isFn ? functions[name] : ops[name];
    if (host === undefined) {
      throw attachPath(new EffectfulYamlError(unhandledOpMessage(c.name)), c.path);
    }
    // 閉包と演算の値はホストへ渡れない（grammar/host.md）。評価前の流れ検査と二重の砦で、
    // こちらは実際に渡る値を見る正確な検査である。
    if (containsNonData(c.arg)) {
      throw attachPath(
        new EffectfulYamlError(
          `a function value cannot be passed to a host ${isFn ? 'function' : 'operation'}: $${name}`,
        ),
        c.path,
      );
    }
    let out: Value;
    try {
      out = await host(c.arg);
    } catch (e) {
      if (isOperationFailure(e)) {
        // 通知された失敗を呼び出し位置の std.fail に翻訳する。内側のハンドラが捕捉できる。
        c = force(c.raise(e.value));
        continue;
      }
      throw attachPath(e, c.path);
    }
    c = force(c.resume(out));
  }
}

/** 文書を評価する。文書全体が一つの作用境界である。 */
export async function evaluate(doc: unknown, options: EvaluateOptions = {}): Promise<Value> {
  const ops = options.ops ?? {};
  const functions = options.functions ?? {};
  validateHostNames(ops, functions);

  // 導出形をカーネルへ展開する。構文の誤りはここで報告される。
  const ast = desugar(doc);

  // 評価前の検査（grammar/values.md「環境と名前の解決」、grammar/checks.md「関数値の流れと停止性」、grammar/host.md）。
  // 未定義の参照を含む文書、自己適用を含みうる文書、ホストの実装の引数に閉包や演算の値が
  // 流れうる文書を、評価を始める前に拒否する。
  typecheck(ast, Object.keys(ops), Object.keys(functions));

  const evaluator = new Evaluator(
    options.params ?? {},
    options.onLog ?? ((v) => console.error(describe(v))),
  );
  const value = await drive(evaluator.eval(ast, initialEnv(ops, functions)), ops, functions);
  assertNoNonData(value);
  return value;
}
