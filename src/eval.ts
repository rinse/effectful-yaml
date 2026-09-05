/**
 * 評価器。
 * 仕様: docs/grammar.md（草案 0.8）「評価モデル」節、とりわけ「作用境界」「合成と境界」。
 *
 * Comp（freer モナド風の計算表現）を組み立てる。
 * ハンドラは Comp → Comp の純粋変換なので、$handle の節は $resume を何度でも呼べる。
 *
 * 作用境界は、文書全体と、データの中に現れた最も外側の `$` 式だけである。
 * 境界の内側には、明示のハンドラ（$handle と std の派生ハンドラ）を除いて
 * 作用を堰き止める場所はない。データ構成（リストの要素、`$` キーを持たないマッピングの値）も、
 * 演算の引数も、呼び出しの引数と本体も、$collect の対象と関数本体も、
 * すべて合成であり、作用はそのまま周囲へ合流する。
 *
 * 評価の三態。
 *   - data:     まだどの `$` 式にも入っていないデータ位置。`$` 式に出会ったらそこが境界。
 *   - boundary: 境界。中身を評価し、既定ハンドラ一式で処理し尽くす。
 *   - node:     合成位置（`$` 式の内側）。子も一律に合成。
 */
import { interpolate, MissingPathError } from './expr.js';
import {
  classifyClauseName,
  fnParamsOf,
  localDeclsOf,
  mappingShapeOfNode,
  statementFormOf,
  unescapeDollar,
  unhandledOpMessage,
  type MappingShape,
} from './forms.js';
import { typecheck } from './typecheck.js';
import { empty, get, insert, type PMap } from './pmap.js';
import {
  atPath,
  attachPath,
  bind,
  BUILTIN_OPS,
  Closure,
  describe,
  EffectfulYamlError,
  emptyEnv,
  extendEnv,
  force,
  isClosure,
  lookupEnv,
  OperationFailure,
  perform,
  pure,
  resumeOf,
  type Comp,
  type Env,
  type Value,
} from './types.js';

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

type NodeMap = Record<string, unknown>;
type ValueMap = { [key: string]: Value };

// ---------------------------------------------------------------------------
// 失敗位置
//
// 位置は「入力文書の中のデータの位置」であり、キーを `.` で、リストの添字を `[2]` で連ねる
// （キーの `.` はエスケープしない）。データを降りるときだけ伸び、`$` 式の内側では凍る。
// したがって報告される位置は、失敗を含む最も外側の `$` 式の位置になる。
//
// Comp は遅延して組み立てられ、bind の継続はドライバのスタックで走るので、
// 呼び出しを try/catch で囲んでも継続の中で起きたエラーは捕まらない（位置ともずれる）。
// そこで位置は二つの経路で運ぶ。
//   - Env.path: 評価器の中で投げられるエラー用。継続はこれをレキシカルに捕まえる。
//   - op の path: 境界を抜けてドライバに届く失敗とホスト演算のエラー用。
// ---------------------------------------------------------------------------

/** 位置をキー一つぶん降りる。添字は `${path}[${i}]` でよいので専用の関数は要らない。 */
const keyPath = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** f の中で投げられたエラーに失敗位置を添える。位置を捕まえた関数の中でだけ意味を持つ。 */
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

const isNodeMap = (n: unknown): n is NodeMap =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

const isValueMap = (v: Value): v is ValueMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isClosure(v);

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

/** 構造を回る形（$std.each の分岐、$collect の対象）。マッピングは {key, value} に分解する。 */
function entriesOf(arg: Value, what: string): Value[] {
  if (Array.isArray(arg)) return arg;
  if (isValueMap(arg)) return Object.entries(arg).map(([key, value]) => ({ key, value }));
  throw new EffectfulYamlError(`${what} requires a list or mapping, got: ${describe(arg)}`);
}

/**
 * $std.lookup の意味（展開と等価な O(1) の照会）。無いキーは呼び出し位置の std.fail。
 * in がマッピングでない・key が文字列でないのは形の誤りなのでエラー。
 */
