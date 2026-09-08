/**
 * YAML ノードからカーネルの AST への脱糖。
 * 仕様: docs/grammar.md（草案 0.11）「予約キーとカーネル」「$do」「引数名の列と部分適用」
 * 「$std.where」「ハンドラ」「std の派生ハンドラ」。
 *
 * 仕様は導出形を「カーネルへの展開」で定めるので、展開はここで一度だけ行う。
 * 評価前の検査（typecheck.ts）も評価器（eval.ts）も、この AST だけを歩く。
 *
 * ノードは二種類の位置を持つ。
 *   - path:  失敗位置。出力の値の中でのその値の場所であり、式の値がそのまま出力の値に
 *            なる経路（データのキーと添字、`$in` の本体、`$do` の最後の文、`$if` の分岐、
 *            `return` の節を持たない `$with` の本体、`$std.opt` と `$std.param` の
 *            `$default`）をたどる間だけ伸びる。
 *   - spath: 構文パス。`$` 式の内側へも降りる。関数値の流れの検査のエラー位置と、
 *            ローカル作用の内部演算名に使う。必要とするノード（`$fn`）だけが持つ。
 *
 * 形の誤り（主キーの重複、補助キーの過不足、予約されていない `$` キー、節名の形など）は
 * ここで報告する。ただし「$do の文の位置でだけ書ける形」を位置の外で見つけたときだけは、
 * その場で投げずに Err ノードを置く。検査が初期値や節まで走査してから、
 * 評価がその位置に達したときに初めて拒む、という順序にするためである。
 */
import { EffectfulYamlError, type Value } from './types.js';

// ---------------------------------------------------------------------------
// カーネルの AST
// ---------------------------------------------------------------------------

/** `$let` の束縛。name が null なら値を捨てる文（文書から参照できない私的名）。 */
export interface Binding {
  readonly name: string | null;
  readonly rhs: KNode;
}

/** `$with` の節。op は演算名（ローカル作用なら内部名 `名前@構文パス`）。 */
export interface Clause {
  readonly op: string;
  readonly fn: KNode;
}

export type KNode =
  /** null・真偽値・数値、および展開が置く定数（空の `$std.each` の引数など）。 */
  | { readonly k: 'lit'; readonly path: string; readonly value: Value }
  /** スカラー。補間は評価時に解決するので生の文字列のまま持つ。 */
  | { readonly k: 'str'; readonly path: string; readonly raw: string }
  | { readonly k: 'list'; readonly path: string; readonly items: readonly KNode[] }
  /** プレーンなマッピング。キーは `$$` を解決済み。 */
  | {
      readonly k: 'map';
      readonly path: string;
      readonly entries: readonly (readonly [string, KNode])[];
    }
  /** 逐次の原始。`$let`（`$in`）と `$do` の展開先。 */
  | {
      readonly k: 'let';
      readonly path: string;
      readonly bindings: readonly Binding[];
      readonly body: KNode;
    }
  /** what は条件が真偽値でないときのエラー文言に使う主体の名前。 */
  | {
      readonly k: 'if';
      readonly path: string;
      readonly what: string;
      readonly cond: KNode;
      readonly then: KNode;
      readonly else: KNode;
    }
  | {
      readonly k: 'fn';
      readonly path: string;
      readonly spath: string;
      readonly params: readonly string[];
      readonly body: KNode;
    }
  /** レキシカル呼び出し `$.head.keys...`。 */
  | {
      readonly k: 'call';
      readonly path: string;
      readonly head: string;
      readonly keys: readonly string[];
      readonly arg: KNode;
    }
  | { readonly k: 'op'; readonly path: string; readonly name: string; readonly arg: KNode }
  | {
      readonly k: 'handle';
      readonly path: string;
      readonly body: KNode;
      readonly clauses: readonly Clause[];
      readonly ret?: KNode;
    }
  | {
      readonly k: 'collect';
      readonly path: string;
      readonly target: KNode;
      readonly fn: KNode;
      readonly into: 'list' | 'mapping';
    }
  | { readonly k: 'resume'; readonly path: string; readonly arg: KNode }
  /** `$std.state`。二項形も前置きもこのノードになる。仕様が許す等価な組み込み。 */
  | { readonly k: 'state'; readonly path: string; readonly init: KNode; readonly body: KNode }
  /** `$std.first`。仕様が許す等価な組み込み。 */
  | { readonly k: 'first'; readonly path: string; readonly body: KNode }
  /** `$std.list`。仕様が許す等価な組み込み。 */
  | { readonly k: 'listOf'; readonly path: string; readonly body: KNode }
  /** 作用境界。文書全体と、データの中に現れた最も外側の `$` 式。 */
  | { readonly k: 'boundary'; readonly path: string; readonly body: KNode }
  /**
   * 評価がこの位置に達したら拒む形（`$do` の文の位置でだけ書ける形を位置の外で書いたもの）。
   * children は検査だけが降りる部分木で、評価は決して触れない。
   */
  | {
      readonly k: 'err';
      readonly path: string;
      readonly message: string;
      readonly children: readonly KNode[];
    };

