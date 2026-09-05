/**
 * 文字列キーの永続（不変）平衡木。環境（評価器の Env、解析器の SEnv）の土台。
 *
 * 重み平衡木（Adams 1992 "Implementing Sets Efficiently in a Functional Language"、
 * Haskell の Data.Map と同系）である。各ノードが部分木のサイズを持ち、挿入のたびに
 * 単回転・二重回転で重みの条件を回復する。パラメータは Haskell containers と同じ
 * delta = 3 / ratio = 2 で、これは Hirai & Yamamoto (2011)
 * "Balancing weight-balanced trees" が挿入・削除の両方について正当性を検証した組である。
 *
 * 保証（最悪計算量。平均でも償却でもない）:
 *   - 重みの条件「ls + rs <= 1、または ls <= 3 rs かつ rs <= 3 ls」から、
 *     どの子も部分木の 3/4 より大きくならない。ゆえに高さ h <= log(4/3) n ≒ 2.41 log2 n。
 *   - get は根から降りるだけで O(log n) 回のキー比較。
 *   - insert は経路上のノードだけを作り直すので O(log n) 回の比較と O(log n) ノードの複製。
 *     経路の外は元の木と共有するので、古い木もそのまま有効なまま残る（永続）。
 *
 * 乱択（treap）やハッシュ（HAMT）を使わないのは、最悪計算量が確率や衝突に依存し、
 * 敵対的な入力に対する上限を保証できないからである。比較ベースならキーの分布によらない。
 *
 * 削除は要らない（環境は伸びるだけ）ので実装しない。
 */

export interface PNode<V> {
  readonly key: string;
  readonly value: V;
  readonly left: PMap<V>;
  readonly right: PMap<V>;
  /** 部分木のノード数。バランス判定に使う。 */
  readonly size: number;
}

export type PMap<V> = PNode<V> | null;

export const empty: PMap<never> = null;

const sizeOf = (m: PMap<unknown>): number => (m === null ? 0 : m.size);

const node = <V>(key: string, value: V, left: PMap<V>, right: PMap<V>): PNode<V> => ({
  key,
  value,
  left,
  right,
  size: sizeOf(left) + sizeOf(right) + 1,
});

/** 片側が他方の何倍まで許されるか（この倍率を超えたら回す）。 */
const DELTA = 3;
/** 回した先が条件を満たすかの判定に使う内訳の比。単回転で足りるか二重回転かを分ける。 */
const RATIO = 2;

/**
 * 値が undefined でも壊れないこと。ノードの有無と値は無関係なので、
 * undefined を入れてもサイズもバランスも正しく保たれる。
 * ただし get の戻りでは「未束縛」と「undefined が束縛されている」を区別できない。
 */
export function get<V>(m: PMap<V>, key: string): V | undefined {
  for (let cur = m; cur !== null; ) {
    if (key < cur.key) cur = cur.left;
    else if (key > cur.key) cur = cur.right;
    else return cur.value;
  }
  return undefined;
}

/** 同じキーがあれば値を差し替える（木の形は変わらない）。無ければ足して重みを回復する。 */
export function insert<V>(m: PMap<V>, key: string, value: V): PMap<V> {
  if (m === null) return node(key, value, null, null);
  if (key < m.key) return balance(m.key, m.value, insert(m.left, key, value), m.right);
  if (key > m.key) return balance(m.key, m.value, m.left, insert(m.right, key, value));
  return { key, value, left: m.left, right: m.right, size: m.size };
}

/**
 * 片側が一段ぶん重くなった直後の木を、重みの条件へ戻す。
 * 挿入は一度に 1 だけ増やすので、崩れは高々「DELTA をわずかに超える」程度であり、
 * 単回転か二重回転の一回で回復する（これが重み平衡木の要）。
 */
function balance<V>(key: string, value: V, l: PMap<V>, r: PMap<V>): PNode<V> {
  const ls = sizeOf(l);
  const rs = sizeOf(r);
  // 合計 1 以下（片側が空でもう片側が高々 1 個）は回しようがなく、条件も満たしている。
  if (ls + rs <= 1) return node(key, value, l, r);
  if (rs > DELTA * ls) {
    // rs >= 2 なので r は非 null。
    const rr = r as PNode<V>;
    return sizeOf(rr.left) < RATIO * sizeOf(rr.right)
      ? node(rr.key, rr.value, node(key, value, l, rr.left), rr.right)
      : doubleL(key, value, l, rr);
  }
  if (ls > DELTA * rs) {
    const ll = l as PNode<V>;
    return sizeOf(ll.right) < RATIO * sizeOf(ll.left)
      ? node(ll.key, ll.value, ll.left, node(key, value, ll.right, r))
      : doubleR(key, value, ll, r);
  }
  return node(key, value, l, r);
}

/** 右の子の左が重いとき、その孫を持ち上げる。上の分岐に入った時点で rr.left は非 null。 */
function doubleL<V>(key: string, value: V, l: PMap<V>, rr: PNode<V>): PNode<V> {
  const rl = rr.left as PNode<V>;
  return node(
    rl.key,
    rl.value,
    node(key, value, l, rl.left),
    node(rr.key, rr.value, rl.right, rr.right),
  );
}

/** doubleL の鏡像。 */
function doubleR<V>(key: string, value: V, ll: PNode<V>, r: PMap<V>): PNode<V> {
  const lr = ll.right as PNode<V>;
  return node(
    lr.key,
    lr.value,
    node(ll.key, ll.value, ll.left, lr.left),
    node(key, value, lr.right, r),
  );
}

/**
 * 検査専用。不変条件（二分探索木の順序・size フィールドの正しさ・重みの条件）を全ノードで確かめ、
 * 破れていれば投げる。木の実際のサイズと高さを返す。
 * 実装の内部を外から試すためだけに export している（tests/pmap.test.ts）。
 */
export function inspect(m: PMap<unknown>): { size: number; height: number } {
  const go = (
    t: PMap<unknown>,
    lo: string | undefined,
    hi: string | undefined,
  ): { size: number; height: number } => {
    if (t === null) return { size: 0, height: 0 };
    if ((lo !== undefined && !(lo < t.key)) || (hi !== undefined && !(t.key < hi))) {
      throw new Error(`BST order violated at key ${t.key} (lo=${String(lo)}, hi=${String(hi)})`);
    }
    const left = go(t.left, lo, t.key);
    const right = go(t.right, t.key, hi);
    const size = left.size + right.size + 1;
    if (t.size !== size) throw new Error(`size field wrong at key ${t.key}: ${t.size} != ${size}`);
    const ls = left.size;
    const rs = right.size;
    if (ls + rs > 1 && (ls > DELTA * rs || rs > DELTA * ls)) {
      throw new Error(`weight condition violated at key ${t.key}: ${ls} vs ${rs}`);
    }
    return { size, height: Math.max(left.height, right.height) + 1 };
  };
  return go(m, undefined, undefined);
}
