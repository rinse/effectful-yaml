/**
 * 静的な作用推論と評価器。
 * 仕様: docs/grammar.md（草案 0.3）「評価モデル」節、とりわけ「作用境界」「合成と境界」。
 *
 * 二つのことを一体で行う。
 * 1. Analyzer: 文書を実行せずに各ノードの作用集合を求める。
 *    - 登録されていない演算を評価前に拒否する。
 *    - 各作用境界の値の形（単値かリストか）を決める。実行結果の個数からは決めない。
 * 2. Evaluator: Comp（freer モナド風の計算表現）を組み立てる。
 *    ハンドラは Comp → Comp の純粋変換なので、$handle の節は $resume を何度でも呼べる。
 *
 * 作用境界は、文書全体と、データの中に現れた最も外側の `$` 式だけである。
 * 境界の内側には、明示のハンドラ（$list/$mapping/$first/$state/$handle）を除いて
 * 作用を堰き止める場所はない。データ構成（リストの要素、`$` キーを持たないマッピングの値）も、
 * 演算の引数も、呼び出しの引数と本体も、すべて合成であり、作用はそのまま周囲へ合流する。
 *
 * この三態を Analyzer と Evaluator が同じ形で持つ（片方だけ直すのは誤り）。
 *   - data:     まだどの `$` 式にも入っていないデータ位置。`$` 式に出会ったらそこが境界。
 *   - boundary: 境界。中身を評価し、既定ハンドラ一式で処理し尽くす。
 *   - node:     合成位置（`$` 式の内側）。子も一律に合成。
 */
import { interpolate } from './expr.js';
import { analyzeMapping, HANDLER_REMOVES, unescapeDollar, type MappingShape } from './forms.js';
import {
  bind,
  CHOICE_OPS,
  Closure,
  EffectfulYamlError,
  emptyEnv,
  extendEnv,
  isClosure,
  isOpRef,
  lookupEnv,
  OpRef,
  perform,
  pure,
  STATE_OPS,
  STD_OPS,
  type Comp,
  type Env,
  type Value,
} from './types.js';

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 境界の既定ハンドラ一式が処理する演算（外側から 失敗・パラメータ・ログ・状態・選択）。 */
const DEFAULT_OPS: ReadonlySet<string> = new Set([
  'fail',
  'param',
  'log',
  ...STATE_OPS,
  ...CHOICE_OPS,
]);

type NodeMap = Record<string, unknown>;
type ValueMap = { [key: string]: Value };

const isNodeMap = (n: unknown): n is NodeMap =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

const isValueMap = (v: Value): v is ValueMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isClosure(v) && !isOpRef(v);

function union(...sets: readonly Iterable<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const x of s) out.add(x);
  return out;
}

function without(s: Iterable<string>, removed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const x of s) if (!removed.has(x)) out.add(x);
  return out;
}

const hasChoice = (s: ReadonlySet<string>): boolean => {
  for (const c of CHOICE_OPS) if (s.has(c)) return true;
  return false;
};

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

function describe(v: Value): string {
  if (typeof v === 'string') return v;
  if (isClosure(v)) return '<function>';
  if (isOpRef(v)) return '<operation>';
  return JSON.stringify(v) ?? String(v);
}

/** `${名前}` ちょうど一つからなるスカラーの、名前部分。追跡できなければ undefined。 */
const SIMPLE_REF = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/;

/** $each が選ぶ要素の並び。マッピングは {key, value} に分解する。 */
function eachItems(arg: Value): Value[] {
  if (Array.isArray(arg)) return arg;
  if (isValueMap(arg)) return Object.entries(arg).map(([key, value]) => ({ key, value }));
  throw new EffectfulYamlError(`$each requires a list or mapping, got: ${describe(arg)}`);
}

// ---------------------------------------------------------------------------
// 汎用ハンドラ（部分処理）
// ---------------------------------------------------------------------------