// ---------------------------------------------------------------------------
// `$` キーの分類と、マッピングの形の判定
// ---------------------------------------------------------------------------

/** 予約キー（$ を除く）。仕様の 13 個がすべてであり、演算はここに現れない。 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'do',
  'let',
  'if',
  'then',
  'else',
  'fn',
  'body',
  'with',
  'resume',
  'collect',
  'into',
  'in',
  'default',
]);

/** 補助キー名の集合。主キー候補から除外するために使う。 */
const AUX_KEY_NAMES: ReadonlySet<string> = new Set([
  'then',
  'else',
  'body',
  'with',
  'into',
  'in',
  'default',
]);

/**
 * 主キーごとに許される補助キー。列挙されていない主キーは補助キーを取らない。
 * `$default` は演算 `$std.param` と `$std.opt` が使うので、予約キーだけでなく演算の名前でも
 * 引ける表にする。`$in` は前置きの本体であり、go() が頭キーとともに先に取り分けるので
 * ここには載らない。
 */
const AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  collect: new Set(['with', 'into']),
  'std.param': new Set(['default']),
  'std.opt': new Set(['default']),
};

/** 主キーのうち、必須の補助キー（省略するとエラー）。 */
const REQUIRED_AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  collect: new Set(['with']),
};

/** `IDENT(\.IDENT)*`。レキシカル呼び出し `$.名前` の名前部分（先頭の `.` を除いた残り）。 */
const LEXICAL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 文字列 s が「$ で始まり、$$ エスケープではない」かどうかを判定する。
 * $ 式かどうかの判定は書かれたままのキーに対して行う（補間や $$ の解決より前）。
 */
export function isDollarFormKey(key: string): boolean {
  return key.length >= 1 && key[0] === '$' && key[1] !== '$';
}

/** 値・キーの中の $$ を literal な $ に解決する（$ 式でないと判定された場合に使う）。 */
function unescapeDollar(s: string): string {
  return s.replace(/\$\$/g, '$');
}

type DollarKeyKind =
  | { readonly kind: 'reserved'; readonly main: string }
  | { readonly kind: 'lexical'; readonly name: string }
  | { readonly kind: 'op'; readonly name: string };

/**
 * $ を除いたキー本体を分類する。
 * `.名前` はレキシカルな束縛の呼び出しで、名前はドット区切りの単純な識別子の列
 * （`IDENT(\.IDENT)*`）を許す。先頭区画がレキシカルな束縛、残りはその値のマッピングを
 * たどるキーアクセスである。この形を許してもグローバル名前空間は崩れない。
 * 先頭のドットで登録演算（ドットを含む名前）とも予約キー（ドットを含まない名前）とも
 * 区別がつくため、区画がいくつ続いても衝突しない。
 * また `$let` の束縛名自体にはドットを使えない（束縛と制御の節）ので、
 * 名前の中のドットは常に「束縛名の終わり・キーアクセスの始まり」の区切りとして読める。
 * それ以外（空区画・記号・添字）はエラーにする。添字アクセスは対象外で、
 * 必要なら `$let` で名前を付けてから呼ぶ。
 * ドットを含む名前は登録演算。それ以外は予約キーでなければエラー。
 */
function classifyDollarKey(nameAfterDollar: string): DollarKeyKind {
  if (RESERVED_KEYS.has(nameAfterDollar)) {
    return { kind: 'reserved', main: nameAfterDollar };
  }
  if (nameAfterDollar.startsWith('.')) {
    const name = nameAfterDollar.slice(1);
    if (!LEXICAL_PATH.test(name)) {
      throw new EffectfulYamlError(`invalid lexical call name: $${nameAfterDollar}`);
    }
    // return は $with の節名として予約されている。呼び出しの形で書かれたら形の誤りである
    // （束縛としての `$let: {return: ...}` と `${return}` の参照は合法）。
    if (name.split('.')[0] === 'return') {
      throw new EffectfulYamlError('return is reserved: $.return is not callable');
    }
    return { kind: 'lexical', name };
  }
  if (DOTTED.test(nameAfterDollar)) {
    return { kind: 'op', name: nameAfterDollar };
  }
  // ローカル作用の内部演算名（`名前@構文パス`）はここを通らない。内部名を鋳造するのは
  // 脱糖器だけであり、文書に書かれた同じ字面はここで拒まれる。
  throw new EffectfulYamlError(`unreserved $ key: $${nameAfterDollar}`);
}

