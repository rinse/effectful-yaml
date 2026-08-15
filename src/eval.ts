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
import { interpolate, refPathOf } from './expr.js';
import { analyzeMapping, HANDLER_REMOVES, unescapeDollar, type MappingShape } from './forms.js';
import {
  bind,
  CHOICE_OPS,
  Closure,
  EffectfulYamlError,
  emptyEnv,
  extendEnv,
  force,
  isClosure,
  isOpRef,
  lookupEnv,
  OpRef,
  perform,
  pure,
  resumeOf,
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
  const rec = (c0: Comp): Comp => {
    const c = force(c0);
    if (c.tag === 'pure') return ret(c.value);
    const clause = clauses.get(c.name);
    // 節はその場で resume することがある（$log や $where）。そこで直に rec を呼ぶと
    // 演算の回数だけ入れ子になるので、bind の節を一枚かませて force のループへ返す。
    const next = (v: Value): Comp => bind(pure(null), () => rec(c.resume(v)));
    if (clause !== undefined) return clause(c.arg, next);
    return { tag: 'op', name: c.name, arg: c.arg, resume: next };
  };
  return rec(comp);
}

const asList = (v: Value): Value[] => v as Value[];

/**
 * 逐次組み立て（リストの要素、マッピングのエントリ、選択の分岐）を O(1) で積むための
 * 不変の cons リスト。積む向きは末尾追加（新しい要素が head）なので文書順とは逆になる。
 * $handle の多重 $resume で同じ継続が再入しても、cons セルは不変でクロージャが
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
 * キーと値の対の cons をマッピングへ実体化する。文書順に前方代入するので、
 * 重複キーは元の `{...acc, [k]: v}` と同じく「最初の出現位置に、最後の値」になる。
 */
function materializeMap(entries: Cons<readonly [string, Value]> | null): ValueMap {
  const out: ValueMap = {};
  for (const [key, v] of toDocumentOrder(entries)) out[key] = v;
  return out;
}

