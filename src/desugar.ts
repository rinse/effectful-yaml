/**
 * YAML ノードからカーネルの AST への脱糖。
 * 仕様: docs/grammar/kernel.md・docs/grammar/derived.md（草案 0.13）「$do」「文脈の導入」
 * 「引数名の列と部分適用」「$for」「$handler」「$default」。
 *
 * 仕様は導出形を「カーネルへの展開」で定めるので、展開はここで一度だけ行う。
 * 評価前の検査（typecheck.ts）も評価器（eval.ts）も、この AST だけを歩く。
 *
 * ノードは二種類の位置を持つ。
 *   - path:  失敗位置。出力の値の中でのその値の場所であり、式の値がそのまま出力の値に
 *            なる経路（データのキーと添字、`$in` の本体、`$do` の最後の文、`$if` の分岐、
 *            `return` の節を持たない `$handler` の本体、`$default` の式）をたどる間だけ伸びる。
 *   - spath: 構文パス。`$` 式の内側へも降りる。関数値の流れの検査のエラー位置と、
 *            ローカル作用の宣言位置に使う。必要とするノード（`$fn`）だけが持つ。
 *
 * 構文の誤り（主キーの重複、補助キーの過不足、予約されていない `$` キー、節名の綴りの誤りなど）は
 * ここで報告する。ただし「$do の文の位置でだけ書ける形」を位置の外で見つけたときだけは、
 * その場で投げずに Err ノードを置く。検査が初期値や節まで走査してから、
 * 評価がその位置に達したときに初めて拒む、という順序にするためである。
 */
import { EffectfulYamlError, type Value } from './types.js';

// ---------------------------------------------------------------------------
// カーネルの AST
// ---------------------------------------------------------------------------

/** `$let` の束縛。name が null なら値を捨てる文（文書から参照できない内部名）。 */
export interface Binding {
  readonly name: string | null;
  readonly rhs: KNode;
}

/**
 * `$handler` の節のキー。
 * path は環境で解決する名前（`std.each`、一区画の `.sig`）であり、解決先は演算でなければならない。
 * local はローカル作用の宣言であり、`$handler` の評価ごとに新しい演算の値を作って本体に束縛する。
 */
export type ClauseKey =
  | { readonly kind: 'path'; readonly head: string; readonly keys: readonly string[] }
  | { readonly kind: 'local'; readonly name: string; readonly spath: string };

/** `$handler` の節。 */
export interface Clause {
  readonly key: ClauseKey;
  readonly fn: KNode;
}

/** 節の名前の表示形。利用者が書いた綴り（一区画のパスは `.sig`）を名乗る。 */
export const clauseKeyName = (key: ClauseKey): string =>
  key.kind === 'local'
    ? key.name
    : key.keys.length === 0
      ? `.${key.head}`
      : [key.head, ...key.keys].join('.');

/** 展開が置く `std.fail` の節のキー。`std` はその位置の環境で解決する。 */
const STD_FAIL: ClauseKey = { kind: 'path', head: 'std', keys: ['fail'] };

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
  /**
   * 呼び出し `$パス`。head が環境の束縛、keys がその値のマッピングをたどるキーである。
   * たどり着いた値が関数なら適用、演算なら作用を起こす。
   * what はエラー文言で呼び出しを指す名前であり、既定は書かれた綴り（`$std.each`、`$.f`）、
   * 導出形の展開が置いた呼び出しは利用者が書いた形（`$for 'x'`）を名乗る。
   */
  | {
      readonly k: 'call';
      readonly path: string;
      readonly head: string;
      readonly keys: readonly string[];
      readonly arg: KNode;
      readonly what: string;
      /**
       * 呼び先が関数でなければならない呼び出し（関数の式を置いた `$handler` の展開）。
       * 演算にたどり着いたら作用を起こさず、型の誤りとして拒む。
       */
      readonly functionOnly?: true;
    }
  | {
      readonly k: 'handle';
      readonly path: string;
      readonly body: KNode;
      readonly clauses: readonly Clause[];
      readonly ret?: KNode;
    }
  | { readonly k: 'resume'; readonly path: string; readonly arg: KNode }
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