/** マッピングノードが表す形。plain はデータとして扱うマッピング。 */
type MappingShape =
  | { readonly kind: 'plain' }
  | {
      readonly kind: 'reserved';
      readonly main: string;
      readonly mainRaw: string;
      /** 補助キー名（$ なし） -> 生キー */
      readonly aux: ReadonlyMap<string, string>;
    }
  | { readonly kind: 'lexical'; readonly name: string; readonly raw: string }
  | {
      readonly kind: 'op';
      readonly name: string;
      readonly raw: string;
      readonly aux: ReadonlyMap<string, string>;
    };

const NO_AUX: ReadonlySet<string> = new Set();

/** エラー文言に使う主キーの表示名。 */
function displayName(k: DollarKeyKind): string {
  if (k.kind === 'lexical') return `$.${k.name}`;
  return `$${k.kind === 'op' ? k.name : k.main}`;
}

/** 前置きの頭キーの生キー三つ。`$` キーは書かれたままの字面で見る（`$$let` は該当しない）。 */
const HEAD_KEYS: ReadonlySet<string> = new Set(['$let', '$std.state', '$with']);

/**
 * マッピングの前置きの頭キー。文書順で最初の頭キーであり、残り（そのキーを除いた全部）が
 * その前置きの本体になる。`$with` が頭キーになるのは、同じマッピングに `$collect` が
 * 無いときだけである（あれば `$collect` の補助キー）。
 */
function headKeyOf(rawKeys: readonly string[]): string | undefined {
  const withIsAux = rawKeys.includes('$collect');
  return rawKeys.find((k) => HEAD_KEYS.has(k) && !(withIsAux && k === '$with'));
}

/**
 * 残りがデータであるブロック形式の前置きを持つマッピングの、頭キーを文書順の配列で返す。
 * 保持レンダラ（src/preserve.ts）が対を取り除く規則の判定であり、脱糖の判定
 * （headKeyOf が頭を一つ取り、残りは何であってもよい）とは別物である。
 * `$` キーがすべて頭キーで、データのキーが一つ以上あるときだけ、頭をすべて取り除いた残りが
 * データのマッピングになる。
 */
export function headKeysWithDataRest(rawKeys: readonly string[]): readonly string[] | undefined {
  const dollarKeys = rawKeys.filter(isDollarFormKey);
  if (dollarKeys.length === 0 || dollarKeys.length === rawKeys.length) return undefined;
  return dollarKeys.every((k) => HEAD_KEYS.has(k)) ? dollarKeys : undefined;
}

/**
 * マッピングの生キー（YAML から読んだままの文字列）の並びから形を決める。
 * 前置きの頭は go() がこれより先に取り分けるので、ここに届くのは主形か、
 * 頭キー一つだけのマッピング（残りが空）である。`$` キーとデータのキーが
 * 混在して届いたときは常にエラーである。
 * - `$` キーが一つも無ければ plain。
 * - `$` キーとデータのキーが混在していればエラー。
 * - `$` キーだけなら、主キーちょうど一つと、その主キーが許す補助キーだけを許す。
 * - 補助キーを許すのは予約キーのほか、`$default` を取る `$std.param` と `$std.opt` だけ。
 *   レキシカル呼び出しは補助キーを取らない。
 */