/** 演算の節。resume は「残りの計算（同じハンドラが効き続ける）」。 */
type Clause = (arg: Value, resume: (v: Value) => Comp) => Comp;

/**
 * 部分処理の汎用コンビネータ。
 * clauses に挙げた演算だけを横取りし、それ以外の演算は resume を包み直して外側へ透過させる。
 * 節へ渡す resume は自分自身で包み直すので、ハンドラは深い（再開後にも効き続ける）。
 */
function handleOps(
  comp: Comp,
  clauses: ReadonlyMap<string, Clause>,
  ret: (v: Value) => Comp = pure,
): Comp {
  const rec = (c: Comp): Comp => {
    if (c.tag === 'pure') return ret(c.value);
    const clause = clauses.get(c.name);
    if (clause !== undefined) return clause(c.arg, (v) => rec(c.resume(v)));
    return { tag: 'op', name: c.name, arg: c.arg, resume: (v) => rec(c.resume(v)) };
  };
  return rec(comp);
}

const asList = (v: Value): Value[] => v as Value[];

/** 選択を処理し、全分岐の結果を文書順に並べたリストにする（$list、および境界の既定）。 */
function collectChoice(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Clause>([
      [
        'each',
        (arg, k) => {
          let acc: Comp = pure([]);
          for (const item of eachItems(arg)) {
            acc = bind(acc, (done) =>
              bind(k(item), (branch) => pure([...asList(done), ...asList(branch)])),
            );
          }
          return acc;
        },
      ],
      ['where', (arg, k) => (requireBoolean(arg, '$where') ? k(null) : pure([]))],
    ]),
    (v) => pure([v]),
  );
}

/** 選択と失敗を処理し、成功した最初の分岐を [v]、全滅を [] で表す（$first）。 */
function collectFirst(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Clause>([
      [
        'each',
        (arg, k) => {
          const items = eachItems(arg);
          const go = (i: number): Comp =>
            i >= items.length
              ? pure([])
              : bind(k(items[i]!), (r) => (asList(r).length > 0 ? pure(r) : go(i + 1)));
          return go(0);
        },
      ],
      ['where', (arg, k) => (requireBoolean(arg, '$where') ? k(null) : pure([]))],
      ['fail', () => pure([])],
    ]),
    (v) => pure([v]),
  );
}

/**
 * 状態を処理する（$state、および境界の既定の $state: {}）。
 * 記憶を再帰の引数として持ち回るので、外側のハンドラが複数回 resume すると
 * 各再開はその演算の時点の記憶から分岐する（= ハンドラは自分より内側だけを見る）。
 */
function handleState(comp: Comp, init: ReadonlyMap<string, Value>): Comp {
  const rec = (c: Comp, s: ReadonlyMap<string, Value>): Comp => {
    if (c.tag === 'pure') return pure(c.value);
    if (c.name === 'get') {
      const name = requireString(c.arg, '$get cell name');
      if (!s.has(name)) throw new EffectfulYamlError(`uninitialized cell: ${name}`);
      return rec(c.resume(s.get(name)!), s);
    }
    if (c.name === 'set') {
      if (!isValueMap(c.arg)) {
        throw new EffectfulYamlError(`$set requires a mapping, got: ${describe(c.arg)}`);
      }
      const next = new Map(s);
      for (const [cell, v] of Object.entries(c.arg)) next.set(cell, v);
      return rec(c.resume(null), next);
    }
    return { tag: 'op', name: c.name, arg: c.arg, resume: (v) => rec(c.resume(v), s) };
  };
  return rec(comp, init);
}

// ---------------------------------------------------------------------------
// 静的な作用推論
// ---------------------------------------------------------------------------

/** レキシカルな名前 -> 呼び出したときの作用集合。undefined は「構造的に追跡できない」。 */
type SEnv = Map<string, ReadonlySet<string> | undefined>;

/**
 * 作用集合を求めつつ、リストに評価される作用境界のノードを記録する。
 * 出現主義なので、実行されない分岐（$if の選ばれない側）の演算も数える。
 */
