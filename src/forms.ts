/**
 * `$` キーの分類と、マッピングノードの形の判定。
 * 仕様: docs/grammar.md（草案 0.8）呼び出しと名前空間 / 各フォームの節。
 *
 * 評価前の検査（typecheck.ts）と評価器（eval.ts）の双方が、同じマッピングを
 * 同じ形として認識しなければならないため、その判定をここに集約する。
 */
import { EffectfulYamlError } from './types.js';

/** 予約キー（$ を除く）。仕様の 14 個がすべてであり、演算はここに現れない。 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'do',
  'let',
  'if',
  'then',
  'else',
  'fn',
  'body',
  'handle',
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
 * `$in` は `$let` のほかに `$std.state` が、`$default` は `$std.param` と `$std.opt` が
 * 使うので、予約キーだけでなく演算の名前でも引ける表にする。
 * `$let` と `$std.state` の `$in` が必須でないのは、`$do` の文の位置でだけ省略できるからである
 * （位置はここでは分からないので、位置外の `$in` なしは評価器がエラーにする）。
 */
const AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  let: new Set(['in']),
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  handle: new Set(['with']),
  collect: new Set(['with', 'into']),
  'std.state': new Set(['in']),
  'std.param': new Set(['default']),
  'std.opt': new Set(['default']),
};

/**
 * 主キーのうち、必須の補助キー（省略するとエラー）。
 * `$let` と `$std.state` の `$in` はここに無い（文の位置では省略が正しい形である）。
 */
export const REQUIRED_AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  handle: new Set(['with']),
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
export function unescapeDollar(s: string): string {
  return s.replace(/\$\$/g, '$');
}

export type DollarKeyKind =
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
export function classifyDollarKey(nameAfterDollar: string): DollarKeyKind {
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
    // 三者（型検査・解析・評価）が通るこの一箇所で拒めば、出現主義の評価前拒否になる。
    if (name.split('.')[0] === 'return') {
      throw new EffectfulYamlError('return is reserved: $.return is not callable');
    }
    return { kind: 'lexical', name };
  }
  if (DOTTED.test(nameAfterDollar)) {
    return { kind: 'op', name: nameAfterDollar };
  }
  // ローカル作用の内部演算名（`名前@構文パス`）はここを通らない。合成したノードだけが
  // 演算として扱われ（mappingShapeOfNode）、文書に書かれた同じ字面はここで拒まれる。
  throw new EffectfulYamlError(`unreserved $ key: $${nameAfterDollar}`);
}

// ---------------------------------------------------------------------------
// $with の節名とローカル作用
//
// 節名は三分される。`return` は return 節、ドットを含む名前は演算にマッチする節、
// ドットなしの名前はローカル作用の宣言である。宣言はカーネルへの展開で意味が定まる。
//
//   {$handle: 本体, $with: {throw: 節}}
//     ==  {$handle: {$let: {throw: {$fn: x, $body: {$«throw@パス»: ${x}}}}, $in: 本体},
//          $with: {«throw@パス»: 節}}
//
// 内部演算名は $with のノードごとに一度だけ鋳造する（下の WeakMap）。名前に構文パスを
// 埋めるので位置ごとに一意である。演算として扱われるのは合成したノードそのもの
// （mappingShapeOfNode が出所で見分ける）だけなので、同じ字面を文書に書いても届かない。
// これが要である：別々のハンドラが同じ名前を宣言し、外側の束縛の別名を内側のハンドラの
// 本体で呼んでも、外側の節に届く（偶然の捕捉が起きない）。
// なお同一構文位置のハンドラが動的に自己入れ子になることは、非再帰 $let と
// 型検査の自己適用拒否により起こらないので、位置ごとの名前で足りる。
// ---------------------------------------------------------------------------

/** 素通しの関数のパラメータ名。合成したノードの中だけに現れるので衝突しない。 */
const LOCAL_PARAM = 'x';

/** 合成した内部演算名。脱出のエラー文言を組み立てる localOpParts のためだけに持つ。 */
const mintedLocalOps = new Set<string>();