function analyzeMapping(rawKeys: readonly string[]): MappingShape {
  const dollarKeys = rawKeys.filter(isDollarFormKey);
  const plainKeys = rawKeys.filter((k) => !isDollarFormKey(k));

  if (dollarKeys.length === 0) return { kind: 'plain' };
  if (plainKeys.length > 0) {
    throw new EffectfulYamlError(`$ key mixed with plain keys: ${plainKeys.join(', ')}`);
  }

  const classified = dollarKeys.map((raw) => ({ raw, c: classifyDollarKey(raw.slice(1)) }));

  const mainCandidates = classified.filter(
    ({ c }) => c.kind !== 'reserved' || !AUX_KEY_NAMES.has(c.main),
  );
  const auxCandidates = classified.filter(
    ({ c }) => c.kind === 'reserved' && AUX_KEY_NAMES.has(c.main),
  );

  if (mainCandidates.length === 0) {
    // 単独の `$with` は `$do` の文（残りの文へハンドラを被せる）。文の位置かどうかは
    // ここでは分からないので、位置外は Err ノードで拒む。ほかのキーを伴う `$with` は
    // 前置きの頭か `$collect` の補助キーなので、ここには届かない。
    const only = auxCandidates[0];
    if (auxCandidates.length === 1 && only!.c.kind === 'reserved' && only!.c.main === 'with') {
      return { kind: 'reserved', main: 'with', mainRaw: only!.raw, aux: new Map() };
    }
    const orphan = auxCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`auxiliary $ key without a main key: ${orphan}`);
  }
  if (mainCandidates.length > 1) {
    const names = mainCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`more than one main $ key: ${names}`);
  }

  const mainEntry = mainCandidates[0]!;
  const { raw: mainRaw, c: mainKind } = mainEntry;

  // 補助キーの持ち主は、予約キーならその名前、演算ならドット入りの演算名。
  // レキシカル呼び出しは補助キーを取らない（表に載せない）。
  const owner =
    mainKind.kind === 'reserved' ? mainKind.main : mainKind.kind === 'op' ? mainKind.name : '';
  const allowed = AUX_OF[owner] ?? NO_AUX;
  const aux = new Map<string, string>();
  for (const { raw, c } of auxCandidates) {
    if (c.kind !== 'reserved') continue;
    if (!allowed.has(c.main)) {
      throw new EffectfulYamlError(`${displayName(mainKind)} does not accept $${c.main}`);
    }
    aux.set(c.main, raw);
  }

  const required = REQUIRED_AUX_OF[owner];
  if (required !== undefined) {
    for (const name of required) {
      if (!aux.has(name)) {
        throw new EffectfulYamlError(`${displayName(mainKind)} requires $${name}`);
      }
    }
  }

  if (mainKind.kind === 'lexical') return { kind: 'lexical', name: mainKind.name, raw: mainRaw };
  if (mainKind.kind === 'op') return { kind: 'op', name: mainKind.name, raw: mainRaw, aux };
  return { kind: 'reserved', main: mainKind.main, mainRaw, aux };
}

/** 節名の分類。形の誤りはエラー。 */
function classifyClauseName(name: string): 'return' | 'op' | 'local' {
  if (name === 'return') return 'return';
  if (DOTTED.test(name)) return 'op';
  if (IDENT.test(name)) return 'local';
  throw new EffectfulYamlError(
    `$with clause name must be an operation name, a bare local name, or 'return', got: ${name}`,
  );
}

/**
 * 処理されずに境界へ達した演算の文言。内部演算名（`名前@構文パス`）は識別子に使えない
 * `@` を含むので、字面だけで脱出の文言を選べる。ローカル作用の内部演算がここに現れるのは、
 * 素通しの閉包がハンドラの動的範囲の外で呼ばれたときだけなので、脱出として報告する。
 * 内部名が利用者の目に触れるのはこの経路（事前検査と評価時のドライバ）だけである。
 */
export function unhandledOpMessage(name: string): string {
  const at = name.indexOf('@');
  if (at < 0) return `unregistered operation: $${name}`;
  const where = name.slice(at + 1);
  return `local effect '${name.slice(0, at)}' escaped its handler (declared at ${
    where === '' ? 'the document root' : where
  })`;
}

// ---------------------------------------------------------------------------
// 脱糖
// ---------------------------------------------------------------------------

type NodeMap = Record<string, unknown>;

const isNodeMap = (n: unknown): n is NodeMap =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

/** 位置をキー一つぶん降りる。データ位置と構文パスに共通の綴り方。 */
const childPath = (p: string, key: string): string => (p === '' ? key : `${p}.${key}`);

const lit = (path: string, value: Value): KNode => ({ k: 'lit', path, value });

/** 束縛が空なら本体そのもの（`{$do: [結果]} ≡ 結果` の展開に合わせる）。 */
const mkLet = (path: string, bindings: readonly Binding[], body: KNode): KNode =>
  bindings.length === 0 ? body : { k: 'let', path, bindings, body };

/**
 * 展開が合成する一引数関数。本体が利用者の式である節（`$std.opt` の `std.fail` 節など）では
 * パラメータ名に `@` を含めるので、本体の `${...}` から参照されることはない。
 */
const synthFn = (path: string, spath: string, param: string, body: KNode): KNode => ({
  k: 'fn',
  path,
  spath,
  params: [param],
  body,
});

/** `$fn` のパラメータ。文字列一つ、または相異なる名前の 1 個以上の列（カリー化の導出形）。 */
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