class Analyzer {
  /** 値がリストになる境界ノード。スカラーは作用を持てないので object だけを入れる。 */
  readonly listBoundaries = new WeakSet<object>();

  /** 境界位置。既定ハンドラが処理する作用は消え、登録演算だけが外へ残る。 */
  boundary(node: unknown, senv: SEnv): Set<string> {
    const e = this.data(node, senv, true);
    if (typeof node === 'object' && node !== null && hasChoice(e)) {
      this.listBoundaries.add(node);
    }
    return without(e, DEFAULT_OPS);
  }

  /**
   * データ位置。`$` 式に出会ったらそこが最も外側の `$` 式＝境界である。
   * here が真のときはこのノード自身が境界（文書全体、または呼び出し元が境界と決めた位置）。
   */
  private data(node: unknown, senv: SEnv, here = false): Set<string> {
    const composed = this.compose(node, (n) => this.data(n, senv));
    if (composed !== undefined) return composed;
    return here ? this.dollar(node as NodeMap, senv) : this.boundary(node, senv);
  }

  /** 合成位置。内側の作用がそのまま周囲へ合流する。 */
  effects(node: unknown, senv: SEnv): Set<string> {
    return (
      this.compose(node, (n) => this.effects(n, senv)) ?? this.dollar(node as NodeMap, senv)
    );
  }

  /** データ構成（スカラー・リスト・プレーンマッピング）。`$` 式なら undefined。 */
  private compose(node: unknown, rec: (n: unknown) => Set<string>): Set<string> | undefined {
    if (Array.isArray(node)) return union(...node.map(rec));
    if (!isNodeMap(node)) return new Set();
    if (analyzeMapping(Object.keys(node)).kind !== 'plain') return undefined;
    return union(...Object.values(node).map(rec));
  }

  private dollar(node: NodeMap, senv: SEnv): Set<string> {
    const shape = analyzeMapping(Object.keys(node));
    switch (shape.kind) {
      case 'plain':
        return new Set();
      case 'lexical':
        return union(this.effects(node[shape.raw], senv), senv.get(shape.name) ?? []);
      case 'op':
        return union(this.effects(node[shape.raw], senv), [shape.name]);
      case 'reserved':
        return this.reserved(shape, node, senv);
    }
  }

  private reserved(
    shape: Extract<MappingShape, { kind: 'reserved' }>,
    node: NodeMap,
    senv: SEnv,
  ): Set<string> {
    const arg = node[shape.mainRaw];
    const aux = (name: string): unknown => {
      const raw = shape.aux.get(name);
      return raw === undefined ? undefined : node[raw];
    };
    switch (shape.main) {
      case 'do': {
        const stmts = Array.isArray(arg) ? arg : [];
        const inner: SEnv = new Map(senv);
        const out = new Set<string>();
        for (const stmt of stmts) {
          for (const x of this.statement(stmt, inner)) out.add(x);
        }
        return out;
      }
      case 'let':
        // $do の外の $let は評価器がエラーにする。推論では右辺の合流だけ見る。
        return this.statement(node, new Map(senv));
      case 'if':
        return union(
          this.effects(arg, senv),
          this.effects(aux('then'), senv),
          this.effects(aux('else'), senv),
        );
      case 'fn':
      case 'op':
        // 値を作るだけで作用は起こさない。本体は呼び出し側で数える。
        // ただし本体の境界の形は登録しておく（追跡できない経路で呼ばれても形が要る）。
        this.callable(node, senv);
        return new Set();
      case 'pipe': {
        const stages = Array.isArray(aux('through')) ? (aux('through') as unknown[]) : [];
        return union(
          this.effects(arg, senv),
          ...stages.map((s) => union(this.effects(s, senv), this.callable(s, senv) ?? [])),
        );
      }
      case 'each':
      case 'where':
      case 'get':
      case 'set':
      case 'log':
      case 'fail':
        return union(this.effects(arg, senv), [shape.main]);
      case 'param':
        return union(
          this.effects(arg, senv),
          shape.aux.has('default') ? this.effects(aux('default'), senv) : [],
          ['param'],
        );
      case 'list':
      case 'mapping':
      case 'first':
        return without(this.effects(arg, senv), HANDLER_REMOVES[shape.main]!);
      case 'state':
        return union(
          this.effects(arg, senv),
          without(this.effects(aux('in'), senv), STATE_OPS),
        );
      case 'handle': {
        const clauses = isNodeMap(aux('with')) ? (aux('with') as NodeMap) : {};
        const removed = new Set(Object.keys(clauses).filter((k) => k !== 'return'));
        return union(
          without(this.effects(arg, senv), removed),
          ...Object.values(clauses).map((c) => this.callable(c, senv) ?? []),
        );
      }
      case 'resume':
        // 継続の作用は $handle の本体側で既に数えている。ここは引数だけ。
        return this.effects(arg, senv);
      default:
        return new Set();
    }
  }