function lookupComp(arg: Value, path: string): Comp {
  if (!isValueMap(arg)) {
    throw new EffectfulYamlError(`$std.lookup requires a mapping {in, key}, got: ${describe(arg)}`);
  }
  const m = arg['in'];
  const k = requireString(arg['key'], '$std.lookup key');
  if (m === undefined || !isValueMap(m)) {
    throw new EffectfulYamlError(`$std.lookup 'in' must be a mapping, got: ${describe(m ?? null)}`);
  }
  return Object.prototype.hasOwnProperty.call(m, k)
    ? pure(m[k]!)
    : perform('std.fail', `missing key '${k}'`, path);
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
    return { tag: 'op', name: c.name, arg: c.arg, resume: next, raise: nextRaise, path: c.path };
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
 * 重複キーは「最初の出現位置に、最後の値」になる。
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
            // 失敗位置は読み出しを起こした $std.get の位置である。
            path: m.path,
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
      };
    }
  };
  return rec(comp, init);
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
    private readonly params: Record<string, Value>,
    private readonly onLog: (v: Value) => void,
  ) {}

  /**
   * 作用境界（文書全体、およびデータの中に現れた最も外側の `$` 式）。
   * 残る作用を既定ハンドラ一式（失敗・パラメータ・ログ・状態）で処理し尽くす。
   * 選択と失敗と登録演算だけは外（トップレベルのドライバ）へ委ねる。
   * 選択を処理するのは明示のハンドラだけなので、境界に達した選択はドライバのエラーになる。
   */
  boundary(node: unknown, env: Env): Comp {
    return this.handleParam(this.handleLog(handleState(this.data(node, env, true), empty)));
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
    const read = bind(perform('std.param', name, env.path), (v) =>
      v === ABSENT ? perform('std.fail', `parameter not provided: ${name}`, env.path) : pure(v),
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
   * 失敗位置が伸びるのはここだけである（子のデータ位置ごとに Env の path を差し替える）。
   */
  private data(node: unknown, env: Env, here = false): Comp {
    return at(env.path, () => {
      const composed = this.compose(node, env, (n, path) => this.data(n, atPath(env, path)));
      if (composed !== undefined) return composed;
      return here ? this.dollar(node as NodeMap, env) : this.boundary(node, env);
    });
  }

  /** 合成位置の評価（`$` 式の内側）。子も一律に合成。失敗位置は `$` 式の位置のまま凍る。 */
  node(node: unknown, env: Env): Comp {
    return at(
      env.path,
      () => this.compose(node, env, (n) => this.node(n, env)) ?? this.dollar(node as NodeMap, env),
    );
  }

  /**
   * データ構成（スカラー・リスト・プレーンマッピング）を rec で組み立てる。`$` 式なら undefined。
   * データ構成は作用を起こさないが、遮りもしない（bind でつなぐだけ）。
   * rec には子の失敗位置も渡す（データ位置の rec だけが使い、合成位置の rec は捨てる）。
   */
  private compose(
    node: unknown,
    env: Env,
    rec: (n: unknown, path: string) => Comp,
  ): Comp | undefined {
    if (typeof node === 'string') {
      // 欠落したキーと添字は失敗作用（捕捉できる）。束縛の未定義や非コンテナの走査、
      // 型の不一致は文書の形の誤りなので、そのままエラーとして投げ抜ける。
      try {
        return pure(interpolate(node, env));
      } catch (e) {
        if (e instanceof MissingPathError) return perform('std.fail', e.message, env.path);
        throw e;
      }
    }
    if (node === null || node === undefined) return pure(null);
    if (typeof node === 'number' || typeof node === 'boolean') return pure(node);
    if (Array.isArray(node)) {
      const go = (i: number, acc: Cons<Value> | null): Comp =>
        i >= node.length
          ? pure(toDocumentOrder(acc))
          : bind(rec(node[i], `${env.path}[${i}]`), (v) => go(i + 1, { head: v, tail: acc }));
      return go(0, null);
    }
    if (!isNodeMap(node)) {
      throw new EffectfulYamlError(`unsupported node: ${String(node)}`);
    }
    if (mappingShapeOfNode(node).kind !== 'plain') return undefined;
    // キーは $$ を literal な $ に解決するだけ（計算されたキーは $mapping で書く）。
    const entries = Object.entries(node);
    const go = (i: number, acc: Cons<readonly [string, Value]> | null): Comp => {
      if (i >= entries.length) return pure(materializeMap(acc));
      const [rawKey, valueNode] = entries[i]!;
      return bind(rec(valueNode, keyPath(env.path, rawKey)), (v) =>
        go(i + 1, { head: [unescapeDollar(rawKey), v], tail: acc }),
      );
    };
    return go(0, null);
  }

  private dollar(node: NodeMap, env: Env): Comp {
    const shape = mappingShapeOfNode(node);
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
        return bindAt(env.path, this.node(node[shape.raw], env), (arg) =>
          this.apply(f, arg, shape.name),
        );
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
        return bindAt(env.path, collectChoice(this.node(arg, env)), (l) =>
          pure(toMapping(asList(l))),
        );
      case 'std.first':
        return bind(collectFirst(this.node(arg, env)), (r) =>
          asList(r).length > 0
            ? pure(asList(r)[0]!)
            : perform('std.fail', 'every branch of $std.first failed or was cut', env.path),
        );
      case 'std.opt':
        // $default の展開（std.fail の節が $default の式を返す）。$default が無ければ
        // aux('default') は undefined で、node() が pure(null) にするので null になる。
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
        return bindAt(env.path, this.node(arg, env), (cells) =>
          handleState(this.node(aux('in'), env), cellsOf(cells)),
        );
      case 'std.param':
        return bindAt(env.path, this.node(arg, env), (name) =>
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
        return bindAt(env.path, this.node(arg, env), (b) =>
          requireBoolean(b, '$std.where') ? pure(null) : perform('std.each', [], env.path),
        );
      case 'std.lookup':
        return bindAt(env.path, this.node(arg, env), (v) => lookupComp(v, env.path));
      case 'std.merge':
        return bindAt(env.path, this.node(arg, env), mergeComp);
      default:
        // 演算の引数は値渡しだが合成である。引数の評価で起きた作用は堰き止めない。
        return bind(this.node(arg, env), (v) => perform(shape.name, v, env.path));
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
        return bindAt(env.path, this.node(arg, env), (cond) =>
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
    return bindAt(env.path, this.node(target, env), (structure) =>
      bindAt(env.path, this.node(withNode, env), (f) => {
        const items = entriesOf(structure, '$collect');
        const go = (i: number, chunks: Cons<readonly Value[]> | null): Comp => {
          if (i >= items.length) {
            const flat = flattenChunks(chunks);
            return pure(into === 'mapping' ? toMapping(flat) : flat);
          }
          return bindAt(env.path, this.apply(f, items[i]!, '$collect $with'), (r) => {
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
          return bindAt(env.path, this.node(form.init, env), (cells) =>
            handleState(rest(), cellsOf(cells)),
          );
        case 'with': {
          // ローカル作用の宣言は残りの文（＝本体）から見える（$let 文と同じスコープ規則）。
          const { clauses, ret, inner } = this.clausesOf(form.clauses, env);
          return handleOps(this.statements(stmts, i + 1, inner), clauses, ret);
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
    return bindAt(env.path, this.node(rhs, env), (v) =>
      this.letBind(entries, i + 1, extendEnv(env, name, v), k),
    );
  }

  private handle(body: unknown, withNode: unknown, env: Env): Comp {
    const { clauses, ret, inner } = this.clausesOf(withNode, env);
    // 節の本体が起こす作用はこのハンドラ自身では捕まらない（handleOps は継続だけを包み直す）。
    return handleOps(this.node(body, inner), clauses, ret);
  }

  /**
   * $with のノードから部分処理の節表と return を組む（$handle と $do の $with 文で共通）。
   * 節は $with の位置の環境で閉包になる。
   * inner は本体を評価する環境で、ローカル作用の宣言（素通しの閉包）だけが足されている
   * （展開の `$let` は $handle の外側にあるので、節と return 節からは見えない）。
   */
  private clausesOf(
    withNode: unknown,
    env: Env,
  ): { clauses: ReadonlyMap<string, Clause>; ret: (v: Value) => Comp; inner: Env } {
    if (!isNodeMap(withNode)) throw new EffectfulYamlError('$with requires a mapping of clauses');
    const locals = localDeclsOf(withNode);
    const clauses = new Map<string, Clause>();
    let ret: (v: Value) => Comp = pure;
    for (const [name, clauseNode] of Object.entries(withNode)) {
      const kind = classifyClauseName(name);
      const closure = this.closureOf(clauseNode, env, name);
      if (kind === 'return') {
        ret = (v) => this.enter(closure, extendEnv(closure.env, closure.params[0]!, v));
        continue;
      }
      // ローカル作用の節にマッチするのは、素通しの閉包が起こす内部演算である。
      clauses.set(kind === 'local' ? locals.get(name)!.opName : name, (arg, resume) => {
        // 節の本体でだけ resume が見える（外側の resume は入れ替わる）。
        // 本体の中で作られた閉包も env ごと resume を捕まえるので、そこからも再開できる。
        const clauseEnv: Env = {
          vars: insert(closure.env.vars, closure.params[0]!, arg),
          resume,
          path: closure.env.path,
        };
        return this.enter(closure, clauseEnv);
      });
    }
    let inner = env;
    for (const [name, decl] of locals) {
      inner = extendEnv(inner, name, new Closure(decl.params, decl.body, env));
    }
    return { clauses, ret, inner };
  }

  private closureOf(node: unknown, env: Env, name: string): Closure {
    const comp = force(this.node(node, env));
    if (comp.tag !== 'pure' || !isClosure(comp.value)) {
      throw new EffectfulYamlError(`$with clause '${name}' must be a function ($fn)`);
    }
    return comp.value;
  }
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

/** 値の中に関数値（閉包・生関数）が含まれるか。ホスト演算へ渡る直前の引数の検査に使う。 */
function containsFunctionValue(v: Value): boolean {
  if (isClosure(v) || typeof v === 'function') return true;
  if (Array.isArray(v)) return v.some(containsFunctionValue);
  if (isValueMap(v)) return Object.values(v).some(containsFunctionValue);
  return false;
}

// ---------------------------------------------------------------------------
// トップレベルのドライバ
// ---------------------------------------------------------------------------

/**
 * 境界の既定ハンドラを通り抜けて残るのは、選択と失敗と、第一階の標準演算とホスト登録の演算である。
 * どのハンドラにも捕まらなかった選択と失敗は文書全体のエラーにし、演算はその実装へ渡す
 * （ホスト関数は非同期でよい）。
 */
async function drive(
  comp: Comp,
  ops: Record<string, (arg: Value) => Value | Promise<Value>>,
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
          'unhandled choice: $std.each reached the boundary without a handler; ' +
            'wrap the computation in $std.list, $std.first or $std.mapping',
        ),
        c.path,
      );
    }
    const fromHost = ops[c.name];
    const host = fromHost ?? BUILTIN_OPS[c.name];
    if (host === undefined) {
      throw attachPath(new EffectfulYamlError(unhandledOpMessage(c.name)), c.path);
    }
    // 閉包はホストへ渡れない（grammar.md ホスト登録の演算）。評価前の流れ検査と二重の砦で、
    // こちらは実際に渡る値を見る正確な検査である。第一階の標準演算（std.range）は対象外。
    if (fromHost !== undefined && containsFunctionValue(c.arg)) {
      throw attachPath(
        new EffectfulYamlError(`a function value cannot be passed to a host operation: $${c.name}`),
        c.path,
      );
    }
    let out: Value;
    try {
      out = await host(c.arg);
    } catch (e) {
      if (e instanceof OperationFailure) {
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

  // std. 名前空間は標準演算のためにあり、ホストは登録できない。
  for (const name of Object.keys(ops)) {
    if (name.startsWith('std.')) {
      throw new EffectfulYamlError(`host cannot register an operation in the std namespace: $${name}`);
    }
  }

  // 評価前の検査（grammar.md「関数値の流れと停止性」「演算」）。自己適用を含みうる文書、
  // ホスト演算の引数に閉包が流れうる文書、実装の無い演算を含む文書を、評価を始める前に拒否する。
  typecheck(doc, ops);

  const evaluator = new Evaluator(
    options.params ?? {},
    options.onLog ?? ((v) => console.error(describe(v))),
  );
  const value = await drive(evaluator.boundary(doc, emptyEnv), ops);
  assertNoFunctionValue(value);
  return value;
}