/** $into の値。書かれていなければ list。式ではなくキーワードなので生のノードを見る。 */
function intoOf(node: unknown): 'list' | 'mapping' {
  if (node === undefined) return 'list';
  if (node === 'list' || node === 'mapping') return node;
  throw new EffectfulYamlError(`$into must be 'list' or 'mapping', got: ${JSON.stringify(node)}`);
}

/**
 * `$do` の文に置いた前置き。頭キーだけからなるマッピングであり、残りの文を本体に取る。
 * 残りを持つ前置きは本体をその残りに取るので、文としては完結した式である。
 */
type StatementPrelude =
  | { readonly kind: 'let'; readonly bindings: unknown }
  | { readonly kind: 'state'; readonly init: unknown }
  | { readonly kind: 'with'; readonly clauses: unknown };

function statementPreludeOf(stmt: unknown): StatementPrelude | undefined {
  if (!isNodeMap(stmt)) return undefined;
  const rawKeys = Object.keys(stmt);
  // 残りを持つ前置きは、その残りを本体に取る完結した式である。
  if (rawKeys.length > 1 && headKeyOf(rawKeys) !== undefined) return undefined;
  const shape = analyzeMapping(rawKeys);
  if (shape.kind === 'op') {
    if (shape.name !== 'std.state') return undefined;
    return { kind: 'state', init: stmt[shape.raw] };
  }
  if (shape.kind !== 'reserved') return undefined;
  if (shape.main === 'with') return { kind: 'with', clauses: stmt[shape.mainRaw] };
  if (shape.main !== 'let') return undefined;
  return { kind: 'let', bindings: stmt[shape.mainRaw] };
}

/**
 * ノードを脱糖する。
 * inData が真ならデータ位置であり、そこで出会った `$` 式は作用境界になる。
 * `$` 式の内側は一律に合成位置なので、データ位置は再び現れない。
 * open が真なら、このノードの値はそのまま出力の値になる。データのキーと添字で位置が
 * 伸びるのはこの間だけである（データ位置は必ず素通しなので inData は open を含む）。
 */
function go(node: unknown, path: string, spath: string, inData: boolean, open: boolean): KNode {
  if (typeof node === 'string') return { k: 'str', path, raw: node };
  if (node === null || node === undefined) return lit(path, null);
  if (typeof node === 'number' || typeof node === 'boolean') return lit(path, node);
  if (Array.isArray(node)) {
    return {
      k: 'list',
      path,
      items: node.map((c, i) =>
        go(c, open ? `${path}[${i}]` : path, `${spath}[${i}]`, inData, open),
      ),
    };
  }
  if (!isNodeMap(node)) {
    throw new EffectfulYamlError(`unsupported node: ${String(node)}`);
  }
  const rawKeys = Object.keys(node);
  // 頭キーがあり、残り（そのキーを除いた全部）が空でなければ前置きを持つマッピング。
  const head = rawKeys.length > 1 ? headKeyOf(rawKeys) : undefined;
  if (head !== undefined) {
    const form = prelude(node, head, rawKeys, path, spath, open);
    return inData ? { k: 'boundary', path, body: form } : form;
  }
  const shape = analyzeMapping(rawKeys);
  if (shape.kind === 'plain') {
    // キーは $$ を literal な $ に解決するだけ（計算されたキーは $std.mapping で書く）。
    // 位置に使うのは書かれたままのキーである。
    return {
      k: 'map',
      path,
      entries: Object.entries(node).map(
        ([rawKey, child]) =>
          [
            unescapeDollar(rawKey),
            go(
              child,
              open ? childPath(path, rawKey) : path,
              childPath(spath, rawKey),
              inData,
              open,
            ),
          ] as const,
      ),
    };
  }
  const form = dollarForm(node, shape, path, spath, open);
  return inData ? { k: 'boundary', path, body: form } : form;
}

/** 合成位置（`$` 式の内側）の脱糖。値の形が出力と対応しないので位置は凍る。 */
const expr = (node: unknown, path: string, spath: string): KNode =>
  go(node, path, spath, false, false);

/** 素通しの子（値がそのまま親の値になる位置）の脱糖。親の open をそのまま引き継ぐ。 */
const body = (node: unknown, path: string, spath: string, open: boolean): KNode =>
  go(node, path, spath, false, open);

