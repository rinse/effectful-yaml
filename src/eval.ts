/**
 * 静的な作用推論と評価器。
 * 仕様: docs/grammar.md（草案 0.5）「評価モデル」節、とりわけ「作用境界」「合成と境界」。
 *
 * 二つのことを一体で行う。
 * 1. Analyzer: 文書を実行せずに各ノードの作用集合を求める。
 *    - 登録されていない演算を評価前に拒否する。
 *    - 各作用境界の値の形（単値かリストか）を決める。実行結果の個数からは決めない。
 * 2. Evaluator: Comp（freer モナド風の計算表現）を組み立てる。
 *    ハンドラは Comp → Comp の純粋変換なので、$handle の節は $resume を何度でも呼べる。
 *
 * 作用境界は、文書全体と、データの中に現れた最も外側の `$` 式だけである。
 * 境界の内側には、明示のハンドラ（$handle と std の派生ハンドラ）を除いて
 * 作用を堰き止める場所はない。データ構成（リストの要素、`$` キーを持たないマッピングの値）も、
 * 演算の引数も、呼び出しの引数と本体も、$collect の対象と関数本体も、
 * すべて合成であり、作用はそのまま周囲へ合流する。
 *
 * この三態を Analyzer と Evaluator が同じ形で持つ（片方だけ直すのは誤り）。
 *   - data:     まだどの `$` 式にも入っていないデータ位置。`$` 式に出会ったらそこが境界。
 *   - boundary: 境界。中身を評価し、既定ハンドラ一式で処理し尽くす。
 *   - node:     合成位置（`$` 式の内側）。子も一律に合成。
 */
import { hasPathRef, interpolate, MissingPathError, refPathOf } from './expr.js';
import { analyzeMapping, HANDLER_REMOVES, unescapeDollar, type MappingShape } from './forms.js';
import { empty, get, insert, type PMap } from './pmap.js';
import {
  bind,
  CHOICE_OPS,
  Closure,
  EffectfulYamlError,
  emptyEnv,
  extendEnv,
  FAIL_OPS,
  force,
  isClosure,
  lookupEnv,
  OperationFailure,
  perform,
  pure,
  resumeOf,
  STATE_OPS,
  type Comp,
  type Env,
  type Value,
} from './types.js';

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 境界の既定ハンドラ一式が処理する演算（外側から 失敗・パラメータ・ログ・状態・選択）。 */
const DEFAULT_OPS: ReadonlySet<string> = new Set([
  ...FAIL_OPS,
  'std.param',
  'std.log',
  ...STATE_OPS,
  ...CHOICE_OPS,
]);

type NodeMap = Record<string, unknown>;
type ValueMap = { [key: string]: Value };

const isNodeMap = (n: unknown): n is NodeMap =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

const isValueMap = (v: Value): v is ValueMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isClosure(v);

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
  return JSON.stringify(v) ?? String(v);
}

/**
 * $fn のパラメータ。文字列一つ、または相異なる名前の 1 個以上の列（カリー化の導出形）。
 * 形の誤りはデータの変動ではないのでエラーにする。解析と評価の両方から呼ぶ。
 */
function fnParamsOf(raw: unknown): readonly string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.length > 0 && raw.every((p) => typeof p === 'string')) {
    if (new Set(raw).size !== raw.length) {
      throw new EffectfulYamlError(`duplicate $fn parameter name: ${raw.join(', ')}`);
    }
    return raw as string[];
  }
  throw new EffectfulYamlError(
    `$fn parameter must be a name or a non-empty list of distinct names, got: ${JSON.stringify(raw)}`,
  );
}

/** 構造を回る形（$std.each の分岐、$collect の対象）。マッピングは {key, value} に分解する。 */
function entriesOf(arg: Value, what: string): Value[] {
  if (Array.isArray(arg)) return arg;
  if (isValueMap(arg)) return Object.entries(arg).map(([key, value]) => ({ key, value }));
  throw new EffectfulYamlError(`${what} requires a list or mapping, got: ${describe(arg)}`);
}

/**
 * 第一階の標準演算（値から値を計算するだけ）。導出できないが評価器の協力も要らないので、
 * カーネルではなく「処理系が事前登録する演算」として供給の層に置く。
 * ホスト登録の演算と同じ経路（境界を抜けてドライバへ）を通る。
 */
const BUILTIN_OPS: Readonly<Record<string, (arg: Value) => Value>> = {
  'std.range': (n) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new EffectfulYamlError(`$std.range requires a natural number, got: ${describe(n)}`);
    }
    return Array.from({ length: n }, (_, i) => i);
  },
};

/**
 * $std.lookup の意味（展開と等価な O(1) の照会）。無いキーは呼び出し位置の std.fail。
 * in がマッピングでない・key が文字列でないのは形の誤りなのでエラー。
 */
function lookupComp(arg: Value): Comp {
  if (!isValueMap(arg)) {
    throw new EffectfulYamlError(`$std.lookup requires a mapping {in, key}, got: ${describe(arg)}`);
  }
  const m = arg['in'];
  const k = requireString(arg['key'], '$std.lookup key');
  if (m === undefined || !isValueMap(m)) {
    throw new EffectfulYamlError(`$std.lookup 'in' must be a mapping, got: ${describe(m ?? null)}`);
  }
  return Object.prototype.hasOwnProperty.call(m, k) ? pure(m[k]!) : perform('std.fail', `missing key '${k}'`);
}

