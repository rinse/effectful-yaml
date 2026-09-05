# std.state

`std.state` は状態作用の新しいスコープを作る。

- 種別：std の派生ハンドラ
- 処理する演算：`std.get` `std.set`
- 補助キー：`$in`

## 形

```yaml
$std.state:
  セル名: 初期値
$in: 本体の式
```

## 規則

- 本体の中の `std.get` と `std.set` は、最も近い `$std.state` の記憶に解決される。セルごとに別の `$std.state` へ振り分けることはしない。
- 初期値のマッピングは空でもよい。セルは `std.set` で作れる。
- 値は本体の値である。最終状態は捨てられるので、要るなら本体の最後で `std.get` する。
- 文書の最外には暗黙の `$std.state: {}` があり、これが状態の既定ハンドラである。

## 展開

`std.state` は `$handle` への展開で意味論が定まる。
節は状態変換関数、すなわち「現在の状態を受け取り、次の状態への適用を経て最終的な値を返す関数」を返す古典的なパラメータ付きハンドラである。
`std.get` の節を示す（`std.set` と `return` も同型である）。

```yaml
std.get:
  $fn: name
  $body:
    $fn: s
    $body:
      $do:
      - $let:
          hits:
            $collect: ${s}
            $with:
              $fn: e
              $body:
                $if: ${e.key == name}
                $then:
                - ${e.value}
                $else: []
      - $let:
          k:
            $resume: ${hits[0]}
      - $.k: ${s}
```

節の本体は、状態 `s`（セルのエントリの列として表現される）を引数に取る関数 `{$fn: s, $body: ...}` を返す。
`$collect` で `s` を回り、名前が一致するエントリの `value` だけを残す。
`${hits[0]}` は、パスをたどる参照が存在しない添字で `std.fail` を起こす規則により、セルが未初期化のときちょうど `std.fail` を起こす。
`$resume: ${hits[0]}` の値は、残りの計算を処理し尽くした後の状態変換関数（`k`）であり、これを現在の状態 `s` に適用して続行する。
`std.set` の節も同じ骨格である。
渡されたマッピングでエントリの列を更新し、`$resume` で得た状態変換関数を、元の `s` ではなくその更新後の状態に適用する。
`return` 節も同じ骨格を保ち、状態を更新も消費もせず、そのまま値へ通す関数を返す。
値は本体の値であり最終状態が現れないのは、この `return` の段で状態を捨てているからである（規則の節を参照）。

展開の全体は、本体を `$handle: 本体` としてこのハンドラで包み、得られた状態変換関数を初期値のエントリの列に適用する形である。
初期値の式は本体より先に評価される。

## スコープの隔離

内側の `$std.state` は外の状態に触れない作業領域になる。

```yaml
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $std.state: {n: 0}
      $in:
        $do:
        - $std.set: {n: 1}
        - {$std.get: n}
    outer: {$std.get: n}
- inner: ${inner}
  outer: ${outer}
```

```yaml
inner: 1
outer: 100
```

## 選択との関係

`$std.state` を選択に対してどこに置くかで、状態と分岐の関係が決まる。
覚え方は「ハンドラは自分より内側だけを見る」である。
`$std.state` が選択を包めば状態は分岐をまたぎ（貫流）、選択に包まれれば分岐ごとになる（分岐点で分かれる）。

```yaml
# 貫流（既定と同じ）: 状態が分岐から分岐へ持ち越される
$std.state: {n: 0}
$in:
  $std.list:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
        n: ${i + 1}
    - ${x}${i}
```

結果は `[a10, b11]` である。
分岐 a での更新が分岐 b に見える。

```yaml
# 分岐点で分かれる: 各分岐が選択時点の状態を引き継ぎ、以後は独立に進む
$std.list:
  $std.state: {n: 0}
  $in:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
        n: ${i + 1}
    - ${x}${i}
```

結果は `[a10, b10]` である。
分岐前の更新（n を 10 にする）は両分岐に引き継がれ、分岐後の更新は互いに見えない。

```yaml
# 分岐ごとに初期化: 各分岐が初期値から作り直す
$std.list:
  $do:
  - $let:
      x: {$std.each: [a, b]}
  - $std.state: {n: 0}
    $in:
      $do:
      - $let:
          i: {$std.get: n}
      - $std.set:
          n: ${i + 1}
      - ${x}${i}
```

結果は `[a0, b0]` である。

貫流が ListT (State s) に、分岐点で分かれる形が StateT s [] に対応する。

## $in を欠いた $std.state

`$std.state` は `$in` を省いて、`$do` の文の位置と、データのキーを持つマッピングの前置きの位置に置ける。

```yaml
$std.state: 初期値
```

展開は次のとおりである。

```
{$do: [{$std.state: 初期値}, 残り...]} ≡ {$std.state: 初期値, $in: {$do: [残り...]}}
{$std.state: 初期値, キー: 値, ...}    ≡ {$std.state: 初期値, $in: {キー: 値, ...}}
```

二つ目は `$std.state` だけを前置きに持つ場合であり、他の前置きと並べたときの展開は [$do](do.md) が定める。
文でも前置きでもない位置に置いた `$in` なしの `$std.state` はエラーである。

「貫流」と「分岐点で分かれる」の区別は、この文の置き場所でも表現できる。
`$std.state` 文を `$std.list` を包む外側の `$do` に置けば貫流になり、`$std.list` の引数である内側の `$do` の先頭（選択より前）に置けば分岐点で分かれる。

```yaml
$do:
- $std.state: {i: 0}
- $std.list:
    $do:
    - $let:
        x: {$std.each: [a, b, c]}
    - $let:
        i: {$std.get: i}
    - $std.set:
        i: ${i + 1}
    - ${i}-${x}
```

```yaml
- 0-a
- 1-b
- 2-c
```

外側の `$do` に置いた `$std.state` 文が `$std.list` を包み、状態が分岐から分岐へ持ち越される。

前置きに置けば、状態のスコープはそのマッピングの中で閉じる。

```yaml
$do:
- $std.set: {n: 100}
- inner:
    $std.state: {n: 0}
    a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
    b: {$std.get: n}
  outer: {$std.get: n}
```

```yaml
inner:
  a: 1
  b: 1
outer: 100
```

`inner` の中の `std.set` と `std.get` は前置きが開いたセルに解決され、`outer` は外の状態を読む。

## 連番の採番

貫流を使った例である。

```yaml
$std.list:
  $do:
  - $std.set: {n: 0}
  - $let:
      name: {$std.each: [web, db, cache]}
      id: {$std.get: n}
  - $std.set:
      n: ${id + 1}
  - name: ${name}
    id: ${id}
```

```yaml
- name: web
  id: 0
- name: db
  id: 1
- name: cache
  id: 2
```

## fold と unfold

`$std.state` は `$collect` と組み合わせて、アキュムレータを伴う fold や、種と関数からの unfold を書くのに使う（[std.range](std.range.md) の用例を参照）。

## 関連

- [std.get](std.get.md)、[std.set](std.set.md)
- [std.list](std.list.md)
- [$handle](handle.md)、[$collect](collect.md)
- [$do](do.md)（`$in` を省いた形が展開する先、本体を欠いた二項形の一覧）
- [$let](let.md)（同じく `$in` を省いて文と前置きに置ける二項形）