  /** $do の文一つ分。$let なら senv を伸ばす（左から右へのレキシカルな追跡）。 */
  private statement(stmt: unknown, senv: SEnv): Set<string> {
    if (!isNodeMap(stmt)) return this.effects(stmt, senv);
    const shape = analyzeMapping(Object.keys(stmt));
    if (shape.kind !== 'reserved' || shape.main !== 'let') return this.effects(stmt, senv);
    const bindings = stmt[shape.mainRaw];
    if (!isNodeMap(bindings)) return new Set();
    const out = new Set<string>();
    for (const [name, rhs] of Object.entries(bindings)) {
      for (const x of this.effects(rhs, senv)) out.add(x);
      senv.set(name, this.callable(rhs, senv));
    }
    return out;
  }

  /**
   * ノードが表す関数値を呼んだときの作用集合。追跡できなければ undefined。
   * $pipe の段やパス経由の参照は追跡できないので、事前検証の対象から外れる。
   *
   * ponytail: $fn の本体は effects() 側でも走査するので、$let + $fn の入れ子の深さに対して
   * 走査が指数的になる。文書は小さい前提。実測で問題になったらノードごとにメモ化する。
   */
  private callable(node: unknown, senv: SEnv): ReadonlySet<string> | undefined {
    if (typeof node === 'string') {
      const m = SIMPLE_REF.exec(node);
      return m === null ? undefined : senv.get(m[1]!);
    }
    if (!isNodeMap(node)) return undefined;
    const shape = analyzeMapping(Object.keys(node));
    if (shape.kind !== 'reserved') return undefined;
    if (shape.main === 'fn') {
      const param = node[shape.mainRaw];
      const inner: SEnv = new Map(senv);
      if (typeof param === 'string') inner.set(param, undefined);
      return this.effects(node[shape.aux.get('body')!], inner);
    }
    if (shape.main === 'op') {
      const name = node[shape.mainRaw];
      return typeof name === 'string' ? new Set([name]) : undefined;
    }
    if (shape.main === 'if') {
      const t = this.callable(node[shape.aux.get('then')!], senv);
      const e = this.callable(node[shape.aux.get('else')!], senv);
      return t === undefined || e === undefined ? undefined : union(t, e);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 評価器
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** 起動時パラメータ（$param が読む）。 */
  params?: Record<string, Value>;
  /** 登録演算。名前はドット入り（vault.read 等）。ホスト関数は非同期でもよい。 */
  ops?: Record<string, (arg: Value) => Value | Promise<Value>>;
  /** $log の既定の受け皿。 */
  onLog?: (value: Value) => void;
}

/** $param の演算引数の内部表現（$default を境界で先に確定させて運ぶ）。 */
interface ParamArg {
  readonly name: string;
  readonly fallback?: Value;
}

class Evaluator {
  constructor(
    private readonly analyzer: Analyzer,
    private readonly params: Record<string, Value>,
    private readonly onLog: (v: Value) => void,
  ) {}

  /**
   * 作用境界（文書全体、およびデータの中に現れた最も外側の `$` 式）。
   * 残る作用を既定ハンドラ一式（失敗・パラメータ・ログ・状態・選択）で処理し尽くす。
   * 失敗と登録演算だけは外（トップレベルのドライバ）へ委ねる。
   * 値の形は静的な作用集合だけで決める。実行して得た個数からは決めない。
   */
  boundary(node: unknown, env: Env): Comp {
    const drained = this.handleParam(
      this.handleLog(handleState(collectChoice(this.data(node, env, true)), new Map())),
    );
    if (typeof node === 'object' && node !== null && this.analyzer.listBoundaries.has(node)) {
      return drained;
    }
    return bind(drained, (results) => pure(this.single(asList(results), node)));
  }

  private single(results: readonly Value[], node: unknown): Value {
    if (results.length === 1) return results[0]!;
    const where = JSON.stringify(node) ?? String(node);
    const cause =
      results.length === 0
        ? 'a branch was cut ($where / empty $each)'
        : 'a choice produced several branches';
    throw new EffectfulYamlError(
      `boundary was inferred to be a single value but ${cause}: expected 1 result, got ${results.length}. ` +
        `Choice most likely reached this boundary through a call the analyzer cannot track ` +
        `(a $pipe stage or a function value behind a path). Boundary node: ${where}`,
    );
  }

  private handleLog(comp: Comp): Comp {
    return handleOps(
      comp,
      new Map<string, Clause>([
        [
          'log',
          (v, k) => {
            this.onLog(v);
            return k(null);
          },
        ],
      ]),
    );
  }

  private handleParam(comp: Comp): Comp {
    return handleOps(
      comp,
      new Map<string, Clause>([
        [
          'param',
          (arg, k) => {
            const spec = arg as ParamArg;
            if (Object.prototype.hasOwnProperty.call(this.params, spec.name)) {
              return k(this.params[spec.name]!);
            }
            if ('fallback' in spec) return k(spec.fallback!);
            throw new EffectfulYamlError(`parameter not provided: ${spec.name}`);
          },
        ],
      ]),
    );
  }

  /**
   * データ位置。`$` 式に出会ったらそこが最も外側の `$` 式＝境界である。
   * here が真のときはこのノード自身が境界。
   */
  private data(node: unknown, env: Env, here = false): Comp {
    const composed = this.compose(node, env, (n) => this.data(n, env));
    if (composed !== undefined) return composed;
    return here ? this.dollar(node as NodeMap, env) : this.boundary(node, env);
  }

  /** 合成位置の評価（`$` 式の内側）。子も一律に合成。 */
  node(node: unknown, env: Env): Comp {
    return this.compose(node, env, (n) => this.node(n, env)) ?? this.dollar(node as NodeMap, env);
  }

  /**
   * データ構成（スカラー・リスト・プレーンマッピング）を rec で組み立てる。`$` 式なら undefined。
   * データ構成は作用を起こさないが、遮りもしない（bind でつなぐだけ）。
   */
  private compose(node: unknown, env: Env, rec: (n: unknown) => Comp): Comp | undefined {
    if (typeof node === 'string') return pure(interpolate(node, env));
    if (node === null || node === undefined) return pure(null);
    if (typeof node === 'number' || typeof node === 'boolean') return pure(node);
    if (Array.isArray(node)) {
      const go = (i: number, acc: Value[]): Comp =>
        i >= node.length ? pure(acc) : bind(rec(node[i]), (v) => go(i + 1, [...acc, v]));
      return go(0, []);
    }
    if (!isNodeMap(node)) {
      throw new EffectfulYamlError(`unsupported node: ${String(node)}`);
    }
    if (analyzeMapping(Object.keys(node)).kind !== 'plain') return undefined;
    // キーは $$ を literal な $ に解決するだけ（計算されたキーは $mapping で書く）。
    const entries = Object.entries(node);
    const go = (i: number, acc: ValueMap): Comp => {
      if (i >= entries.length) return pure(acc);
      const [rawKey, valueNode] = entries[i]!;
      return bind(rec(valueNode), (v) => go(i + 1, { ...acc, [unescapeDollar(rawKey)]: v }));
    };
    return go(0, {});
  }

  private dollar(node: NodeMap, env: Env): Comp {
    const shape = analyzeMapping(Object.keys(node));
    switch (shape.kind) {
      case 'plain':
        throw new EffectfulYamlError('unreachable: plain mapping is not a $ form');
      case 'lexical': {
        const f = lookupEnv(env, shape.name);
        if (f === undefined) throw new EffectfulYamlError(`undefined reference: ${shape.name}`);
        return bind(this.node(node[shape.raw], env), (arg) => this.apply(f, arg, shape.name));
      }
      case 'op':
        return bind(this.node(node[shape.raw], env), (arg) => perform(shape.name, arg));
      case 'reserved':
        return this.reserved(shape, node, env);
    }
  }

  /** 関数値（閉包 / 演算参照）の適用。引数も本体も合成である。 */
  private apply(f: Value, arg: Value, what: string): Comp {
    if (isClosure(f)) return this.node(f.body, extendEnv(f.env, f.param, arg));
    if (isOpRef(f)) return this.performStd(f.name, arg);
    throw new EffectfulYamlError(`${what} is not a function: ${describe(f)}`);
  }

  /** $op 経由の演算呼び出し。$param だけは内部表現へ合わせる。 */
  private performStd(name: string, arg: Value): Comp {
    if (name === 'param') {
      return perform('param', { name: requireString(arg, '$param name') } satisfies ParamArg);
    }
    return perform(name, arg);
  }

  private reserved(
    shape: Extract<MappingShape, { kind: 'reserved' }>,
    node: NodeMap,
    env: Env,
  ): Comp {
    const arg = node[shape.mainRaw];
    const aux = (name: string): unknown => {
      const raw = shape.aux.get(name);
      return raw === undefined ? undefined : node[raw];
    };
    switch (shape.main) {
      case 'do': {
        if (!Array.isArray(arg)) {
          throw new EffectfulYamlError('$do requires a list of statements');
        }
        return this.statements(arg, 0, env);
      }
      case 'let':
        throw new EffectfulYamlError('$let is only allowed as a statement of $do');
      case 'if':
        return bind(this.node(arg, env), (cond) =>
          this.node(requireBoolean(cond, '$if condition') ? aux('then') : aux('else'), env),
        );
      case 'fn':
        return pure(new Closure(requireString(arg, '$fn parameter name'), aux('body'), env));
      case 'op': {
        const name = requireString(arg, '$op operation name');
        if (!STD_OPS.has(name) && !name.includes('.')) {
          throw new EffectfulYamlError(`$op cannot reference the reserved key $${name}`);
        }
        return pure(new OpRef(name));
      }
      case 'pipe': {
        const through = aux('through');
        const stages = through === undefined || through === null ? [] : through;
        if (!Array.isArray(stages)) throw new EffectfulYamlError('$through requires a list');
        let comp = this.node(arg, env);
        for (const stage of stages) {
          const prev = comp;
          comp = bind(prev, (v) =>
            bind(this.node(stage, env), (f) => this.apply(f, v, '$pipe stage')),
          );
        }
        return comp;
      }
      // 演算の引数は値渡しだが合成である。引数の評価で起きた作用は堰き止めない。
      case 'each':
        return bind(this.node(arg, env), (v) => perform('each', v));
      case 'where':
        return bind(this.node(arg, env), (v) =>
          perform('where', requireBoolean(v, '$where condition')),
        );
      case 'param':
        return bind(this.node(arg, env), (name) => {
          const spec: ParamArg = { name: requireString(name, '$param name') };
          if (!shape.aux.has('default')) return perform('param', spec);
          // $default も値渡しで先に評価される（パラメータが渡されていても中の作用は起きる）。
          return bind(this.node(aux('default'), env), (fallback) =>
            perform('param', { ...spec, fallback }),
          );
        });
      case 'get':
        return bind(this.node(arg, env), (name) =>
          perform('get', requireString(name, '$get cell name')),
        );
      case 'set':
        return bind(this.node(arg, env), (cells) => perform('set', cells));
      case 'log':
        return bind(this.node(arg, env), (v) => perform('log', v));
      case 'fail':
        return bind(this.node(arg, env), (v) => perform('fail', v));
      case 'list':
        return collectChoice(this.node(arg, env));
      case 'mapping':
        return bind(collectChoice(this.node(arg, env)), (l) => pure(toMapping(asList(l))));
      case 'first':
        return bind(collectFirst(this.node(arg, env)), (r) =>
          asList(r).length > 0
            ? pure(asList(r)[0]!)
            : perform('fail', 'every branch of $first failed or was cut'),
        );
      case 'state':
        return bind(this.node(arg, env), (cells) => {
          if (!isValueMap(cells)) {
            throw new EffectfulYamlError(`$state requires a mapping of cells, got: ${describe(cells)}`);
          }
          return handleState(this.node(aux('in'), env), new Map(Object.entries(cells)));
        });
      case 'handle':
        return this.handle(arg, aux('with'), env);
      case 'resume': {
        const k = env.resume;
        if (k === undefined) {
          throw new EffectfulYamlError('$resume is only allowed inside a $handle clause');
        }
        return bind(this.node(arg, env), k);
      }
      default:
        throw new EffectfulYamlError(`$${shape.main} cannot be used as a main key`);
    }
  }

  /** $do の文の並び。$let だけは残りの文へ束縛を伸ばす。 */
  private statements(stmts: readonly unknown[], i: number, env: Env): Comp {
    if (i >= stmts.length) return pure(null);
    const last = i + 1 >= stmts.length;
    const stmt = stmts[i];
    const bindings = letBindingsOf(stmt);
    if (bindings !== undefined) {
      return this.letBind(bindings, 0, env, (next) =>
        last ? pure(null) : this.statements(stmts, i + 1, next),
      );
    }
    const comp = this.node(stmt, env);
    return last ? comp : bind(comp, () => this.statements(stmts, i + 1, env));
  }

  private letBind(
    entries: readonly (readonly [string, unknown])[],
    i: number,
    env: Env,
    k: (env: Env) => Comp,
  ): Comp {
    if (i >= entries.length) return k(env);
    const [name, rhs] = entries[i]!;
    if (name.includes('.')) {
      throw new EffectfulYamlError(`$let binding name must not contain a dot: ${name}`);
    }
    // 右辺は合成。ここの作用は束縛先ではなく後続の文へ合流する。
    return bind(this.node(rhs, env), (v) =>
      this.letBind(entries, i + 1, extendEnv(env, name, v), k),
    );
  }

  private handle(body: unknown, withNode: unknown, env: Env): Comp {
    if (!isNodeMap(withNode)) throw new EffectfulYamlError('$with requires a mapping of clauses');
    const clauses = new Map<string, Clause>();
    let ret: (v: Value) => Comp = pure;
    for (const [name, clauseNode] of Object.entries(withNode)) {
      const closure = this.closureOf(clauseNode, env, name);
      if (name === 'return') {
        ret = (v) => this.node(closure.body, extendEnv(closure.env, closure.param, v));
        continue;
      }
      clauses.set(name, (arg, resume) => {
        // 節のパラメータには演算の引数そのものを渡す（$param の内部表現はここで剥がす）。
        const value = name === 'param' ? (arg as ParamArg).name : arg;
        const inner: Env = {
          vars: new Map(closure.env.vars).set(closure.param, value),
          resume,
        };
        return this.node(closure.body, inner);
      });
    }
    // 節の本体が起こす作用はこのハンドラ自身では捕まらない（handleOps は継続だけを包み直す）。
    return handleOps(this.node(body, env), clauses, ret);
  }

  private closureOf(node: unknown, env: Env, name: string): Closure {
    const comp = this.node(node, env);
    if (comp.tag !== 'pure' || !isClosure(comp.value)) {
      throw new EffectfulYamlError(`$with clause '${name}' must be a function ($fn)`);
    }
    return comp.value;
  }
}

/** $do の文が $let なら、その束縛の並びを返す。 */
function letBindingsOf(stmt: unknown): (readonly [string, unknown])[] | undefined {
  if (!isNodeMap(stmt)) return undefined;
  const shape = analyzeMapping(Object.keys(stmt));
  if (shape.kind !== 'reserved' || shape.main !== 'let') return undefined;
  const bindings = stmt[shape.mainRaw];
  if (!isNodeMap(bindings)) throw new EffectfulYamlError('$let requires a mapping of bindings');
  return Object.entries(bindings);
}

function toMapping(branches: readonly Value[]): Value {
  const out: ValueMap = {};
  for (const b of branches) {
    if (!isValueMap(b)) {
      throw new EffectfulYamlError(`$mapping branch must be a {key, value} mapping, got: ${describe(b)}`);
    }
    const keys = Object.keys(b);
    if (keys.length !== 2 || !('key' in b) || !('value' in b)) {
      throw new EffectfulYamlError(
        `$mapping branch must have exactly the keys 'key' and 'value', got: ${keys.join(', ')}`,
      );
    }
    const key = b['key']!;
    if (typeof key !== 'string') {
      throw new EffectfulYamlError(`$mapping key must be a string, got: ${describe(key)}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new EffectfulYamlError(`duplicate key in $mapping: ${key}`);
    }
    out[key] = b['value']!;
  }
  return out;
}

/** 閉包が文書の値に残ることはエラー。 */
function assertNoFunctionValue(v: Value): void {
  if (isClosure(v) || isOpRef(v)) {
    throw new EffectfulYamlError('a function value cannot escape into the document value');
  }
  if (Array.isArray(v)) {
    for (const x of v) assertNoFunctionValue(x);
    return;
  }
  if (isValueMap(v)) for (const x of Object.values(v)) assertNoFunctionValue(x);
}

// ---------------------------------------------------------------------------
// トップレベルのドライバ
// ---------------------------------------------------------------------------

/**
 * 境界の既定ハンドラを通り抜けて残るのは、失敗と登録演算だけである。
 * 失敗は文書全体のエラーにし、登録演算はホスト関数へ渡す（非同期でよい）。
 */
async function drive(
  comp: Comp,
  ops: Record<string, (arg: Value) => Value | Promise<Value>>,
): Promise<Value> {
  let c = comp;
  for (;;) {
    if (c.tag === 'pure') return c.value;
    if (c.name === 'fail') throw new EffectfulYamlError(`failure: ${describe(c.arg)}`);
    const host = ops[c.name];
    if (host === undefined) throw new EffectfulYamlError(`unregistered operation: $${c.name}`);
    c = c.resume(await host(c.arg));
  }
}

/** 文書を評価する。文書全体が一つの作用境界である。 */
export async function evaluate(doc: unknown, options: EvaluateOptions = {}): Promise<Value> {
  const ops = options.ops ?? {};
  const analyzer = new Analyzer();

  // 作用シグネチャ。既定ハンドラが処理しない = 登録が要る演算だけが残る。
  for (const name of analyzer.boundary(doc, new Map())) {
    if (!(name in ops)) {
      throw new EffectfulYamlError(`unregistered operation: $${name}`);
    }
  }

  const evaluator = new Evaluator(
    analyzer,
    options.params ?? {},
    options.onLog ?? ((v) => console.error(describe(v))),
  );
  const value = await drive(evaluator.boundary(doc, emptyEnv), ops);
  assertNoFunctionValue(value);
  return value;
}