/**
 * $std.merge の意味（展開と等価な直接のマージ）。値は後勝ち、キーの位置は初出。
 * 引数がリストでない・要素がマッピングでないのは形の誤りなのでエラー。
 */
function mergeComp(arg: Value): Comp {
  if (!Array.isArray(arg)) {
    throw new EffectfulYamlError(`$std.merge requires a list of mappings, got: ${describe(arg)}`);
  }
  const out: Record<string, Value> = {};
  for (const m of arg) {
    if (!isValueMap(m)) {
      throw new EffectfulYamlError(`$std.merge element must be a mapping, got: ${describe(m)}`);
    }
    for (const [k, v] of Object.entries(m)) setOwn(out, k, v);
  }
  return pure(out);
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
    // 節はその場で resume することがある（std.log の節など）。そこで直に rec を呼ぶと
    // 演算の回数だけ入れ子になるので、bind の節を一枚かませて force のループへ返す。
    const next = (v: Value): Comp => bind(pure(null), () => rec(c.resume(v)));
    // raise された std.fail も同じ形で包み直す。rec を通すことで、raise された std.fail を
    // このハンドラ自身の節（たとえば $std.opt の std.fail 節）が捕捉できる。
    const nextRaise = (v: Value): Comp => bind(pure(null), () => rec(c.raise(v)));
    if (clause !== undefined) return clause(c.arg, next);
    return { tag: 'op', name: c.name, arg: c.arg, resume: next, raise: nextRaise };
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
 * 重複キーは元の `{...acc, [k]: v}` と同じく「最初の出現位置に、最後の値」になる。
 */
function materializeMap(entries: Cons<readonly [string, Value]> | null): ValueMap {
  const out: ValueMap = {};
  for (const [key, v] of toDocumentOrder(entries)) setOwn(out, key, v);
  return out;
}

/** 選択を処理し、全分岐の結果を文書順に並べたリストにする（$std.list、および境界の既定）。 */
function collectChoice(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Clause>([
      [
        'std.each',
        (arg, k) => {
          const items = entriesOf(arg, '$std.each');
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
 * 選択と失敗を処理し、成功した最初の分岐を [v]、全滅を [] で表す（$std.first）。
 * go(i) は成功を得た時点で go(i + 1) を呼ばないので、最初の成功より後の分岐は
 * 評価されず、その作用も起きない。
 */
function collectFirst(comp: Comp): Comp {
  return handleOps(
    comp,
    new Map<string, Clause>([
      [
        'std.each',
        (arg, k) => {
          const items = entriesOf(arg, '$std.each');
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
 * 状態を処理する（$std.state、および境界の既定の `$std.state: {}`）。
 * 記憶を再帰の引数として持ち回るので、外側のハンドラが複数回 resume すると
 * 各再開はその演算の時点の記憶から分岐する（= ハンドラは自分より内側だけを見る）。
 */
function handleState(comp: Comp, init: PMap<Value>): Comp {
  // 記憶は再帰ではなくループの変数として持ち回る（文の数だけ入れ子にならないように）。
  // 記憶も環境と同じ永続平衡木である。$set ごとの全コピーだと書き込み回数 x セル数で
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
      };
    }
  };
  return rec(comp, init);
}

// ---------------------------------------------------------------------------
// 静的な作用推論
// ---------------------------------------------------------------------------

/**
 * レキシカルな名前 -> 静的に追跡できた値。undefined は「構造的に追跡できない」。
 * 評価器の Env と同じ永続平衡木なので、伸ばすのも捕まえるのも複製を伴わない
 * （閉包の捕獲は木への参照ひとつ = O(1)、束縛の追加は O(log n)）。
 * get は「未束縛」と「undefined が束縛されている」を区別しないが、これは Map でも同じで、
 * 解析の健全性はもともとその区別に依存していない（正準形ではどちらも -1 に潰れる）。
 */
type SEnv = PMap<Track | undefined>;

/**
 * 静的に追跡できた値（行の木）。undefined は追跡不能。
 * - closure: 呼べる値。呼んだときの作用は call() が本体から求める。
 * - struct: マッピングとリストのリテラル。キーは名前、リストは添字の 10 進表記。
 * - alt: 分岐しうる値（`$if` の両分岐、リテラルのリストからの `$each`）の過大近似。
 */
type Track =
  | {
      readonly kind: 'closure';
      /** 循環ガードの同一性に使う $fn ノード。 */
      readonly fn: object;
      /** 残りのパラメータ（1 個以上）。部分適用のたびに先頭が senv へ移る。 */
      readonly params: readonly string[];
      readonly body: unknown;
      /** 定義位置の追跡環境（レキシカル）。木は不変なので参照ひとつで捕まえられる。 */
      readonly senv: SEnv;
    }
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
      return true;
    case 'struct':
      return [...t.fields.values()].some(hasFunction);
    case 'alt':
      return t.alts.some(hasFunction);
  }
}

/**
 * 呼び出しの解析結果。row は呼び出しが起こす作用集合（undefined は追跡不能）、
 * out は返り値の追跡木（undefined は追跡不能）。
 */
type CallResult = {
  readonly row: ReadonlySet<string> | undefined;
  readonly out: Track | undefined;
};

const UNTRACKED_CALL: CallResult = { row: undefined, out: undefined };

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
    // `$.a.self` が読むレキシカルな束縛は先頭区画の a だけ（self 以降はその値のキーアクセス）。
    // パス全体 "a.self" を足すと a の読みを鍵から落とし、環境が異なる閉包同士が
    // 正準形の同じ鍵（canonKey の case 'closure'）に潰れて作用の行が不健全になる。
    for (const key of Object.keys(node)) {
      if (key.startsWith('$.')) out.add(key.slice(2).split('.')[0]!);
    }
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
  private readonly memo = new Map<string, CallResult>();

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
      case 'struct':
        // ponytail: 鍵はフィールド数に比例した文字列。巨大なリテラルのリストを
        // 束縛して呼び出しに渡すと 1 回だけ長い鍵を組む。困ったら深さで打ち切る。
        return JSON.stringify(['s', [...t.fields].map(([k, v]) => [k, this.canon(v)])]);
      case 'alt':
        return JSON.stringify(['a', t.alts.map((a) => this.canon(a))]);
      case 'closure': {
        // 本体の解析が捕まえた環境から読みうる名前だけを鍵に入れる。ここを絞らないと、
        // 各レベルの環境に呼び出し経路が丸ごと残り、正準形にしても指数のままになる。
        // 残りのパラメータは applyClosure が引数で必ず上書きするので除く
        // （部分適用で束縛済みのパラメータは params から抜けているため、鍵に入る）。
        // 追跡不能（-1）の束縛も入れる（名前の有無はシャドーイングとして意味を持つ）。
        // 残り個数も鍵に入れる。同じ $fn でも部分適用の進み具合が違えば、適用の意味
        // （本体を走らせるか、閉包を返すか）が違うからである。
        const env: (readonly [string, number])[] = [];
        for (const name of refsOf(t.body)) {
          if (!t.params.includes(name)) env.push([name, this.canon(get(t.senv, name))] as const);
        }
        return JSON.stringify(['c', this.objId(t.fn), t.params.length, env]);
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
    // パスをたどる参照は欠落しうるので std.fail を数える（裸の ${x} は純粋）。
    if (typeof node === 'string') return hasPathRef(node) ? new Set(FAIL_OPS) : new Set();
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
      case 'lexical': {
        // 先頭区画は束縛の解決、残りは値の追跡木をたどるキーアクセス（track() の ref と同じ形）。
        const path = shape.name.split('.');
        const target = path.slice(1).reduce<Track | undefined>(field, get(senv, path[0]!));
        return union(
          this.effects(node[shape.raw], senv),
          // 引数の追跡木をパラメータに束縛して本体を解析する（多相的解析）。
          this.call(target, this.track(node[shape.raw], senv)).row ?? [],
        );
      }
      case 'op':
        return this.operation(shape, node, senv);
      case 'reserved':
        return this.reserved(shape, node, senv);
    }
  }

  /**
   * 演算の呼び出し。std の派生ハンドラだけが部分処理を行い、それ以外は
   * 「引数の作用 ∪ 自分の名前」である（標準演算もホスト登録の演算も同じ規則）。
   */
  private operation(
    shape: Extract<MappingShape, { kind: 'op' }>,
    node: NodeMap,
    senv: SEnv,
  ): Set<string> {
    const arg = node[shape.raw];
    const aux = (name: string): unknown => {
      const raw = shape.aux.get(name);
      return raw === undefined ? undefined : node[raw];
    };
    switch (shape.name) {
      case 'std.list':
      case 'std.mapping':
      case 'std.first':
        return without(this.effects(arg, senv), HANDLER_REMOVES[shape.name]!);
      case 'std.opt':
        // $default は遅延位置だが、作用の推論は出現主義なので中の演算も数える（$std.param と同じ）。
        return union(
          without(this.effects(arg, senv), FAIL_OPS),
          shape.aux.has('default') ? this.effects(aux('default'), senv) : [],
        );
      case 'std.where':
        // 導出形。展開 {$if: 条件, $then: null, $else: {$std.each: []}} のとおり std.each を数える。
        return union(this.effects(arg, senv), CHOICE_OPS);
      case 'std.lookup':
        // 展開（$std.first の照合）が選択を処理し尽くすので、出現が数えるのは std.fail と引数の作用だけ。
        return union(this.effects(arg, senv), FAIL_OPS);
      case 'std.merge':
        // 展開（$std.mapping の重ね合わせ）が選択と欠落を処理し尽くすので、出現が数えるのは引数の作用だけ。
        return this.effects(arg, senv);
      case 'std.state':
        // $in の無い $std.state は $do の文の位置でだけ意味を持ち（doEffects が扱う）、
        // 位置外は評価器がエラーにする。推論は出現主義なので、ここは初期値の作用だけ数えて通す
        // （aux('in') が undefined なら本体の作用は空集合）。
        return union(this.effects(arg, senv), without(this.effects(aux('in'), senv), STATE_OPS));
      case 'std.param':
        // $default は遅延位置だが、作用の推論は出現主義なので中の演算も数える。
        return union(
          this.effects(arg, senv),
          shape.aux.has('default') ? this.effects(aux('default'), senv) : [],
          ['std.param'],
        );
      default:
        // ホスト登録の演算は失敗を通知できるので、出現は std.fail も数える（パスをたどる参照と同じ扱い）。
        return shape.name.startsWith('std.')
          ? union(this.effects(arg, senv), [shape.name])
          : union(this.effects(arg, senv), [shape.name], FAIL_OPS);
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
      case 'do':
        return this.doEffects(Array.isArray(arg) ? arg : [], senv);
      case 'let': {
        // 右辺を文書順に合流させ、束縛を伸ばした senv で $in の本体を見る
        // （逐次のカーネル構文）。$in の無い単独の $let は評価器がエラーにするが、
        // 推論は出現主義なので右辺の作用だけ数えて通す。
        const out = new Set<string>();
        let cur = senv;
        if (isNodeMap(arg)) {
          for (const [name, rhs] of Object.entries(arg)) {
            for (const x of this.effects(rhs, cur)) out.add(x);
            cur = insert(cur, name, this.track(rhs, cur));
          }
        }
        if (shape.aux.has('in')) for (const x of this.effects(aux('in'), cur)) out.add(x);
        return out;
      }
      case 'if':
        return union(
          this.effects(arg, senv),
          this.effects(aux('then'), senv),
          this.effects(aux('else'), senv),
        );
      case 'fn':
        // 値を作るだけで作用は起こさない。本体の作用は呼び出しを追跡できる側
        // （$let の束縛、$handle の節）が call() で数える。
        // ここで本体を走査してはならない。定義のたびに二重走査になり、
        // 入れ子の深さに対して指数的になる。
        fnParamsOf(arg); // 形の検査だけ行う（出現主義なので、実行されない位置でも検査する）
        return new Set();
      case 'collect':
        // $collect 自身は作用を持たない。対象の作用と、追跡できる関数本体の作用の合併。
        // ponytail: 関数へ渡す引数の追跡木は undefined（$handle の節と同じ天井）。
        // 要素ごとの追跡が要るようになったら対象がリテラルのときだけ altOf で渡す。
        return union(
          this.effects(arg, senv),
          this.effects(aux('with'), senv),
          this.call(this.track(aux('with'), senv), undefined).row ?? [],
        );
      case 'handle':
        return this.handled(this.effects(arg, senv), aux('with'), senv);
      case 'with':
        // 単独の $with は $do の文の位置でだけ意味を持つ（位置外は評価器がエラーにする）。
        // 推論は出現主義なので、節の本体の作用だけ数えて通す（何も取り除かない）。
        return this.handled(new Set(), arg, senv);
      case 'resume':
        // 継続の作用は $handle の本体側で既に数えている。ここは引数だけ。
        return this.effects(arg, senv);
      default:
        return new Set();
    }
  }

  /**
   * $with の節が本体の作用集合に及ぼす効果。宣言した演算（return 以外の節名）を取り除き、
   * 節の本体の作用を足す。$handle と $do の $with 文で共通。
   */
  private handled(body: Set<string>, withNode: unknown, senv: SEnv): Set<string> {
    const clauses = isNodeMap(withNode) ? withNode : {};
    const removed = new Set(Object.keys(clauses).filter((k) => k !== 'return'));
    return union(
      without(body, removed),
      // 節のパラメータは演算の実行時の引数なので、追跡木は渡せない。
      ...Object.values(clauses).map((c) => this.call(this.track(c, senv), undefined).row ?? []),
    );
  }

  /**
   * $do の文の並びの作用。文形（$let / $in なしの $std.state / 単独の $with）は
   * 残りの文を本体に取るので、その作用集合が定まるまで除去を適用できない。
   * そこで二度なめる。前向きに束縛を伸ばしながら「自前の作用」と除去の仕方を記録し、
   * 後ろから畳んで残りの集合へ適用する（再帰で書くと文の数だけスタックを積む）。
   * 束縛は文から文へ伸びる（同じ $let の中でも後の右辺は前の束縛を見る）が、
   * 外側の senv は不変なので $do を出れば元のままである。
   */
  private doEffects(stmts: readonly unknown[], senv: SEnv): Set<string> {
    type Step =
      /** 残りの作用に自前の作用を足すだけの文（文形でない文と $let 文）。 */
      | { readonly kind: 'plain'; readonly own: Set<string> }
      /** 残りから状態の演算を除き、初期値の作用を足す。 */
      | { readonly kind: 'state'; readonly own: Set<string> }
      /** 残りから節名を除き、節の本体の作用を足す（節は文の位置の追跡環境で見る）。 */
      | { readonly kind: 'with'; readonly clauses: unknown; readonly senv: SEnv };

    const steps: Step[] = [];
    let cur = senv;
    // 除去を行うのは $std.state 文と $with 文だけなので、その手前までの文の作用は
    // 一つに畳んでから積む（文の数だけ Set を抱えない）。
    let pending = new Set<string>();
    const flush = (): void => {
      if (pending.size > 0) steps.push({ kind: 'plain', own: pending });
      pending = new Set();
    };
    for (const stmt of stmts) {
      const form = statementFormOf(stmt);
      if (form === undefined) {
        for (const x of this.effects(stmt, cur)) pending.add(x);
        continue;
      }
      switch (form.kind) {
        case 'let':
          if (isNodeMap(form.bindings)) {
            for (const [name, rhs] of Object.entries(form.bindings)) {
              for (const x of this.effects(rhs, cur)) pending.add(x);
              cur = insert(cur, name, this.track(rhs, cur));
            }
          }
          break;
        case 'state':
          // 初期値の作用はハンドラの外側（＝この文の位置）に現れる。
          flush();
          steps.push({ kind: 'state', own: this.effects(form.init, cur) });
          break;
        case 'with':
          flush();
          steps.push({ kind: 'with', clauses: form.clauses, senv: cur });
          break;
      }
    }
    flush();

    let out = new Set<string>();
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      if (step.kind === 'with') out = this.handled(out, step.clauses, step.senv);
      else if (step.kind === 'state') out = union(step.own, without(out, STATE_OPS));
      else out = union(step.own, out);
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
      return path.slice(1).reduce<Track | undefined>(field, get(senv, path[0]!));
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
    if (shape.kind === 'op') {
      // リテラルのリストから選ぶ形だけ追える。マッピングの $std.each が選ぶのは
      // 値そのものではなく {key, value} なので、値の木で近似してはならない。
      if (shape.name !== 'std.each') return undefined;
      const items = node[shape.raw];
      return Array.isArray(items) ? altOf(items.map((n) => this.track(n, senv))) : undefined;
    }
    if (shape.kind === 'lexical') {
      // 追跡できる呼び出しの結果（部分適用が返す閉包を含む）。dollar() と同じ経路解決。
      const path = shape.name.split('.');
      const target = path.slice(1).reduce<Track | undefined>(field, get(senv, path[0]!));
      return this.call(target, this.track(node[shape.raw], senv)).out;
    }
    if (shape.kind !== 'reserved') return undefined;
    switch (shape.main) {
      case 'fn':
        return {
          kind: 'closure',
          fn: node,
          params: fnParamsOf(node[shape.mainRaw]),
          body: node[shape.aux.get('body')!],
          senv,
        };
      case 'if':
        return altOf([
          this.track(node[shape.aux.get('then')!], senv),
          this.track(node[shape.aux.get('else')!], senv),
        ]);
      default:
        return undefined;
    }
  }

  /**
   * 追跡木の値を引数 argument で呼んだときの解析結果。
   * row は作用集合（undefined は追跡不能）、out は返り値の追跡木
   * （部分適用が返す閉包をここで追うことで、後続の適用の本体を算入できる）。
   * 各 $fn 本体の走査はここだけが行う（effects() は $fn を素通りする）。
   */
  private call(t: Track | undefined, argument: Track | undefined): CallResult {
    if (t === undefined) return UNTRACKED_CALL;
    switch (t.kind) {
      case 'struct':
        // マッピングやリストは呼べない。呼べば実行時のエラーだが、推論は行を作らない。
        return UNTRACKED_CALL;
      case 'alt': {
        const rows: ReadonlySet<string>[] = [];
        const outs: (Track | undefined)[] = [];
        let tracked = true;
        for (const a of t.alts) {
          const r = this.call(a, argument);
          if (r.row === undefined) tracked = false;
          else rows.push(r.row);
          outs.push(r.out);
        }
        return { row: tracked ? union(...rows) : undefined, out: altOf(outs) };
      }
      case 'closure':
        return this.applyClosure(t, argument === undefined || !hasFunction(argument) ? undefined : argument);
    }
  }

  /**
   * 閉包の本体を、引数の追跡木をパラメータに束縛して解析する。
   * パラメータが 2 個以上残っていれば部分適用であり、本体は走らないので作用は無く、
   * 引数を束縛した残りの閉包が結果になる（$fn の列のカリー化展開に一致する）。
   * メモの鍵は（閉包の正準 ID、引数の正準 ID）。閉包の正準形は $fn ノードと残り個数と、
   * 捕まえた環境のうち本体が読みうる束縛なので、同じ $fn でも環境が違えば別の鍵になる。
   * 進行中の $fn ノードへ再入したら自己適用なので追跡不能に倒す。
   * これで解析の停止性は $fn ノードの個数で押さえられる。
   */
  private applyClosure(t: Track & { kind: 'closure' }, argument: Track | undefined): CallResult {
    if (t.params.length > 1) {
      return {
        row: new Set(),
        out: {
          kind: 'closure',
          fn: t.fn,
          params: t.params.slice(1),
          body: t.body,
          senv: insert(t.senv, t.params[0]!, argument),
        },
      };
    }
    const key = `${this.canon(t)},${this.canon(argument)}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    if (this.inProgress.has(t.fn)) return UNTRACKED_CALL;
    this.inProgress.add(t.fn);
    try {
      const senv = insert(t.senv, t.params[0]!, argument);
      const result: CallResult = { row: this.effects(t.body, senv), out: this.track(t.body, senv) };
      // ponytail: 循環ガードが働いた内側の結果もそのままメモに残る（作用を数え落とす向き＝
      // 追跡不能と同じ扱いなので健全性は崩れない）。気になるならガード発火を数えて弾く。
      this.memo.set(key, result);
      return result;
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
 * 既定のパラメータハンドラが「渡されていない」を伝える番兵。
 * 同一性でだけ判定し、文書からは作れない。
 *
 * 未渡しを std.fail に翻訳するのは既定ハンドラではなく呼び出し位置である。
 * 既定ハンドラは境界にあるので、そこで失敗を起こしても呼び出し位置を包む
 * $handle（$default の展開）はもう戻ってしまっている。仕様が「$default が
 * なければ std.fail が境界まで伝播する」と言うとおり、失敗は呼び出し位置で生じる。
 */
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
      this.handleLog(handleState(collectChoice(this.data(node, env, true)), empty)),
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
        `Wrap the call in an explicit handler ($std.list:, $std.first: or $std.mapping:) to declare the shape ` +
        `instead of relying on static tracking; the choice is then handled there. ` +
        `Boundary node: ${where}`,
    );
  }

  private handleLog(comp: Comp): Comp {
    return handleOps(
      comp,
      new Map<string, Clause>([
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
      new Map<string, Clause>([
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

  /**
   * `{$std.param: 名前}` の呼び出し位置。未渡しならその場で std.fail を起こす。
   * `$default` があるときは、その std.fail を捕まえて `$default` の式を返す $handle で包む
   * （仕様が定める展開そのもの）。節が $resume を呼ばないので、失敗した時点で
   * ハンドラ全体の値が `$default` の値になり、渡されていれば `$default` は評価されない。
   */
  private param(name: string, defaultNode: unknown, hasDefault: boolean, env: Env): Comp {
    const read = bind(perform('std.param', name), (v) =>
      v === ABSENT ? perform('std.fail', `parameter not provided: ${name}`) : pure(v),
    );
    if (!hasDefault) return read;
    return handleOps(
      read,
      new Map<string, Clause>([['std.fail', () => this.node(defaultNode, env)]]),
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
    if (typeof node === 'string') {
      // 欠落したキーと添字は失敗作用（捕捉できる）。束縛の未定義や非コンテナの走査、
      // 型の不一致は文書の形の誤りなので、そのままエラーとして投げ抜ける。
      try {
        return pure(interpolate(node, env));
      } catch (e) {
        if (e instanceof MissingPathError) return perform('std.fail', e.message);
        throw e;
      }
    }
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
        // 先頭区画はレキシカルな束縛の解決、残りの区画は値のマッピングのキーアクセス。
        // エラーの語彙は式の参照 ${a.self}（expr.ts の evalNode の case 'ref'）に揃える。
        const [head, ...rest] = shape.name.split('.');
        let cur = lookupEnv(env, head!);
        if (cur === undefined) throw new EffectfulYamlError(`undefined reference: ${head}`);
        for (const seg of rest) {
          if (!isValueMap(cur)) {
            throw new EffectfulYamlError(`cannot access key '.${seg}' of a non-mapping value`);
          }
          if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
            throw new EffectfulYamlError(`missing key '${seg}'`);
          }
          cur = cur[seg]!;
        }
        const f = cur;
        return bind(this.node(node[shape.raw], env), (arg) => this.apply(f, arg, shape.name));
      }
      case 'op':
        return this.operation(shape, node, env);
      case 'reserved':
        return this.reserved(shape, node, env);
    }
  }

  /**
   * 演算の呼び出し。標準演算もホスト登録の演算も同じ経路（引数を評価してから perform）を通る。
   * std の派生ハンドラだけは本体を内側に持つ形なので、それぞれの展開に相当する処理を行う。
   */
  private operation(
    shape: Extract<MappingShape, { kind: 'op' }>,
    node: NodeMap,
    env: Env,
  ): Comp {
    const arg = node[shape.raw];
    const aux = (name: string): unknown => {
      const raw = shape.aux.get(name);
      return raw === undefined ? undefined : node[raw];
    };
    switch (shape.name) {
      case 'std.list':
        return collectChoice(this.node(arg, env));
      case 'std.mapping':
        return bind(collectChoice(this.node(arg, env)), (l) => pure(toMapping(asList(l))));
      case 'std.first':
        return bind(collectFirst(this.node(arg, env)), (r) =>
          asList(r).length > 0
            ? pure(asList(r)[0]!)
            : perform('std.fail', 'every branch of $std.first failed or was cut'),
        );
      case 'std.opt':
        // $default の展開（std.fail の節が $default の式を返す）。$default が無ければ
        // aux('default') は undefined で、node() が pure(null) にするので従来の null になる。
        return handleOps(
          this.node(arg, env),
          new Map([['std.fail', () => this.node(aux('default'), env)]]),
        );
      case 'std.state':
        if (!shape.aux.has('in')) {
          throw new EffectfulYamlError(
            '$std.state without $in is only allowed as a statement of $do',
          );
        }
        return bind(this.node(arg, env), (cells) =>
          handleState(this.node(aux('in'), env), cellsOf(cells)),
        );
      case 'std.param':
        return bind(this.node(arg, env), (name) =>
          this.param(
            requireString(name, '$std.param name'),
            aux('default'),
            shape.aux.has('default'),
            env,
          ),
        );
      case 'std.where':
        // 導出形 {$if: 条件, $then: null, $else: {$std.each: []}} と等価。
        // std.where という演算は存在せず、打ち切りは空の std.each として選択のハンドラに届く。
        return bind(this.node(arg, env), (b) =>
          requireBoolean(b, '$std.where') ? pure(null) : perform('std.each', []),
        );
      case 'std.lookup':
        return bind(this.node(arg, env), lookupComp);
      case 'std.merge':
        return bind(this.node(arg, env), mergeComp);
      default:
        // 演算の引数は値渡しだが合成である。引数の評価で起きた作用は堰き止めない。
        return bind(this.node(arg, env), (v) => perform(shape.name, v));
    }
  }

  /** 関数値（閉包）の適用。引数も本体も合成である。 */
  private apply(f: Value, arg: Value, what: string): Comp {
    if (isClosure(f)) return this.enter(f, extendEnv(f.env, f.params[0]!, arg));
    throw new EffectfulYamlError(`${what} is not a function: ${describe(f)}`);
  }

  /**
   * 先頭パラメータを束縛し終えた閉包に入る。パラメータが 2 個以上残っていれば
   * 部分適用であり、本体は走らせず残りを待つ閉包を返す（$fn の列のカリー化展開と等価）。
   */
  private enter(f: Closure, inner: Env): Comp {
    return f.params.length > 1 ? pure(new Closure(f.params.slice(1), f.body, inner)) : this.node(f.body, inner);
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
      case 'let': {
        // 逐次のカーネル構文。右辺を文書順に評価して束縛し、$in の本体を評価する。
        if (!shape.aux.has('in')) {
          throw new EffectfulYamlError('$let without $in is only allowed as a statement of $do');
        }
        if (!isNodeMap(arg)) throw new EffectfulYamlError('$let requires a mapping of bindings');
        return this.letBind(Object.entries(arg), 0, env, (inner) => this.node(aux('in'), inner));
      }
      case 'if':
        return bind(this.node(arg, env), (cond) =>
          this.node(requireBoolean(cond, '$if condition') ? aux('then') : aux('else'), env),
        );
      case 'fn':
        return pure(new Closure(fnParamsOf(arg), aux('body'), env));
      case 'collect':
        return this.collect(arg, aux('with'), intoOf(aux('into')), env);
      case 'handle':
        return this.handle(arg, aux('with'), env);
      case 'with':
        throw new EffectfulYamlError('$with without $handle is only allowed as a statement of $do');
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

  /**
   * 畳み込みのカーネル構文 $collect。構造を文書順に回り、要素ごとの結果（リスト）を一つに組み立てる。
   * 対象も関数本体も合成なので、そこで起きた作用は周囲へ合流する。
   * $collect 自身は作用を起こさないので、ハンドラで捕捉されることはない。
   */
  private collect(
    target: unknown,
    withNode: unknown,
    into: 'list' | 'mapping',
    env: Env,
  ): Comp {
    return bind(this.node(target, env), (structure) =>
      bind(this.node(withNode, env), (f) => {
        const items = entriesOf(structure, '$collect');
        const go = (i: number, chunks: Cons<readonly Value[]> | null): Comp => {
          if (i >= items.length) {
            const flat = flattenChunks(chunks);
            return pure(into === 'mapping' ? toMapping(flat) : flat);
          }
          return bind(this.apply(f, items[i]!, '$collect $with'), (r) => {
            if (!Array.isArray(r)) {
              throw new EffectfulYamlError(
                `$collect requires the $with function to return a list, got: ${describe(r)}`,
              );
            }
            return go(i + 1, { head: r, tail: chunks });
          });
        };
        return go(0, null);
      }),
    );
  }

  /**
   * $do の文の並び。文形（$let / $in なしの $std.state / 単独の $with）は残りの文を本体に取る
   * ので、展開のとおり「残りの文の計算」を作ってから包む。先の文ほど外側のハンドラになり、
   * 束縛・初期値・節はその文の位置の環境で評価される。
   */
  private statements(stmts: readonly unknown[], i: number, env: Env): Comp {
    if (i >= stmts.length) return pure(null);
    const stmt = stmts[i];
    const rest = (): Comp => this.statements(stmts, i + 1, env);
    const form = statementFormOf(stmt);
    if (form !== undefined) {
      switch (form.kind) {
        case 'let':
          return this.letBind(letEntriesOf(form.bindings), 0, env, (next) =>
            this.statements(stmts, i + 1, next),
          );
        case 'state':
          // 初期値の作用はこのハンドラの外側へ合流する（完結形の case 'std.state' と同じ）。
          return bind(this.node(form.init, env), (cells) => handleState(rest(), cellsOf(cells)));
        case 'with': {
          const { clauses, ret } = this.clausesOf(form.clauses, env);
          return handleOps(rest(), clauses, ret);
        }
      }
    }
    const comp = this.node(stmt, env);
    return i + 1 >= stmts.length ? comp : bind(comp, () => rest());
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
    const { clauses, ret } = this.clausesOf(withNode, env);
    // 節の本体が起こす作用はこのハンドラ自身では捕まらない（handleOps は継続だけを包み直す）。
    return handleOps(this.node(body, env), clauses, ret);
  }

  /**
   * $with のノードから部分処理の節表と return を組む（$handle と $do の $with 文で共通）。
   * 節は $with の位置の環境で閉包になる。
   */
  private clausesOf(
    withNode: unknown,
    env: Env,
  ): { clauses: ReadonlyMap<string, Clause>; ret: (v: Value) => Comp } {
    if (!isNodeMap(withNode)) throw new EffectfulYamlError('$with requires a mapping of clauses');
    const clauses = new Map<string, Clause>();
    let ret: (v: Value) => Comp = pure;
    for (const [name, clauseNode] of Object.entries(withNode)) {
      if (name !== 'return' && !name.includes('.')) {
        throw new EffectfulYamlError(
          `$handle clause name must be a namespaced operation name or 'return', got: ${name}`,
        );
      }
      const closure = this.closureOf(clauseNode, env, name);
      if (name === 'return') {
        ret = (v) => this.enter(closure, extendEnv(closure.env, closure.params[0]!, v));
        continue;
      }
      clauses.set(name, (arg, resume) => {
        // 節の本体でだけ resume が見える（外側の resume は入れ替わる）。
        // 本体の中で作られた閉包も env ごと resume を捕まえるので、そこからも再開できる。
        const inner: Env = { vars: insert(closure.env.vars, closure.params[0]!, arg), resume };
        return this.enter(closure, inner);
      });
    }
    return { clauses, ret };
  }

  private closureOf(node: unknown, env: Env, name: string): Closure {
    const comp = force(this.node(node, env));
    if (comp.tag !== 'pure' || !isClosure(comp.value)) {
      throw new EffectfulYamlError(`$with clause '${name}' must be a function ($fn)`);
    }
    return comp.value;
  }
}

/**
 * $do の「文形」。残りの文を本体に取る形であり、展開はそれぞれ
 *   {$let: 束縛, $in: {$do: 残り}} / {$std.state: 初期値, $in: {$do: 残り}} /
 *   {$handle: {$do: 残り}, $with: 節}
 * である。文形でない文（値を捨てるだけの文）は undefined。
 * `$in` を伴う $let と $std.state は完結した式なので文形ではない。
 * 解析（Analyzer.doEffects）と評価（Evaluator.statements）が同じ分類を使う。
 */
type StatementForm =
  | { readonly kind: 'let'; readonly bindings: unknown }
  | { readonly kind: 'state'; readonly init: unknown }
  | { readonly kind: 'with'; readonly clauses: unknown };

function statementFormOf(stmt: unknown): StatementForm | undefined {
  if (!isNodeMap(stmt)) return undefined;
  const shape = analyzeMapping(Object.keys(stmt));
  if (shape.kind === 'op') {
    if (shape.name !== 'std.state' || shape.aux.has('in')) return undefined;
    return { kind: 'state', init: stmt[shape.raw] };
  }
  if (shape.kind !== 'reserved') return undefined;
  if (shape.main === 'with') return { kind: 'with', clauses: stmt[shape.mainRaw] };
  if (shape.main !== 'let' || shape.aux.has('in')) return undefined;
  return { kind: 'let', bindings: stmt[shape.mainRaw] };
}

/** 束縛のマッピングを文書順の並びにする。形の誤りはエラー（評価器だけが呼ぶ）。 */
function letEntriesOf(bindings: unknown): (readonly [string, unknown])[] {
  if (!isNodeMap(bindings)) throw new EffectfulYamlError('$let requires a mapping of bindings');
  return Object.entries(bindings);
}

/** $std.state の初期値からセルの記憶を作る（完結形と文形で共通）。 */
function cellsOf(cells: Value): PMap<Value> {
  if (!isValueMap(cells)) {
    throw new EffectfulYamlError(`$std.state requires a mapping of cells, got: ${describe(cells)}`);
  }
  let init: PMap<Value> = empty;
  for (const [cell, v] of Object.entries(cells)) init = insert(init, cell, v);
  return init;
}

/** $into の値。書かれていなければ list。式ではなくキーワードなので生のノードを見る。 */
function intoOf(node: unknown): 'list' | 'mapping' {
  if (node === undefined) return 'list';
  if (node === 'list' || node === 'mapping') return node;
  throw new EffectfulYamlError(`$into must be 'list' or 'mapping', got: ${JSON.stringify(node)}`);
}

/**
 * エントリの列をマッピングにする（$collect の $into: mapping の契約）。
 * $std.mapping はこの上の導出なので、集めた分岐にも同じ検査が効く。
 * 契約違反はデータの変動ではなく文書の形の誤りなので、失敗作用ではなくエラーにする。
 */
function toMapping(entries: readonly Value[]): Value {
  const out: ValueMap = {};
  for (const b of entries) {
    if (!isValueMap(b)) {
      throw new EffectfulYamlError(`$collect entry must be a {key, value} mapping, got: ${describe(b)}`);
    }
    const keys = Object.keys(b);
    if (keys.length !== 2 || !('key' in b) || !('value' in b)) {
      throw new EffectfulYamlError(
        `$collect entry must have exactly the keys 'key' and 'value', got: ${keys.join(', ')}`,
      );
    }
    const key = b['key']!;
    if (typeof key !== 'string') {
      throw new EffectfulYamlError(`$collect key must be a string, got: ${describe(key)}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new EffectfulYamlError(`duplicate key in $collect: ${key}`);
    }
    setOwn(out, key, b['value']!);
  }
  return out;
}

/** 関数値が文書の値に残ることはエラー。閉包に加え、ホストが param/op で注入した生の関数も拒む。 */
function assertNoFunctionValue(v: Value): void {
  if (isClosure(v) || typeof v === 'function') {
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
 * 境界の既定ハンドラを通り抜けて残るのは、失敗と、第一階の標準演算とホスト登録の演算だけである。
 * 失敗は文書全体のエラーにし、演算はその実装へ渡す（ホスト関数は非同期でよい）。
 */
async function drive(
  comp: Comp,
  ops: Record<string, (arg: Value) => Value | Promise<Value>>,
): Promise<Value> {
  let c = force(comp);
  for (;;) {
    if (c.tag === 'pure') return c.value;
    if (c.name === 'std.fail') throw new EffectfulYamlError(`failure: ${describe(c.arg)}`);
    const host = ops[c.name] ?? BUILTIN_OPS[c.name];
    if (host === undefined) throw new EffectfulYamlError(`unregistered operation: $${c.name}`);
    let out: Value;
    try {
      out = await host(c.arg);
    } catch (e) {
      if (e instanceof OperationFailure) {
        // 通知された失敗を呼び出し位置の std.fail に翻訳する。内側のハンドラが捕捉できる。
        c = force(c.raise(e.value));
        continue;
      }
      throw e;
    }
    c = force(c.resume(out));
  }
}

/** 文書を評価する。文書全体が一つの作用境界である。 */
export async function evaluate(doc: unknown, options: EvaluateOptions = {}): Promise<Value> {
  const ops = options.ops ?? {};

  // std. 名前空間は標準演算のためにあり、ホストは登録できない。
  for (const name of Object.keys(ops)) {
    if (name.startsWith('std.')) {
      throw new EffectfulYamlError(`host cannot register an operation in the std namespace: $${name}`);
    }
  }

  const analyzer = new Analyzer();

  // 作用シグネチャ。既定ハンドラが処理しない = 実装が要る演算だけが残る。
  for (const name of analyzer.boundary(doc, empty)) {
    if (!(name in ops) && !(name in BUILTIN_OPS)) {
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
