/**
 * `$` キーの分類と、マッピングノードの形の判定。
 * 仕様: docs/grammar.md（草案 0.3）呼び出しと名前空間 / 各フォームの節。
 *
 * effect-infer（eval-core に同居）と evaluator の双方が、同じマッピングを
 * 同じ形として認識しなければならないため、その判定をここに集約する。
 */
import { CHOICE_OPS, EffectfulYamlError, STATE_OPS } from './types.js';

/** 予約主キー（$ を除く）。補助キーも合わせて 26 個。 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'do',
  'let',
  'if',
  'then',
  'else',
  'fn',
  'body',
  'op',
  'pipe',
  'through',
  'each',
  'where',
  'param',
  'default',
  'get',
  'set',
  'log',
  'fail',
  'list',
  'first',
  'mapping',
  'state',
  'in',
  'handle',
  'with',
  'resume',
]);

/** 補助キー名の集合。主キー候補から除外するために使う。 */
const AUX_KEY_NAMES: ReadonlySet<string> = new Set([
  'then',
  'else',
  'body',
  'through',
  'default',
  'in',
  'with',
]);

/** 主キーごとに許される補助キー。列挙されていない主キーは補助キーを取らない。 */
const AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  pipe: new Set(['through']),
  param: new Set(['default']),
  state: new Set(['in']),
  handle: new Set(['with']),
};

/** 主キーのうち、必須の補助キー（省略するとエラー）。 */
export const REQUIRED_AUX_OF: Readonly<Record<string, ReadonlySet<string>>> = {
  if: new Set(['then', 'else']),
  fn: new Set(['body']),
  state: new Set(['in']),
  handle: new Set(['with']),
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
 * `.名前` はレキシカルな束縛（$let の束縛名にドットは使えないため、名前は単純な識別子に限る）。
 * ドットを含む名前は登録演算。それ以外は予約キーでなければエラー。
 */
export function classifyDollarKey(nameAfterDollar: string): DollarKeyKind {
  if (RESERVED_KEYS.has(nameAfterDollar)) {
    return { kind: 'reserved', main: nameAfterDollar };
  }
  if (nameAfterDollar.startsWith('.')) {
    const name = nameAfterDollar.slice(1);
    if (!IDENT.test(name)) {
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
  | { readonly kind: 'op'; readonly name: string; readonly raw: string };

/**
 * マッピングの生キー（YAML から読んだままの文字列）の並びから形を決める。
 * - $ 式でないキーが一つでもあれば、$ キーの有無に関わらず plain（混在はエラー）。
 * - $ キーは主キーちょうど一つと、その主キーが許す補助キーだけを許す。
 * - 呼び出し（レキシカル・登録演算）は補助キーを取らない。
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
    const orphan = auxCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`auxiliary $ key without a main key: ${orphan}`);
  }
  if (mainCandidates.length > 1) {
    const names = mainCandidates.map(({ raw }) => raw).join(', ');
    throw new EffectfulYamlError(`more than one main $ key: ${names}`);
  }

  const mainEntry = mainCandidates[0]!;
  const { raw: mainRaw, c: mainKind } = mainEntry;

  if (mainKind.kind === 'lexical' || mainKind.kind === 'op') {
    if (auxCandidates.length > 0) {
      throw new EffectfulYamlError(
        `call $${mainKind.kind === 'lexical' ? '.' : ''}${mainKind.name} does not take auxiliary keys: ${auxCandidates.map(({ raw }) => raw).join(', ')}`,
      );
    }
    return { kind: mainKind.kind, name: mainKind.name, raw: mainRaw };
  }

  const allowed = AUX_OF[mainKind.main] ?? new Set<string>();
  const aux = new Map<string, string>();
  for (const { raw, c } of auxCandidates) {
    if (c.kind !== 'reserved') continue;
    if (!allowed.has(c.main)) {
      throw new EffectfulYamlError(`$${mainKind.main} does not accept $${c.main}`);
    }
    aux.set(c.main, raw);
  }

  const required = REQUIRED_AUX_OF[mainKind.main];
  if (required !== undefined) {
    for (const name of required) {
      if (!aux.has(name)) {
        throw new EffectfulYamlError(`$${mainKind.main} requires $${name}`);
      }
    }
  }

  return { kind: 'reserved', main: mainKind.main, mainRaw, aux };
}

/**
 * 作用集合（演算名の集合）に対するハンドラの部分処理。
 * 「宣言した作用だけを取り除く」の宣言側の一覧。$handle は $with の節名で動的に決まるため含まない。
 */
export const HANDLER_REMOVES: Readonly<Record<string, ReadonlySet<string>>> = {
  list: CHOICE_OPS,
  mapping: CHOICE_OPS,
  first: new Set([...CHOICE_OPS, 'fail']),
  state: STATE_OPS,
};