function dollarForm(
  node: NodeMap,
  shape: Exclude<MappingShape, { kind: 'plain' }>,
  path: string,
  spath: string,
  open: boolean,
): KNode {
  if (shape.kind === 'lexical') {
    const [head, ...keys] = shape.name.split('.');
    return {
      k: 'call',
      path,
      head: head!,
      keys,
      arg: expr(node[shape.raw], path, childPath(spath, shape.raw)),
    };
  }
  const mainRaw = shape.kind === 'op' ? shape.raw : shape.mainRaw;
  const main = (): KNode => expr(node[mainRaw], path, childPath(spath, mainRaw));
  /** 主キーの値が素通しの本体である形（`$std.opt`）のための脱糖。 */
  const mainBody = (): KNode => body(node[mainRaw], path, childPath(spath, mainRaw), open);
  /** 補助キーの部分木。書かれていなければ undefined。 */
  const aux = (name: string): KNode | undefined => {
    const raw = shape.aux.get(name);
    return raw === undefined ? undefined : expr(node[raw], path, childPath(spath, raw));
  };
  /** 素通しの補助キー（`$then`、`$else`、`$default`）の部分木。 */
  const auxBody = (name: string): KNode | undefined => {
    const raw = shape.aux.get(name);
    return raw === undefined ? undefined : body(node[raw], path, childPath(spath, raw), open);
  };

  if (shape.kind === 'op') {
    switch (shape.name) {
      case 'std.list':
        return { k: 'listOf', path, body: main() };
      case 'std.mapping':
        // {$collect: {$std.list: 式}, $with: {$fn: e, $body: [${e}]}, $into: mapping}
        return {
          k: 'collect',
          path,
          target: { k: 'listOf', path, body: main() },
          fn: synthFn(path, childPath(spath, '$std.mapping'), 'e', {
            k: 'list',
            path,
            items: [{ k: 'str', path, raw: '${e}' }],
          }),
          into: 'mapping',
        };
      case 'std.first':
        return { k: 'first', path, body: main() };
      case 'std.opt':
        // std.fail の節が $default の式を返す展開。$default が無ければ null。
        return {
          k: 'handle',
          path,
          body: mainBody(),
          clauses: [
            {
              op: 'std.fail',
              fn: synthFn(
                path,
                childPath(spath, '$std.opt'),
                '_@opt',
                auxBody('default') ?? lit(path, null),
              ),
            },
          ],
        };
      case 'std.handler': {
        // {$std.handler: 節} ≡ {$fn: 私的名, $body: {$with: 節, $in: {$.私的名: null}}}
        // パラメータ名は識別子に使えない `@` を含むので、節の本体の束縛を隠さない。
        const h = handler(node[mainRaw], path, spath, mainRaw);
        const thunk = '_@handler';
        return synthFn(path, childPath(spath, mainRaw), thunk, {
          k: 'handle',
          path,
          body: mkLet(path, h.locals, {
            k: 'call',
            path,
            head: thunk,
            keys: [],
            arg: lit(path, null),
          }),
          clauses: h.clauses,
          ...(h.ret === undefined ? {} : { ret: h.ret }),
        });
      }
      case 'std.state': {
        // 残りが空の `$std.state`。文の位置でだけ書ける（残りがあれば go() が前置きとして先に取り分ける）。
        const init = main();
        return {
          k: 'err',
          path,
          message: '$std.state without $in is only allowed as a statement of $do',
          children: [{ k: 'state', path, init, body: lit(path, null) }],
        };
      }
      case 'std.param': {
        // 未渡しを std.fail に翻訳するのは呼び出し位置（評価器の op の節）である。
        const read: KNode = { k: 'op', path, name: 'std.param', arg: main() };
        const fallback = auxBody('default');
        if (fallback === undefined) return read;
        return {
          k: 'handle',
          path,
          body: read,
          clauses: [
            {
              op: 'std.fail',
              fn: synthFn(path, childPath(spath, '$std.param'), '_@default', fallback),
            },
          ],
        };
      }
      case 'std.where':
        // {$if: 条件, $then: null, $else: {$std.each: []}}
        return {
          k: 'if',
          path,
          what: '$std.where',
          cond: main(),
          then: lit(path, null),
          else: { k: 'op', path, name: 'std.each', arg: lit(path, []) },
        };
      default:
        return { k: 'op', path, name: shape.name, arg: main() };
    }
  }

  switch (shape.main) {
    case 'do': {
      const arg = node[mainRaw];
      if (!Array.isArray(arg)) {
        return {
          k: 'err',
          path,
          message: '$do requires a list of statements',
          children: [main()],
        };
      }
      const doPath = childPath(spath, mainRaw);
      return statements(arg, 0, path, (i) => `${doPath}[${i}]`, open);
    }
    case 'let': {
      // 残りが空の `$let`。文の位置でだけ書ける（残りがあれば go() が前置きとして先に取り分ける）。
      const bindings = letBindings(node[mainRaw], path, childPath(spath, mainRaw));
      return {
        k: 'err',
        path,
        message: '$let without $in is only allowed as a statement of $do',
        children: [mkLet(path, bindings, lit(path, null))],
      };
    }
    case 'if':
      return {
        k: 'if',
        path,
        what: '$if condition',
        cond: main(),
        then: auxBody('then')!,
        else: auxBody('else')!,
      };
    case 'fn':
      return {
        k: 'fn',
        path,
        spath,
        params: fnParamsOf(node[mainRaw]),
        body: aux('body')!,
      };
    case 'collect':
      return {
        k: 'collect',
        path,
        target: main(),
        fn: aux('with')!,
        into: intoOf(node[shape.aux.get('into') ?? '']),
      };
    case 'with':
      // 残りが空の `$with`。文の位置でだけ書ける（残りがあれば go() が前置きとして先に取り分ける）。
      // 検査は節をデータとして走査し、評価がここで拒む。
      return {
        k: 'err',
        path,
        message: '$with without $in is only allowed as a statement of $do',
        children: [main()],
      };
    case 'resume':
      // 節の外の `$resume` は動的に決まる（節の本体で作られた閉包からも再開できる）ので、
      // 拒めるのは評価器だけである。
      return { k: 'resume', path, arg: main() };
    default:
      throw new EffectfulYamlError(`$${shape.main} cannot be used as a main key`);
  }
}