/** $with の一つのローカル作用の宣言。 */
export interface LocalDecl {
  /** 宣言された裸の名前（本体から見える束縛名）。 */
  readonly name: string;
  /** 内部演算名 `名前@構文パス`。節表の鍵になる。 */
  readonly opName: string;
  readonly params: readonly string[];
  /** 素通しの関数の本体 `{$内部演算名: ${x}}`。 */
  readonly body: unknown;
  /** 素通しの $fn ノード。三者が同じノードを見るので、ノード同一性のメモも共有される。 */
  readonly fn: Record<string, unknown>;
}

/** 節名の分類。形の誤りはエラー（評価器が呼ぶ）。 */
export function classifyClauseName(name: string): 'return' | 'op' | 'local' {
  if (name === 'return') return 'return';
  if (DOTTED.test(name)) return 'op';
  if (IDENT.test(name)) return 'local';
  throw new EffectfulYamlError(
    `$handle clause name must be an operation name, a bare local name, or 'return', got: ${name}`,
  );
}

const localDecls = new WeakMap<object, ReadonlyMap<string, LocalDecl>>();
let mintCount = 0;

/**
 * $with のローカル作用の宣言。ハンドラのノードごとに一度だけ作り、合成したノードを
 * 型検査・解析・評価で共有する（走査のたびに新造すると、ノード同一性のメモが効かない）。
 * path は表示用で、最初の呼び出し（型検査）が構文位置を渡す。
 * 節名の誤りはここでは投げない（評価器が報告する）。
 * ponytail: YAML の別名で共有された $with は一つの位置として鋳造する（同じ内部名になり、
 * 入れ子にすると内側が捕まえる）。困ったら構文パスを評価器まで通して位置ごとに鋳造する。
 */
export function localDeclsOf(withNode: object, path?: string): ReadonlyMap<string, LocalDecl> {
  const cached = localDecls.get(withNode);
  if (cached !== undefined) return cached;
  const at = path ?? `#${mintCount++}`;
  const out = new Map<string, LocalDecl>();
  for (const name of Object.keys(withNode as Record<string, unknown>)) {
    if (name === 'return' || !IDENT.test(name)) continue;
    const opName = `${name}@${at}`;
    mintedLocalOps.add(opName);
    const body = { [`$${opName}`]: `\${${LOCAL_PARAM}}` };
    // 演算という扱いはこのノードの出所に紐づく（キーの字面では決して得られない）。
    synthShapes.set(body, { kind: 'op', name: opName, raw: `$${opName}`, aux: new Map() });
    out.set(name, {
      name,
      opName,
      params: [LOCAL_PARAM],
      body,
      fn: { $fn: LOCAL_PARAM, $body: body },
    });
  }
  localDecls.set(withNode, out);
  return out;
}

/** 内部演算名を宣言名と構文パスに戻す。合成した名前でなければ undefined。 */
export function localOpParts(name: string): { name: string; path: string } | undefined {
  if (!mintedLocalOps.has(name)) return undefined;
  const i = name.indexOf('@');
  return { name: name.slice(0, i), path: name.slice(i + 1) };
}

/** マッピングノードが表す形。plain はデータとして扱うマッピング。 */
export type MappingShape =
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
      /** 補助キー名（$ なし） -> 生キー。$std.state の $in、$std.param と $std.opt の $default。 */
      readonly aux: ReadonlyMap<string, string>;
    };

const NO_AUX: ReadonlySet<string> = new Set();

/** エラー文言に使う主キーの表示名。 */
function displayName(k: DollarKeyKind): string {
  if (k.kind === 'lexical') return `$.${k.name}`;
  return `$${k.kind === 'op' ? k.name : k.main}`;
}

/**
 * マッピングの生キー（YAML から読んだままの文字列）の並びから形を決める。
 * - $ 式でないキーが一つでもあれば、$ キーの有無に関わらず plain（混在はエラー）。
 * - $ キーは主キーちょうど一つと、その主キーが許す補助キーだけを許す。
 * - 補助キーを許すのは予約キー（`$in` を取る `$let` を含む）のほか、`$in` を取る
 *   `$std.state` と `$default` を取る `$std.param` と `$std.opt` だけ。
 *   レキシカル呼び出しは補助キーを取らない。
 * 走査からはノードを取る mappingShapeOfNode を通して呼ぶ（合成ノードは字面を持たない）。
 */