/** 予約キー（$ を除く）。仕様の 12 個がすべてであり、呼び出しはここに現れない。 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'do',
  'let',
  'in',
  'if',
  'then',
  'else',
  'fn',
  'body',
  'for',
  'handler',
  'resume',
  'default',
]);

/** 補助キー名の集合。主キー候補から除外するために使う。 */
const AUX_KEY_NAMES: ReadonlySet<string> = new Set(['then', 'else', 'body', 'in', 'default']);

/**
 * 主キーごとに許される補助キー。列挙されていない主キーは補助キーを取らない。
 * `$default` はどの `$` 式にも添えられるので、go() が形の判定より先に取り分ける（この表には載らない）。
 * `$in` は文脈を導入する頭の本体であり、これも go() が頭キーとともに先に取り分ける。
 */
const AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
};

/** 主キーのうち、必須の補助キー（省略するとエラー）。 */
const REQUIRED_AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
};

/** 呼び出しのパスの綴り。PATH は一区画以上（`$.名前` の形）、DOTTED は二区画以上（`$std.each` の形）。 */
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
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
  /** 呼び出し。head が束縛、keys がキーアクセス、what が書かれた綴り。 */
  | {
      readonly kind: 'call';
      readonly head: string;
      readonly keys: readonly string[];
      readonly what: string;
    };

/**
 * $ を除いたキー本体を分類する。
 * ドットを含まない名前は予約キーであり、予約されていなければエラーである。
 * ドットを含む名前は環境にある値の呼び出しで、最初の区画が束縛を解決し、残りの区画が
 * その値のマッピングをキーでたどる。先頭区画が空の `$.名前` は、一区画のパスを
 * 予約キーと区別して書く書き方である。
 * `$let` の束縛名にドットを使えない（束縛と制御の節）ので、名前の中のドットは常に
 * 「束縛名の終わり・キーアクセスの始まり」の区切りとして読める。
 * それ以外（空区画・記号・添字）はエラーにする。添字アクセスは対象外で、
 * 必要なら `$let` で名前を付けてから呼ぶ。
 */
