/**
 * 計算の島だけを差し替える出力。
 * 仕様: tests/preserve.test.ts
 *
 * 素の YAML は自分自身に評価されるので、評価で値が変わらなかった部分は
 * 原文のバイト列をそのまま出せる。そこでリテラルの AST と評価結果を位置対応で
 * 並行に歩き、値が変わった最小の部分木のバイトレンジだけを置換テキストに
 * 差し替える（テキストのスプライシング）。コメント・整形・キー順・クォートの
 * 選択は、島の外である限りすべて原文のまま残る。
 *
 * 島の内側には踏み込まない（内側のコメントは失われる）。例外は残りがデータである
 * ブロック形式の前置きを持つマッピングで、頭の `$` の対だけを取り除いてデータのキーの
 * 内側へ降りる。
 * `$in` や `$do` の本体は字下げを変えずに原文から取り出せないので、これらは島のまま置き換える。
 * スプライシングができない・結果が合わない場合は常に stringify(result) に退化する。
 */
import { isDeepStrictEqual } from 'node:util';
import { isCollection, isMap, isNode, isScalar, isSeq, parse, parseDocument, stringify } from 'yaml';
import { headKeysWithDataRest, isDollarFormKey } from './desugar.js';
import { isClosure, type Value } from './types.js';

/** 原文の [start, end) を text で差し替える指示。文書順に並び、互いに重ならない。 */
interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * 評価結果 result を、原文 source の形を保ったまま YAML テキストにする。
 * 返り値を parse すると必ず result と等しくなる（そう作れなければ stringify に退化する）。
 */
export function renderPreserving(source: string, result: Value): string {
  try {
    const root = parseDocument(source).contents;
    if (!isNode(root)) return stringify(result);
    const splices: Splice[] = [];
    walk(source, root, result, false, true, splices);
    const out = withTrailingNewline(splice(source, splices));
    // 安全網。合わないものを出すくらいなら整形を捨てる。
    if (isDeepStrictEqual(parse(out), result)) return out;
  } catch {
    // アンカー・別名など扱えない YAML はここに落ちる。専用対応はしない。
  }
  return stringify(result);
}

/** stringify と同じく、出力は必ず改行で終える。 */
function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function splice(source: string, splices: readonly Splice[]): string {
  let out = '';
  let at = 0;
  for (const s of splices) {
    out += source.slice(at, s.start) + s.text;
    at = s.end;
  }
  return out + source.slice(at);
}

/** マッピングとして扱える値か。閉包・リストは含まない。 */
function isValueMap(v: Value): v is { readonly [key: string]: Value } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isClosure(v);
}

/** マッピングノードの生キー（YAML から読んだままの文字列）。$ 形になれるのは文字列だけ。 */
function rawKey(pairKey: unknown): string | undefined {
  return isScalar(pairKey) && typeof pairKey.value === 'string' ? pairKey.value : undefined;
}

/**
 * キーを結果側のキーと突き合わせるための文字列。
 * JS のオブジェクトのキーは常に文字列なので、`8080:` や `true:` のような
 * 文字列でないキーも文字列にしてから比べる（そうしないと変わっていないキーを
 * 書き換えてしまう）。複合キーは対応づけられないので undefined を返す。
 */
function keyText(pairKey: unknown): string | undefined {
  return isScalar(pairKey) ? String(pairKey.value) : undefined;
}

/**
 * リテラルのノードと結果の値を並行に歩き、変わった部分だけを splices に積む。
 * inFlow は「フローコレクションの内側にいる」、isRoot は「文書ルートである」。
 * ルートだけはフロー表記でもブロックで置換してよい（収まるべき行が周りにない）。
 */