function analyzeMapping(rawKeys: readonly string[]): MappingShape {
  const dollarKeys = rawKeys.filter(isDollarFormKey);
  const plainKeys = rawKeys.filter((k) => !isDollarFormKey(k));

  if (dollarKeys.length === 0) return { kind: 'plain' };
  if (plainKeys.length > 0) {
    throw new EffectfulYamlError(
      `$ key mixed with plain keys: ${plainKeys.join(', ')}`,
    );
  }

  const classified = dollarKeys.map((raw) => ({
    raw,
    c: classifyDollarKey(raw.slice(1)),
  }));

  const mainCandidates = classified.filter(
    ({ c }) => c.kind !== 'reserved' || !AUX_KEY_NAMES.has(c.main),
  );
  const auxCandidates = classified.filter(
    ({ c }) => c.kind === 'reserved' && AUX_KEY_NAMES.has(c.main),
  );

  if (mainCandidates.length === 0) {
    // 単独の `$with` は `$do` の文（残りの文へハンドラを被せる）。ほかのキーを伴えば
    // 孤児である。文の位置かどうかはここでは分からないので、位置外は評価器がエラーにする。
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
  const owner = mainKind.kind === 'reserved' ? mainKind.main : mainKind.kind === 'op' ? mainKind.name : '';
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

/** 合成したノードの形。キーの字面ではなくノードの出所で引く（localDeclsOf が登録する）。 */
const synthShapes = new WeakMap<object, MappingShape>();

/**
 * マッピングノードの形。走査（型検査・解析・評価）はキーの並びではなくノードを渡す。
 * ローカル作用の素通しの本体だけは合成物なので出所で形が決まり、それ以外は
 * キーの並びから決まる。文書に書かれたキーはこの WeakMap に載らないので、内部演算名を
 * 字面で真似ても演算にはならない。
 */
export function mappingShapeOfNode(node: object): MappingShape {
  return synthShapes.get(node) ?? analyzeMapping(Object.keys(node));
}

/**
 * $fn のパラメータ。文字列一つ、または相異なる名前の 1 個以上の列（カリー化の導出形）。
 * 形の誤りはデータの変動ではないのでエラーにする。型検査・解析・評価のすべてが呼ぶ。
 */
export function fnParamsOf(raw: unknown): readonly string[] {
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
 * $do の「文形」。残りの文を本体に取る形であり、展開はそれぞれ
 *   {$let: 束縛, $in: {$do: 残り}} / {$std.state: 初期値, $in: {$do: 残り}} /
 *   {$handle: {$do: 残り}, $with: 節}
 * である。文形でない文（値を捨てるだけの文）は undefined。
 * `$in` を伴う $let と $std.state は完結した式なので文形ではない。
 * 型検査（typecheck.ts）と解析（Analyzer.doEffects）と評価（Evaluator.statements）が同じ分類を使う。
 */
export type StatementForm =
  | { readonly kind: 'let'; readonly bindings: unknown }
  | { readonly kind: 'state'; readonly init: unknown }
  | { readonly kind: 'with'; readonly clauses: unknown };

const isNodeMapLike = (n: unknown): n is Record<string, unknown> =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

export function statementFormOf(stmt: unknown): StatementForm | undefined {
  if (!isNodeMapLike(stmt)) return undefined;
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

/**
 * 処理されずに境界へ達した演算の文言。ローカル作用の内部演算がここに現れるのは、
 * 素通しの閉包がハンドラの動的範囲の外で呼ばれたときだけなので、脱出として報告する。
 * 内部名が利用者の目に触れるのはこの経路（事前検査と評価時のドライバ）だけである。
 */
export function unhandledOpMessage(name: string): string {
  const local = localOpParts(name);
  if (local === undefined) return `unregistered operation: $${name}`;
  const where = local.path === '' ? 'the document root' : local.path;
  return `local effect '${local.name}' escaped its handler (declared at ${where})`;
}
