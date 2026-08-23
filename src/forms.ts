/**
 * `$` キーの分類と、マッピングノードの形の判定。
 * 仕様: docs/grammar.md（草案 0.5）呼び出しと名前空間 / 各フォームの節。
 *
 * effect-infer（eval-core に同居）と evaluator の双方が、同じマッピングを
 * 同じ形として認識しなければならないため、その判定をここに集約する。
 */
import { CHOICE_OPS, EffectfulYamlError, FAIL_OPS, STATE_OPS } from './types.js';

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
 * それ以外（空区画・記号・添字）は従来どおりエラーにする。添字アクセスは対象外で、
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
    return { kind: 'lexical', name };
  }
  if (DOTTED.test(nameAfterDollar)) {
    return { kind: 'op', name: nameAfterDollar };
  }
  throw new EffectfulYamlError(`unreserved $ key: $${nameAfterDollar}`);
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
 */
export function analyzeMapping(rawKeys: readonly string[]): MappingShape {
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
    // 従来どおり孤児である。文の位置かどうかはここでは分からないので、位置外は評価器がエラーにする。
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

/**
 * 作用集合（演算名の集合）に対する std の派生ハンドラの部分処理。
 * 「宣言した作用だけを取り除く」の宣言側の一覧。$handle は $with の節名で動的に決まるため含まない。
 */
export const HANDLER_REMOVES: Readonly<Record<string, ReadonlySet<string>>> = {
  'std.list': CHOICE_OPS,
  'std.mapping': CHOICE_OPS,
  'std.first': new Set([...CHOICE_OPS, ...FAIL_OPS]),
  'std.state': STATE_OPS,
  'std.opt': FAIL_OPS,
};