/** `$let` の束縛のマッピングを文書順の並びにする。 */
function letBindings(bindings: unknown, path: string, spath: string): Binding[] {
  if (!isNodeMap(bindings)) {
    throw new EffectfulYamlError('$let requires a mapping of bindings');
  }
  return Object.entries(bindings).map(([name, rhs]) => {
    if (name.includes('.')) {
      throw new EffectfulYamlError(`$let binding name must not contain a dot: ${name}`);
    }
    return { name, rhs: expr(rhs, path, childPath(spath, name)) };
  });
}

/**
 * 節のマッピングから節・return・ローカル作用の宣言を組む（前置きの `$with`、`$do` の `$with` 文、
 * `$std.handler` で共通）。key はそのマッピングを値に持つキーで、節の構文パスに使う。
 * ローカル作用の宣言は、引数を素通しして内部の演算を呼ぶ関数を本体に束縛する形へ展開する。
 *
 *   {$with: {throw: 節}, $in: 本体}
 *     ==  {$with: {«throw@パス»: 節},
 *          $in: {$let: {throw: {$fn: x, $body: {$«throw@パス»: ${x}}}}, $in: 本体}}
 *
 * 内部演算名には宣言の位置の構文パスを埋めるので位置ごとに一意である。名前に含まれる `@` は
 * 識別子に使えないので、利用者が書いた同じ字面は `$` キーの分類で拒まれる。
 * これが要である：別々のハンドラが同じ名前を宣言し、外側の束縛の別名を内側のハンドラの
 * 本体で呼んでも、外側の節に届く（偶然の捕捉が起きない）。
 */
function handler(
  withNode: unknown,
  path: string,
  spath: string,
  key = '$with',
): { clauses: Clause[]; ret?: KNode; locals: Binding[] } {
  if (!isNodeMap(withNode)) {
    throw new EffectfulYamlError(`${key} requires a mapping of clauses`);
  }
  const withPath = childPath(spath, key);
  const clauses: Clause[] = [];
  const locals: Binding[] = [];
  let ret: KNode | undefined;
  for (const [name, clauseNode] of Object.entries(withNode)) {
    const kind = classifyClauseName(name);
    const clauseSpath = childPath(withPath, name);
    const fn = expr(clauseNode, path, clauseSpath);
    if (kind === 'return') {
      ret = fn;
      continue;
    }
    if (kind === 'op') {
      clauses.push({ op: name, fn });
      continue;
    }
    const opName = `${name}@${spath}`;
    clauses.push({ op: opName, fn });
    // 素通しの関数。本体は合成物なので、パラメータ名 x が利用者の束縛を隠しても害はない。
    locals.push({
      name,
      rhs: synthFn(path, clauseSpath, 'x', {
        k: 'op',
        path,
        name: opName,
        arg: { k: 'str', path, raw: '${x}' },
      }),
    });
  }
  return { clauses, ...(ret === undefined ? {} : { ret }), locals };
}