/** 選択を処理し、全分岐の結果を文書順に並べたリストにする（$list、および境界の既定）。 */
function collectChoice(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Clause>([
      [
        'each',
        (arg, k) => {
          const items = eachItems(arg);
          const go = (i: number, chunks: Cons<readonly Value[]> | null): Comp =>
            i >= items.length
              ? pure(flattenChunks(chunks))
              : bind(k(items[i]!), (branch) => go(i + 1, { head: asList(branch), tail: chunks }));
          return go(0, null);
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
  // 記憶は再帰ではなくループの変数として持ち回る（文の数だけ入れ子にならないように）。
  const rec = (c0: Comp, s0: ReadonlyMap<string, Value>): Comp => {
    let c = force(c0);
    let s = s0;
    for (;;) {
      if (c.tag === 'pure') return pure(c.value);
      if (c.name === 'get') {
        const name = requireString(c.arg, '$get cell name');
        if (!s.has(name)) throw new EffectfulYamlError(`uninitialized cell: ${name}`);
        c = force(c.resume(s.get(name)!));
        continue;
      }
      if (c.name === 'set') {
        if (!isValueMap(c.arg)) {
          throw new EffectfulYamlError(`$set requires a mapping, got: ${describe(c.arg)}`);
        }
        const next = new Map(s);
        for (const [cell, v] of Object.entries(c.arg)) next.set(cell, v);
        c = force(c.resume(null));
        s = next;
        continue;
      }
      const m = c;
      const here = s;
      return { tag: 'op', name: m.name, arg: m.arg, resume: (v) => rec(m.resume(v), here) };
    }
  };
  return rec(comp, init);
}

// ---------------------------------------------------------------------------
// 静的な作用推論
// ---------------------------------------------------------------------------

/** レキシカルな名前 -> 静的に追跡できた値。undefined は「構造的に追跡できない」。 */
type SEnv = Map<string, Track | undefined>;

/**
 * 静的に追跡できた値（行の木）。undefined は追跡不能。
 * - closure / opref: 呼べる値。呼んだときの作用は call() が本体から求める。
 * - struct: マッピングとリストのリテラル。キーは名前、リストは添字の 10 進表記。
 * - alt: 分岐しうる値（`$if` の両分岐、リテラルのリストからの `$each`）の過大近似。
 */
type Track =
  | {
      readonly kind: 'closure';
      /** 循環ガードの同一性に使う $fn ノード。 */
      readonly fn: object;
      readonly param: string;
      readonly body: unknown;
      /** 定義位置の追跡環境（レキシカル）。$let の続きに汚されないよう複製で持つ。 */
      readonly senv: SEnv;
    }
  | { readonly kind: 'opref'; readonly name: string }
  | { readonly kind: 'struct'; readonly fields: ReadonlyMap<string, Track> }
  | { readonly kind: 'alt'; readonly alts: readonly Track[] };

/** 追跡できた子だけを持つ構造ノード。追跡できない子はキーごと落とす（＝たどれない）。 */
function structOf(entries: readonly (readonly [string, Track | undefined])[]): Track {
  const fields = new Map<string, Track>();
  for (const [key, t] of entries) if (t !== undefined) fields.set(key, t);
  return { kind: 'struct', fields };
}

/** 分岐しうる値。一つでも追跡できない分岐があれば全体を追跡不能にする。 */
function altOf(ts: readonly (Track | undefined)[]): Track | undefined {
  if (ts.length === 0) return undefined;
  const alts: Track[] = [];
  for (const t of ts) {
    if (t === undefined) return undefined;
    alts.push(t);
  }
  return { kind: 'alt', alts };
}

/** 追跡木のパスを一区画たどる。たどれなければ undefined。 */
function field(t: Track | undefined, seg: string): Track | undefined {
  if (t === undefined) return undefined;
  if (t.kind === 'struct') return t.fields.get(seg);
  if (t.kind === 'alt') return altOf(t.alts.map((a) => field(a, seg)));
  return undefined;
}

/**
 * 木のどこかに関数値があるか。
 * 無ければ、その木をたどった先の呼び出しはすべて追跡不能なので、引数としては undefined と同じ。
 * 同一視することでメモの鍵が揃い、データだけの引数で本体を何度も走査せずに済む。
 */
function hasFunction(t: Track): boolean {
  switch (t.kind) {
    case 'closure':
    case 'opref':
      return true;
    case 'struct':
      return [...t.fields.values()].some(hasFunction);
    case 'alt':
      return t.alts.some(hasFunction);
  }
}

const NO_REFS: ReadonlySet<string> = new Set();
const refsCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * 部分木の解析が追跡環境から読みうる名前（純粋に構文的な集合）。
 * 追跡環境を読むのは二箇所だけである。
 *   - `$.名前` のレキシカルな呼び出し（dollar の 'lexical'）
 *   - スカラー全体がちょうど一つの参照のとき、その先頭区画（track の refPathOf）
 * 束縛（$let / $fn のパラメータ）は無視するので、自由変数の上位集合になる。
 * 上位集合であることが要る（鍵が細かくなる分には結果が変わらない）のは、
 * これを閉包の正準形の鍵に使うためである。
 */
function refsOf(node: unknown): ReadonlySet<string> {
  if (typeof node === 'string') {
    const path = refPathOf(node);
    return path === undefined ? NO_REFS : new Set([path[0]!]);
  }
  if (typeof node !== 'object' || node === null) return NO_REFS;
  const cached = refsCache.get(node);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  const children = Array.isArray(node) ? node : Object.values(node);
  if (!Array.isArray(node)) {
    for (const key of Object.keys(node)) if (key.startsWith('$.')) out.add(key.slice(2));
  }
  for (const child of children) for (const name of refsOf(child)) out.add(name);
  refsCache.set(node, out);
  return out;
}

/**
 * 作用集合を求めつつ、リストに評価される作用境界のノードを記録する。
 * 出現主義なので、実行されない分岐（$if の選ばれない側）の演算も数える。
 */
class Analyzer {
  /** 値がリストになる境界ノード。スカラーは作用を持てないので object だけを入れる。 */
  readonly listBoundaries = new WeakSet<object>();

  /** 閉包の呼び出しのメモ。鍵は「閉包の正準 ID, 引数の正準 ID」。 */
  private readonly memo = new Map<string, ReadonlySet<string> | undefined>();

  /** 解析中の $fn ノード。再入は自己適用なので追跡不能に倒す（停止性）。 */
  private readonly inProgress = new Set<object>();

  // -------------------------------------------------------------------------
  // 追跡木の正準化（hash-consing）
  //
  // track() は呼ばれるたびに新しい Track を作るので、木の同一性で引くメモは
  // 「同じ $fn を同じ環境で捕まえた閉包」を毎回別物と見なし、呼び出し位置ごとに
  // 本体を解析し直す（入れ子の深さに対して指数）。構造的に等しい木へ同じ ID を
  // 与えれば、その再走査は 1 回に畳まれる。
  // 木は有向非巡回である（senv は定義時点のスナップショットで、$let は非再帰）ため、
  // 正準化は停止する。
  // -------------------------------------------------------------------------

  private nextId = 0;
  /** 正準キー -> 代表 ID。 */
  private readonly ids = new Map<string, number>();
  /** $fn ノードなど object の同一性 -> ID。 */
  private readonly objIds = new WeakMap<object, number>();
  /** 同じ Track を二度たどらないための覚え書き（Track は不変）。 */
  private readonly trackIds = new WeakMap<object, number>();

  private objId(o: object): number {
    let id = this.objIds.get(o);
    if (id === undefined) {
      id = this.nextId++;
      this.objIds.set(o, id);
    }
    return id;
  }

  /** 追跡木の正準 ID。追跡不能（undefined）は -1。 */
  private canon(t: Track | undefined): number {
    if (t === undefined) return -1;
    const cached = this.trackIds.get(t);
    if (cached !== undefined) return cached;
    const key = this.canonKey(t);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(key, id);
    }
    this.trackIds.set(t, id);
    return id;
  }

  private canonKey(t: Track): string {
    switch (t.kind) {
      case 'opref':
        return JSON.stringify(['o', t.name]);
      case 'struct':
        // ponytail: 鍵はフィールド数に比例した文字列。巨大なリテラルのリストを
        // 束縛して呼び出しに渡すと 1 回だけ長い鍵を組む。困ったら深さで打ち切る。
        return JSON.stringify(['s', [...t.fields].map(([k, v]) => [k, this.canon(v)])]);
      case 'alt':
        return JSON.stringify(['a', t.alts.map((a) => this.canon(a))]);
      case 'closure': {
        // 本体の解析が捕まえた環境から読みうる名前だけを鍵に入れる。ここを絞らないと、
        // 各レベルの環境に呼び出し経路が丸ごと残り、正準形にしても指数のままになる。
        // パラメータは applyClosure が引数で必ず上書きするので除く。
        // 追跡不能（-1）の束縛も入れる（名前の有無はシャドーイングとして意味を持つ）。
        const env: (readonly [string, number])[] = [];
        for (const name of refsOf(t.body)) {
          if (name !== t.param) env.push([name, this.canon(t.senv.get(name))] as const);
        }
        return JSON.stringify(['c', this.objId(t.fn), env]);
      }
    }
  }

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
        return union(
          this.effects(node[shape.raw], senv),
          // 引数の追跡木をパラメータに束縛して本体を解析する（多相的解析）。
          this.call(senv.get(shape.name), this.track(node[shape.raw], senv)) ?? [],
        );
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
        // 値を作るだけで作用は起こさない。本体の作用は呼び出しを追跡できる側
        // （$let の束縛、$pipe の段、$handle の節）が callable() で数える。
        // ここで本体を走査してはならない。定義のたびに二重走査になり、
        // 入れ子の深さに対して指数的になる。
        return new Set();
      case 'pipe': {
        const stages = Array.isArray(aux('through')) ? (aux('through') as unknown[]) : [];
        const rows: Iterable<string>[] = [this.effects(arg, senv)];
        // 段に渡る値を静的に追えるのは先頭だけ。2 段目以降の引数は追跡不能に倒す。
        let argument = this.track(arg, senv);
        for (const stage of stages) {
          rows.push(this.effects(stage, senv), this.call(this.track(stage, senv), argument) ?? []);
          argument = undefined;
        }
        return union(...rows);
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
          // 節のパラメータは演算の実行時の引数なので、追跡木は渡せない。
          ...Object.values(clauses).map((c) => this.call(this.track(c, senv), undefined) ?? []),
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
      senv.set(name, this.track(rhs, senv));
    }
    return out;
  }

  /**
   * ノードが静的に表す値の追跡木。追跡できなければ undefined。
   * ここでは $fn の本体を走査しない（走査は call() だけが行う）。
   * これを守らないと、定義のたびに本体を数える二重走査になり、入れ子の深さに対して爆発する。
   */
  private track(node: unknown, senv: SEnv): Track | undefined {
    if (typeof node === 'string') {
      const path = refPathOf(node);
      if (path === undefined) return undefined;
      return path.slice(1).reduce<Track | undefined>(field, senv.get(path[0]!));
    }
    if (Array.isArray(node)) {
      return structOf(node.map((n, i) => [String(i), this.track(n, senv)] as const));
    }
    if (!isNodeMap(node)) return undefined;
    const shape = analyzeMapping(Object.keys(node));
    if (shape.kind === 'plain') {
      return structOf(
        Object.entries(node).map(([k, v]) => [unescapeDollar(k), this.track(v, senv)] as const),
      );
    }
    if (shape.kind !== 'reserved') return undefined;
    switch (shape.main) {
      case 'fn': {
        const param = node[shape.mainRaw];
        if (typeof param !== 'string') return undefined;
        return {
          kind: 'closure',
          fn: node,
          param,
          body: node[shape.aux.get('body')!],
          senv: new Map(senv),
        };
      }
      case 'op': {
        const name = node[shape.mainRaw];
        return typeof name === 'string' ? { kind: 'opref', name } : undefined;
      }
      case 'if':
        return altOf([
          this.track(node[shape.aux.get('then')!], senv),
          this.track(node[shape.aux.get('else')!], senv),
        ]);
      case 'each': {
        // リテラルのリストから選ぶ形だけ追える。マッピングの $each が選ぶのは
        // 値そのものではなく {key, value} なので、値の木で近似してはならない。
        const items = node[shape.mainRaw];
        return Array.isArray(items) ? altOf(items.map((n) => this.track(n, senv))) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * 追跡木の値を引数 argument で呼んだときの作用集合。追跡できなければ undefined。
   * 各 $fn 本体の走査はここだけが行う（effects() は $fn を素通りする）。
   */
  private call(t: Track | undefined, argument: Track | undefined): ReadonlySet<string> | undefined {
    if (t === undefined) return undefined;
    switch (t.kind) {
      case 'opref':
        return new Set([t.name]);
      case 'struct':
        // マッピングやリストは呼べない。呼べば実行時のエラーだが、推論は行を作らない。
        return undefined;
      case 'alt': {
        const rows: ReadonlySet<string>[] = [];
        for (const a of t.alts) {
          const row = this.call(a, argument);
          if (row === undefined) return undefined;
          rows.push(row);
        }
        return union(...rows);
      }
      case 'closure':
        return this.applyClosure(t, argument === undefined || !hasFunction(argument) ? undefined : argument);
    }
  }

  /**
   * 閉包の本体を、引数の追跡木をパラメータに束縛して解析する。
   * メモの鍵は（閉包の正準 ID、引数の正準 ID）。閉包の正準形は $fn ノードと、
   * 捕まえた環境のうち本体が読みうる束縛なので、同じ $fn でも環境が違えば別の鍵になる。
   * 進行中の $fn ノードへ再入したら自己適用なので undefined（追跡不能）に倒す。
   * これで解析の停止性は $fn ノードの個数で押さえられる。
   */
  private applyClosure(t: Track & { kind: 'closure' }, argument: Track | undefined): ReadonlySet<string> | undefined {
    const key = `${this.canon(t)},${this.canon(argument)}`;
    if (this.memo.has(key)) return this.memo.get(key);
    if (this.inProgress.has(t.fn)) return undefined;
    this.inProgress.add(t.fn);
    try {
      const inner: SEnv = new Map(t.senv);
      inner.set(t.param, argument);
      const row = this.effects(t.body, inner);
      // ponytail: 循環ガードが働いた内側の結果もそのままメモに残る（作用を数え落とす向き＝
      // 追跡不能と同じ扱いなので健全性は崩れない）。気になるならガード発火を数えて弾く。
      this.memo.set(key, row);
      return row;
    } finally {
      this.inProgress.delete(t.fn);
    }
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

/**
 * $param の演算引数の内部表現。
 * optional は「呼び出し位置に $default があるので、未提供なら ABSENT を返してよい」。
 * $default のノード自体は呼び出し位置に留まり、未提供のときだけ評価される（遅延位置）。
 */
interface ParamArg {
  readonly name: string;
  readonly optional?: boolean;
}

/** handleParam が「渡されていない」を伝える番兵。同一性でだけ判定し、文書からは作れない。 */
const ABSENT: Value = Object.freeze({});

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
        `(a function value picked at run time, e.g. out of data or out of a $do result). ` +
        `Wrap the call in an explicit handler ($list:, $first: or $mapping:) to declare the shape ` +
        `instead of relying on static tracking; the choice is then handled there. ` +
        `Boundary node: ${where}`,
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
            if (spec.optional === true) return k(ABSENT);
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
      const go = (i: number, acc: Cons<Value> | null): Comp =>
        i >= node.length
          ? pure(toDocumentOrder(acc))
          : bind(rec(node[i]), (v) => go(i + 1, { head: v, tail: acc }));
      return go(0, null);
    }
    if (!isNodeMap(node)) {
      throw new EffectfulYamlError(`unsupported node: ${String(node)}`);
    }
    if (analyzeMapping(Object.keys(node)).kind !== 'plain') return undefined;
    // キーは $$ を literal な $ に解決するだけ（計算されたキーは $mapping で書く）。
    const entries = Object.entries(node);
    const go = (i: number, acc: Cons<readonly [string, Value]> | null): Comp => {
      if (i >= entries.length) return pure(materializeMap(acc));
      const [rawKey, valueNode] = entries[i]!;
      return bind(rec(valueNode), (v) =>
        go(i + 1, { head: [unescapeDollar(rawKey), v], tail: acc }),
      );
    };
    return go(0, null);
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
          // $default は $if の分岐と同じ遅延位置。パラメータが渡されていれば評価しない
          // （作用の推論は出現主義なので、集合には数える）。
          return bind(perform('param', { ...spec, optional: true }), (v) =>
            v === ABSENT ? this.node(aux('default'), env) : pure(v),
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
        const k = resumeOf(env);
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
        const inner: Env = { parent: closure.env, name: closure.param, value, resume };
        return this.node(closure.body, inner);
      });
    }
    // 節の本体が起こす作用はこのハンドラ自身では捕まらない（handleOps は継続だけを包み直す）。
    return handleOps(this.node(body, env), clauses, ret);
  }

  private closureOf(node: unknown, env: Env, name: string): Closure {
    const comp = force(this.node(node, env));
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
  let c = force(comp);
  for (;;) {
    if (c.tag === 'pure') return c.value;
    if (c.name === 'fail') throw new EffectfulYamlError(`failure: ${describe(c.arg)}`);
    const host = ops[c.name];
    if (host === undefined) throw new EffectfulYamlError(`unregistered operation: $${c.name}`);
    c = force(c.resume(await host(c.arg)));
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