function classifyDollarKey(nameAfterDollar: string): DollarKeyKind {
  if (RESERVED_KEYS.has(nameAfterDollar)) {
    return { kind: 'reserved', main: nameAfterDollar };
  }
  const what = `$${nameAfterDollar}`;
  const dotted = nameAfterDollar.startsWith('.');
  const name = dotted ? nameAfterDollar.slice(1) : nameAfterDollar;
  if (!(dotted ? PATH : DOTTED).test(name)) {
    throw new EffectfulYamlError(
      dotted ? `invalid call path: ${what}` : `unreserved $ key: ${what}`,
    );
  }
  const [head, ...keys] = name.split('.');
  // return はハンドラの節名として予約されている。呼び出しとして書かれたら構文の誤りである
  // （束縛としての `$let: {return: ...}` と `${return}` の参照は合法）。
  if (head === 'return') {
    throw new EffectfulYamlError('return is reserved: $.return is not callable');
  }
  return { kind: 'call', head: head!, keys, what };
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
  | {
      readonly kind: 'call';
      readonly head: string;
      readonly keys: readonly string[];
      readonly what: string;
      readonly raw: string;
    };

const NO_AUX: ReadonlySet<string> = new Set();

/** エラー文言に使う主キーの表示名。 */
function displayName(k: DollarKeyKind): string {
  return k.kind === 'call' ? k.what : `$${k.main}`;
}

/** 文脈を導入する頭キーの生キー三つ。`$` キーは書かれたままの字面で見る（`$$let` は該当しない）。 */
const HEAD_KEYS: ReadonlySet<string> = new Set(['$let', '$for', '$handler']);

/**
 * マッピングに文脈を導入する頭キー。文書順で最初の頭キーであり、残り（そのキーを除いた全部）が
 * その本体になる。
 */
function headKeyOf(rawKeys: readonly string[]): string | undefined {
  return rawKeys.find((k) => HEAD_KEYS.has(k));
}

/**
 * 文脈の導入を伴うブロック形式のマッピングで残りがデータであるものの、頭キーを文書順の配列で返す。
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
 * 文脈を導入する頭は go() がこれより先に取り分けるので、ここに届くのは主形か、
 * 頭キー一つだけのマッピング（残りが空）である。`$` キーとデータのキーが
 * 混在して届いたときは常にエラーである。
 * - `$` キーが一つも無ければ plain。
 * - `$` キーとデータのキーが混在していればエラー。
 * - `$` キーだけなら、主キーちょうど一つと、その主キーが許す補助キーだけを許す。
 * - 補助キーを許すのは予約キー `$if` と `$fn` だけである（呼び出しは補助キーを取らない）。
 *   `$default` は go() が先に取り分けるので、ここには届かない。
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
    const orphan = auxCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`auxiliary $ key without a main key: ${orphan}`);
  }
  if (mainCandidates.length > 1) {
    const names = mainCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`more than one main $ key: ${names}`);
  }

  const mainEntry = mainCandidates[0]!;
  const { raw: mainRaw, c: mainKind } = mainEntry;

  // 補助キーの持ち主は予約キーだけである（呼び出しは表に載せない）。
  const owner = mainKind.kind === 'reserved' ? mainKind.main : '';
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

  if (mainKind.kind === 'call') {
    return {
      kind: 'call',
      head: mainKind.head,
      keys: mainKind.keys,
      what: mainKind.what,
      raw: mainRaw,
    };
  }
  return { kind: 'reserved', main: mainKind.main, mainRaw, aux };
}

/** 節名の分類。構文の誤りはエラー。spath は宣言位置（ローカル作用の同一性の出所）。 */
function classifyClauseName(name: string, spath: string): 'return' | ClauseKey {
  if (name === 'return') return 'return';
  if (DOTTED.test(name)) {
    const [head, ...keys] = name.split('.');
    return { kind: 'path', head: head!, keys };
  }
  if (name.startsWith('.') && IDENT.test(name.slice(1))) {
    return { kind: 'path', head: name.slice(1), keys: [] };
  }
  if (IDENT.test(name)) return { kind: 'local', name, spath };
  throw new EffectfulYamlError(
    `$handler clause name must be a path, a bare local name, or 'return', got: ${name}`,
  );
}

/**
 * 処理されずに境界へ達した演算の文言。ローカル作用の内部名（`名前@構文パス#連番`）は
 * 識別子に使えない `@` を含むので、字面だけで脱出の文言を選べる。宣言が作った演算の値が
 * ハンドラの外へ持ち出されて呼ばれたときだけここに現れるので、脱出として報告する。
 * 内部名が利用者の目に触れるのはこの経路（評価時のドライバ）だけであり、
 * 実行時の連番は名乗らない。
 */
export function unhandledOpMessage(name: string): string {
  const at = name.indexOf('@');
  if (at < 0) return `unregistered operation: $${name}`;
  const where = name.slice(at + 1).split('#')[0]!;
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
 * 展開が合成する一引数関数。本体が利用者の式である節（`$default` の `std.fail` 節など）では
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

/**
 * `$resume` を書ける位置（節の本体の中）にいるかどうか。
 * 仕様は `$resume` を節の本体（その中の `$fn` の本体を含む）に限るので、
 * 節の本体へ降りるときに立て、`return` 節とハンドラの本体では降りる前の値に戻す。
 * 脱糖は単一スレッドで同期に走るので、引数を十数個の関数に通す代わりにこの変数で持ち回る。
 */
let inClause = false;

/**
 * `$do` の文に置いた文脈の導入。頭キーだけからなるマッピングであり、残りの文を本体に取る。
 * 残りを持つ頭は本体をその残りに取るので、文としては完結した式である。
 */
type ContextIntro = {
  readonly kind: 'let' | 'for' | 'handler';
  /** 頭の中身（束縛のマッピング、または `$handler` の式）。 */
  readonly head: unknown;
};

function contextIntroOf(stmt: unknown): ContextIntro | undefined {
  if (!isNodeMap(stmt)) return undefined;
  const rawKeys = Object.keys(stmt);
  // 残りを持つ頭は、その残りを本体に取る完結した式である。`$default` を添えた頭も、
  // 形の判定を `$default` の展開が包んだ `$` 式に対して行うので、文脈の導入ではない。
  if (rawKeys.length > 1 && headKeyOf(rawKeys) !== undefined) return undefined;
  if (rawKeys.includes('$default')) return undefined;
  const shape = analyzeMapping(rawKeys);
  if (shape.kind !== 'reserved') return undefined;
  if (shape.main !== 'let' && shape.main !== 'for' && shape.main !== 'handler') return undefined;
  return { kind: shape.main, head: stmt[shape.mainRaw] };
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
  // 補助キー `$default` はどの `$` 式にも添えられる。形の判定はこれを除いてから行う。
  if (rawKeys.includes('$default')) return withDefault(node, rawKeys, path, spath, inData, open);
  // 頭キーがあり、残り（そのキーを除いた全部）が空でなければ文脈の導入を伴うマッピング。
  const head = rawKeys.length > 1 ? headKeyOf(rawKeys) : undefined;
  if (head !== undefined) {
    const form = desugarContextIntro(node, head, rawKeys, path, spath, open);
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

/**
 * 補助キー `$default` の展開。
 *
 *   {X ∪ {$default: 式}} ≡ {$handler: {std.fail: {$fn: 内部名, $body: 式}}, $in: X}
 *
 * 残り X をそのまま脱糖し、既定値の式を返す `std.fail` の節で包む。節が `$resume` を
 * 呼ばずに式へ達するので、失敗した時点で X は打ち切られる。既定値の式は X の外側にあり、
 * X の頭が導入する束縛は見えない。展開の `std.fail` はこの位置の環境で解決する。
 */
function withDefault(
  node: NodeMap,
  rawKeys: readonly string[],
  path: string,
  spath: string,
  inData: boolean,
  open: boolean,
): KNode {
  const restKeys = rawKeys.filter((k) => k !== '$default');
  if (!restKeys.some(isDollarFormKey)) {
    const plain = restKeys.filter((k) => !isDollarFormKey(k));
    throw new EffectfulYamlError(
      plain.length === 0
        ? 'auxiliary $ key without a main key: $default'
        : `$ key mixed with plain keys: ${plain.join(', ')}`,
    );
  }
  const rest = Object.fromEntries(restKeys.map((k) => [k, node[k]]));
  const main = go(rest, path, spath, false, open);
  // 既定値の式は展開により節の本体なので、そこでは `$resume` を書ける。
  const saved = inClause;
  inClause = true;
  const dpath = childPath(spath, '$default');
  const fallback = body(node['$default'], path, dpath, open);
  inClause = saved;
  const form: KNode = {
    k: 'handle',
    path,
    body: main,
    clauses: [{ key: STD_FAIL, fn: synthFn(path, dpath, '_@default', fallback) }],
  };
  return inData ? { k: 'boundary', path, body: form } : form;
}

function dollarForm(
  node: NodeMap,
  shape: Exclude<MappingShape, { kind: 'plain' }>,
  path: string,
  spath: string,
  open: boolean,
): KNode {
  if (shape.kind === 'call') {
    return {
      k: 'call',
      path,
      head: shape.head,
      keys: shape.keys,
      what: shape.what,
      arg: expr(node[shape.raw], path, childPath(spath, shape.raw)),
    };
  }
  const mainRaw = shape.mainRaw;
  const main = (): KNode => expr(node[mainRaw], path, childPath(spath, mainRaw));
  /** 素通しの補助キー（`$then`、`$else`）の部分木。 */
  const auxBody = (name: string): KNode | undefined => {
    const raw = shape.aux.get(name);
    return raw === undefined ? undefined : body(node[raw], path, childPath(spath, raw), open);
  };

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
      // 残りが空の `$let`。文の位置でだけ書ける（残りがあれば go() が文脈の導入として先に取り分ける）。
      const bindings = letBindings(node[mainRaw], path, childPath(spath, mainRaw));
      return {
        k: 'err',
        path,
        message: '$let without $in is only allowed as a statement of $do',
        children: [mkLet(path, bindings, lit(path, null))],
      };
    }
    case 'for': {
      // 残りが空の `$for`。文の位置でだけ書ける。
      const bindings = forBindings(node[mainRaw], path, childPath(spath, mainRaw));
      return {
        k: 'err',
        path,
        message: '$for without $in is only allowed as a statement of $do',
        children: [mkLet(path, bindings, lit(path, null))],
      };
    }
    case 'handler':
      // 残りが空の `$handler`。文の位置でだけ書ける。
      // 検査は節と本体まで降りるので、本体を null にした展開を子に置く。
      return {
        k: 'err',
        path,
        message: '$handler without $in is only allowed as a statement of $do',
        children: [
          desugarHandler(node[mainRaw], () => lit(path, null), path, spath, mainRaw, false),
        ],
      };
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
        body: expr(node[shape.aux.get('body')!], path, childPath(spath, shape.aux.get('body')!)),
      };
    case 'resume':
      // `$resume` を書けるのは節の本体（その中の `$fn` の本体を含む）だけである。
      if (!inClause) {
        throw new EffectfulYamlError('$resume is only allowed inside a $handler clause');
      }
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
 * `$for` の束縛のマッピングを文書順の並びにする。`$let` と同じ検査（マッピングであること、
 * 束縛名にドットを含まないこと）を課すが、各右辺は `std.each` の呼び出しで包む。これにより
 * `$for` は選択を導入する束縛の並びになり、後の束縛は先の束縛が選んだ要素を見る。
 * 展開の `$std.each` は展開先の環境で解決するので、`std` を隠せば `$for` もそれに従う。
 * エラー文言は展開先ではなく利用者が書いた形（`$for 'x'`）を名乗る。
 */
function forBindings(bindings: unknown, path: string, spath: string): Binding[] {
  if (!isNodeMap(bindings)) {
    throw new EffectfulYamlError('$for requires a mapping of bindings');
  }
  return Object.entries(bindings).map(([name, rhs]) => {
    if (name.includes('.')) {
      throw new EffectfulYamlError(`$for binding name must not contain a dot: ${name}`);
    }
    return {
      name,
      rhs: {
        k: 'call' as const,
        path,
        head: 'std',
        keys: ['each'],
        what: `$for '${name}'`,
        arg: expr(rhs, path, childPath(spath, name)),
      },
    };
  });
}

/**
 * literal な節のマッピングから節と `return` を組む。key はそのマッピングを値に持つキーで、
 * 節の構文パスに使う。節の名前の解決は評価時（`$handler` の位置の環境）に行うので、
 * ここで決まるのは名前の綴りによる分類だけである。
 * ローカル作用の宣言（ドットを含まない名前）は spath を持ち回り、評価のたびに
 * 新しい演算の値を作って本体に束縛する（同一性は値が持つ）。
 *
 * 節の本体では `$resume` を書けるが、`return` 節では書けない。
 */
function clausesOf(
  hnode: NodeMap,
  path: string,
  spath: string,
  key: string,
): { clauses: Clause[]; ret?: KNode } {
  const hpath = childPath(spath, key);
  const clauses: Clause[] = [];
  let ret: KNode | undefined;
  const ambient = inClause;
  for (const [name, clauseNode] of Object.entries(hnode)) {
    const ckey = classifyClauseName(name, spath);
    const clauseSpath = childPath(hpath, name);
    inClause = ckey !== 'return' || ambient;
    const fn = expr(clauseNode, path, clauseSpath);
    inClause = ambient;
    if (ckey === 'return') ret = fn;
    else clauses.push({ key: ckey, fn });
  }
  return { clauses, ...(ret === undefined ? {} : { ret }) };
}

/**
 * `$handler` の脱糖。式は literal な節のマッピング（`$` キーを持たないマッピング）か、
 * 関数に評価される式のどちらかである。後者は本体の閉包を渡す呼び出しへ展開する。
 *
 *   {$handler: 関数の式, $in: 本体}
 *     ≡ {$let: {内部名: 関数の式}, $in: {$.内部名: {$fn: 捨て名, $body: 本体}}}
 *
 * mkBody は本体の脱糖（引数は素通しの open）。節のマッピングなら `return` 節の有無で決まり、
 * 関数の式なら値が呼び出しを経て返るので素通しにならない。
 */
function desugarHandler(
  hnode: unknown,
  mkBody: (open: boolean) => KNode,
  path: string,
  spath: string,
  key: string,
  open: boolean,
): KNode {
  if (isNodeMap(hnode) && !Object.keys(hnode).some(isDollarFormKey)) {
    const h = clausesOf(hnode, path, spath, key);
    return {
      k: 'handle',
      path,
      body: mkBody(open && h.ret === undefined),
      clauses: h.clauses,
      ...(h.ret === undefined ? {} : { ret: h.ret }),
    };
  }
  if (!isNodeMap(hnode) && typeof hnode !== 'string') {
    throw new EffectfulYamlError(
      `$handler requires a mapping of clauses or an expression evaluating to a function, got: ${JSON.stringify(hnode)}`,
    );
  }
  // 内部名と捨て名には識別子に使えない `@` を含めるので、利用者の束縛を隠さない。
  const hpath = childPath(spath, key);
  const priv = '_@handler';
  return {
    k: 'let',
    path,
    bindings: [{ name: priv, rhs: expr(hnode, path, hpath) }],
    body: {
      k: 'call',
      path,
      head: priv,
      keys: [],
      what: handlerWhat(hnode),
      functionOnly: true,
      arg: synthFn(path, hpath, '_@body', mkBody(false)),
    },
  };
}

/**
 * 関数の式を置いた `$handler` の展開が名乗る形。展開の内部名ではなく、利用者が書いた
 * `$handler: ${std.first}` や `$handler: {$std.state: ...}` を名乗る。
 */
function handlerWhat(hnode: unknown): string {
  if (typeof hnode === 'string') return `$handler: ${hnode}`;
  if (isNodeMap(hnode)) {
    const keys = Object.keys(hnode).filter(isDollarFormKey);
    if (keys.length === 1) return `$handler: {${keys[0]}: ...}`;
  }
  return '$handler';
}

/**
 * `$do` の文の並びを脱糖する。展開のとおり、束縛文（`$let` 文と `$for` 文）と値を捨てる文は
 * 一つの `$let` の束縛列に畳み、`$handler` 文だけが残りの文を本体に取る入れ子を作る。
 * 文の数だけ入れ子を作らないので、走査も評価も文の数でスタックを積まない。
 *
 * spathOf は i 番目の文の構文パス（`$do[i]`）を返す。
 *
 * 値が全体の値になるのは最後の文だけなので、素通しの open を引き継ぐのもそこだけである。
 * 残りの文を本体に取る形（`$handler` 文）では、その本体が最後の文を含む。
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
    const form = contextIntroOf(stmt);
    if (form !== undefined) {
      if (form.kind === 'let') {
        bindings.push(...letBindings(form.head, path, childPath(sp, '$let')));
        continue;
      }
      if (form.kind === 'for') {
        bindings.push(...forBindings(form.head, path, childPath(sp, '$for')));
        continue;
      }
      // ローカル作用の宣言は残りの文（＝本体）から見える（$let 文と同じスコープ規則）。
      return mkLet(
        path,
        bindings,
        desugarHandler(
          form.head,
          (o) => statements(stmts, i + 1, path, spathOf, o),
          path,
          sp,
          '$handler',
          open,
        ),
      );
    }
    if (i === stmts.length - 1) return mkLet(path, bindings, body(stmt, path, sp, open));
    bindings.push({ name: null, rhs: expr(stmt, path, sp) });
  }
  // 空の $do、および末尾が束縛文だけの $do の値は null。
  return mkLet(path, bindings, lit(path, null));
}

/**
 * 文脈の導入を伴うマッピングの脱糖。頭キーを一段だけ展開し、残りのキーからなるマッピングを
 * その本体にする。残りが `$in` ただ一つなら、その値が本体である。
 *
 *   {$let: 束縛} ∪ 残り     ==  {$let: 束縛, $in: 本体}
 *   {$for: 束縛} ∪ 残り     ==  {$for: 束縛, $in: 本体}
 *   {$handler: 式} ∪ 残り   ==  {$handler: 式, $in: 本体}
 *
 * 頭の中身は頭キーの構文パスで脱糖し、残りはマッピング自身の構文パス spath で脱糖する
 * （$let の束縛 f は spath.$let.f、$for の束縛 f は spath.$for.f、
 * $handler のローカル作用の宣言位置は spath、データのキー k は spath.k、
 * $in の本体は spath.$in になる）。
 * 頭は自分の値を持たないので、本体は素通しである（`return` の節を持つ `$handler` と
 * 関数の式で与えた `$handler` だけは、本体の値を作り変えるので凍る）。
 * 残りが頭キーを持てば、その脱糖が次の一段になる。
 */
function desugarContextIntro(
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
  if (head === '$for') {
    return mkLet(path, forBindings(node[head], path, childPath(spath, head)), mkBody(open));
  }
  return desugarHandler(node[head], mkBody, path, spath, head, open);
}

/** 文書を脱糖する。文書全体が一つの作用境界であり、その値がそのまま出力になる。 */
export function desugar(doc: unknown): KNode {
  inClause = false;
  const root = go(doc, '', '', true, true);
  return root.k === 'boundary' ? root : { k: 'boundary', path: '', body: root };
}