/**
 * `$do` の文の並びを脱糖する。展開のとおり、束縛文と値を捨てる文は一つの `$let` の
 * 束縛列に畳み、`$with` 文と `$std.state` 文だけが残りの文を本体に取る入れ子を作る。
 * 文の数だけ入れ子を作らないので、走査も評価も文の数でスタックを積まない。
 *
 * spathOf は i 番目の文の構文パス（`$do[i]`）を返す。
 *
 * 値が全体の値になるのは最後の文だけなので、素通しの open を引き継ぐのもそこだけである。
 * 残りの文を本体に取る形（`$with` 文と `$std.state` 文）では、その本体が最後の文を含む。
 */
function statements(
  stmts: readonly unknown[],
  from: number,
  path: string,
  spathOf: (i: number) => string,
  open: boolean,
): KNode {
  const bindings: Binding[] = [];
  for (let i = from; i < stmts.length; i++) {
    const stmt = stmts[i];
    const sp = spathOf(i);
    const form = statementPreludeOf(stmt);
    if (form !== undefined) {
      if (form.kind === 'let') {
        bindings.push(...letBindings(form.bindings, path, childPath(sp, '$let')));
        continue;
      }
      if (form.kind === 'state') {
        const init = expr(form.init, path, childPath(sp, '$std.state'));
        return mkLet(path, bindings, {
          k: 'state',
          path,
          init,
          body: statements(stmts, i + 1, path, spathOf, open),
        });
      }
      // ローカル作用の宣言は残りの文（＝本体）から見える（$let 文と同じスコープ規則）。
      const h = handler(form.clauses, path, sp);
      const rest = statements(stmts, i + 1, path, spathOf, open && h.ret === undefined);
      return mkLet(path, bindings, {
        k: 'handle',
        path,
        body: mkLet(path, h.locals, rest),
        clauses: h.clauses,
        ...(h.ret === undefined ? {} : { ret: h.ret }),
      });
    }
    if (i === stmts.length - 1) return mkLet(path, bindings, body(stmt, path, sp, open));
    bindings.push({ name: null, rhs: expr(stmt, path, sp) });
  }
  // 空の $do、および末尾が束縛文だけの $do の値は null。
  return mkLet(path, bindings, lit(path, null));
}

/**
 * 前置きを持つマッピングの脱糖。頭キーを一段だけ展開し、残りのキーからなるマッピングを
 * その本体にする。残りが `$in` ただ一つなら、その値が本体である。
 *
 *   {$let: 束縛} ∪ 残り        ==  {$let: 束縛, $in: 本体}
 *   {$std.state: 初期値} ∪ 残り ==  {$std.state: 初期値, $in: 本体}
 *   {$with: 節} ∪ 残り         ==  {$with: 節, $in: 本体}
 *
 * 頭の中身は頭キーの構文パスで脱糖し、残りはマッピング自身の構文パス spath で脱糖する
 * （$let の束縛 f は spath.$let.f、$with のローカル作用の内部名は 名前@spath、
 * データのキー k は spath.k、$in の本体は spath.$in になる）。
 * 頭は自分の値を持たないので、本体は素通しである（`return` の節を持つ `$with` だけは、
 * 本体の値を作り変えるので凍る）。残りが頭キーを持てば、その脱糖が次の一段になる。
 */
function prelude(
  node: NodeMap,
  head: string,
  rawKeys: readonly string[],
  path: string,
  spath: string,
  open: boolean,
): KNode {
  const restKeys = rawKeys.filter((k) => k !== head);
  const inOnly = restKeys.length === 1 && restKeys[0] === '$in';
  const mkBody = (o: boolean): KNode =>
    inOnly
      ? body(node['$in'], path, childPath(spath, '$in'), o)
      : body(Object.fromEntries(restKeys.map((k) => [k, node[k]])), path, spath, o);

  if (head === '$let') {
    return mkLet(path, letBindings(node[head], path, childPath(spath, head)), mkBody(open));
  }
  if (head === '$std.state') {
    const init = expr(node[head], path, childPath(spath, head));
    return { k: 'state', path, init, body: mkBody(open) };
  }
  const h = handler(node[head], path, spath);
  return {
    k: 'handle',
    path,
    body: mkLet(path, h.locals, mkBody(open && h.ret === undefined)),
    clauses: h.clauses,
    ...(h.ret === undefined ? {} : { ret: h.ret }),
  };
}

/** 文書を脱糖する。文書全体が一つの作用境界であり、その値がそのまま出力になる。 */
export function desugar(doc: unknown): KNode {
  const root = go(doc, '', '', true, true);
  return root.k === 'boundary' ? root : { k: 'boundary', path: '', body: root };
}