function walk(
  source: string,
  node: unknown,
  value: Value,
  inFlow: boolean,
  isRoot: boolean,
  splices: Splice[],
): void {
  if (!isNode(node)) throw new Error('レンジを持たないノードは対応づけられない');
  if (isDeepStrictEqual(node.toJSON(), value)) return; // 規則 1: 変わっていない部分木は無変更
  const flow = inFlow || (isCollection(node) && node.flow === true && !isRoot);

  if (isMap(node)) {
    // 生キー。$ 形になれるのは文字列のキーだけなので、それ以外はデータのキーとして扱う。
    const rawKeys = node.items.map((p) => rawKey(p.key) ?? '');
    // 規則 2: 残りがデータであるブロック形式の前置きを持つマッピングは、頭の `$` の対を
    // 取り除き、残るデータの対を結果のエントリと i 番目どうしで対応させて内側へ降りる。
    // 残りが主形の前置きと、フロー形式の前置きは、規則 3 の島に落とす。
    const prelude = headKeysWithDataRest(rawKeys);
    if (prelude !== undefined && !inFlow && node.flow !== true && isValueMap(value)) {
      const entries = Object.entries(value);
      const drops = node.items.map((p, i) =>
        isDollarFormKey(rawKeys[i]!) ? dropPair(source, p) : null,
      );
      if (!drops.includes(undefined) && node.items.length - prelude.length === entries.length) {
        let n = 0;
        node.items.forEach((pair, i) => {
          const drop = drops[i];
          if (drop) {
            splices.push(drop);
            return;
          }
          const [key, v] = entries[n++]!;
          if (keyText(pair.key) !== key) splices.push(replace(source, pair.key, key, flow));
          walk(source, pair.value, v, flow, false, splices);
        });
        return;
      }
    }
    // 規則 3: $ 形のキーが一つでもあれば計算の島。内側には踏み込まない。
    if (rawKeys.some(isDollarFormKey)) {
      splices.push(replace(source, node, value, flow));
      return;
    }
    // 規則 4: マッピング同士でペア数が合えば、i 番目どうしを対応させて再帰する。
    if (isValueMap(value) && node.items.length === Object.keys(value).length) {
      const entries = Object.entries(value);
      node.items.forEach((pair, i) => {
        const [key, v] = entries[i]!;
        if (keyText(pair.key) !== key) splices.push(replace(source, pair.key, key, flow));
        walk(source, pair.value, v, flow, false, splices);
      });
      return;
    }
  } else if (isSeq(node) && Array.isArray(value) && node.items.length === value.length) {
    // 規則 4: シーケンス同士で要素数が合えば再帰する。
    node.items.forEach((item, i) => walk(source, item, value[i]!, flow, false, splices));
    return;
  }

  splices.push(replace(source, node, value, flow)); // 規則 5: 形が合わなければノードごと置換
}

/**
 * 前置きの頭の `$` の対を原文から取り除く指示。キーの行の先頭から値ノードの終端までを消す。
 * 行頭から消すのは、残した字下げが次の行と繋がってその対を一段深くしてしまうからである。
 * 終端に range[2] を使うので、その対の行内コメントと行末の改行まで一緒に消える。
 * 取り除けるのは、レンジを持ち、キーの前が字下げだけの対に限る。`- $let: 束縛` のように
 * ブロックのシーケンスの標識と同じ行にある対を消すと、続くデータの対が標識を失って
 * YAML でなくなる。取り除けない対は undefined を返す。
 */
function dropPair(
  source: string,
  pair: { readonly key: unknown; readonly value: unknown },
): Splice | undefined {
  const { key, value } = pair;
  if (!isNode(key) || !key.range || !isNode(value) || !value.range) return undefined;
  const start = source.lastIndexOf('\n', key.range[0] - 1) + 1;
  if (source.slice(start, key.range[0]).trim() !== '') return undefined;
  return { start, end: value.range[2], text: '' };
}

/**
 * ノードのバイトレンジを value の表記で置き換える指示を作る。
 * レンジは range[0]〜range[1]（値の終端）で、その後ろの行内コメントには触れない。
 * ただしブロックのコレクションとブロックスカラーの range[1] は行末の改行まで含むので、
 * 末尾の空白は範囲から外す（外さないと行が繋がってしまう）。
 */
function replace(source: string, node: unknown, value: Value, flow: boolean): Splice {
  if (!isNode(node) || !node.range) throw new Error('レンジを持たないノードは置換できない');
  const [start, valueEnd] = node.range;
  let end = valueEnd;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return { start, end, text: flow ? toFlow(value) : toBlock(source, start, value) };
}

/** フロー文脈の表記。JSON は妥当な YAML フローであり、常に一行に収まる。 */
function toFlow(value: Value): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('フローに書けない値');
  return text;
}

/**
 * ブロック文脈の表記。stringify の末尾改行を落とし、2 行目以降をノードの開始カラムまで
 * 押し出す。空行は押し出さない（ブロックスカラーでも空行にインデントは要らない）。
 *
 * ponytail: 先頭が空白の文字列は stringify がインデント指示子つきのブロックスカラー
 * （`|2` など）を出すので、この押し出しで指示子と実際の字下げがずれる。安全網が拾って
 * stringify(result) に退化する。必要になったら指示子を書き直す。
 */
function toBlock(source: string, start: number, value: Value): string {
  const indent = ' '.repeat(start - (source.lastIndexOf('\n', start - 1) + 1));
  return stringify(value)
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : indent + line))
    .join('\n');
}
