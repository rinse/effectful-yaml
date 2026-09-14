# std.state

`std.state` は初期値と本体の閉包を受け取り、状態のハンドラの下で本体を評価する。
状態作用の新しいスコープを作る形である。

- 種別：std の関数（ハンドラを立てる）
- 処理する演算：`std.get` `std.set`

## 形

```yaml
$handler:
  $std.state:
    セル名: 初期値
$in: 本体の式
```

`std.state` はカリー化されているので、`{$std.state: 初期値}` は初期値だけを与えた部分適用であり、本体の閉包を待つ関数になる。
`$handler` がその関数に本体の閉包を渡す（[$handler](handler.md) のハンドラの再利用）。

## 規則

- 本体の中の `std.get` と `std.set` は、最も近い状態のハンドラの記憶に解決される。セルごとに別のハンドラへ振り分けることはしない。
- 初期値のマッピングは空でもよい。セルは `std.set` で作れる。
- 値は本体の値である。最終状態は捨てられるので、要るなら本体の最後で `std.get` する。
- 初期値の式は本体より先に評価され、先に書いた頭の束縛を見る。
- 文書の最外には暗黙の `$handler: {$std.state: {}}` があり、これが状態の既定ハンドラである。境界にあるので文書内のどの選択のハンドラよりも外側であり、既定の状態は分岐をまたいで文書順に貫流する。
- `$in` を省いた `{$handler: {$std.state: 初期値}}` は、`$do` の文としても、マッピングのキーとしても置け、それを置いた並びの残りに状態を導入する（[言語仕様の文脈の導入の節](../grammar.md)）。

## 展開と関数による実装

`std.state` の値は次の関数である。
節は状態変換関数、すなわち「現在の状態を受け取り、次の状態への適用を経て最終的な値を返す関数」を返す古典的なパラメータ付きハンドラである。
状態はセルのエントリの列であり、`std.collect` はマッピングもエントリの列として回るので、初期値のマッピングをそのまま最初の状態にできる。

```yaml
$let:
  state:
    $fn: [init, run]
    $body:
      $let:
        step:
          $handler:
            std.get:
              $fn: name
              $body:
                $fn: s
                $body:
                  $let:
                    hits:
                      $std.collect:
                        in: ${s}
                        with:
                          $fn: e
                          $body:
                            $if: ${e.key == name}
                            $then:
                            - ${e.value}
                            $else: []
                    k:
                      $resume: ${hits[0]}
                  $in:
                    $.k: ${s}
            std.set:
              $fn: m
              $body:
                $fn: s
                $body:
                  $let:
                    s2:
                      $std.collect:
                        in:
                        - ${m}
                        - ${s}
                        with:
                          $fn: part
                          $body:
                            $std.collect:
                              in: ${part}
                              with:
                                $fn: e
                                $body:
                                - ${e}
                    k:
                      $resume: null
                  $in:
                    $.k: ${s2}
            return:
              $fn: x
              $body:
                $fn: s
                $body: ${x}
          $in: {$.run: null}
      $in:
        $.step: ${init}
$in:
  $handler: {$.state: {n: 40}}
  $do:
  - $let:
      n: {$std.get: n}
  - $std.set:
      n: ${n + 2}
  - $std.get: n
```

```yaml
42
```

- `std.set` の節は、書かれたマッピングのエントリを列の先頭に足す。
- `std.get` の節は名前の一致するエントリを先頭から集めるので、`${hits[0]}` は最新の値になり、セルが未初期化ならちょうど `std.fail` を起こす。パスをたどる参照が存在しない添字で `std.fail` を起こす規則がそのまま効いている。
- `$resume` の値は、残りの計算を処理し尽くした後の状態変換関数（`k`）である。`std.get` はこれを現在の状態に、`std.set` は更新後の状態に適用して続行する。
- `return` の段で状態を捨てるので、値は本体の値であり最終状態は現れない。
- 本体をこのハンドラで包んで得た関数 `step` を初期値に適用したものが全体の値である。
- 継続の再開結果の適用は関数値の流れの検査の依存に数えないので、この形は自己適用の検査を通る（[言語仕様](../grammar.md)の「関数値の流れと停止性」）。

## スコープの隔離

内側の状態のハンドラは、外の状態に触れない作業領域になる。

```yaml
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $handler: {$std.state: {n: 0}}
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

`$in` を省いてマッピングのキーに置けば、状態のスコープはそのマッピングの中で閉じる。

```yaml
$do:
- $std.set: {n: 100}
- inner:
    $handler: {$std.state: {n: 0}}
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

`inner` の中の `std.set` と `std.get` は導入されたセルに解決され、`outer` は外の状態を読む。

## 選択との関係

状態のハンドラを選択に対してどこに置くかで、状態と分岐の関係が決まる。
覚え方は「ハンドラは自分より内側だけを見る」である。
状態が選択を包めば分岐をまたぎ（貫流）、選択に包まれれば分岐ごとになる（分岐点で分かれる）。

```yaml
# 貫流（既定と同じ）: 状態が分岐から分岐へ持ち越される
$handler: {$std.state: {n: 0}}
$in:
  $handler: ${std.list}
  $do:
  - $std.set: {n: 10}
  - $for:
      x: [a, b]
  - $let:
      i: {$std.get: n}
  - $std.set:
      n: ${i + 1}
  - ${x}${i}
```

結果は `[a10, b11]` である。
分岐 a での更新が分岐 b に見える。

```yaml
# 分岐点で分かれる: 各分岐が選択時点の状態を引き継ぎ、以後は独立に進む
$handler: ${std.list}
$in:
  $handler: {$std.state: {n: 0}}
  $do:
  - $std.set: {n: 10}
  - $for:
      x: [a, b]
  - $let:
      i: {$std.get: n}
  - $std.set:
      n: ${i + 1}
  - ${x}${i}
```

結果は `[a10, b10]` である。
分岐前の更新（n を 10 にする）は両分岐に引き継がれ、分岐後の更新は互いに見えない。

```yaml
# 分岐ごとに初期化: 各分岐が初期値から作り直す
$do:
- $handler: ${std.list}
- $for:
    x: [a, b]
- $handler: {$std.state: {n: 0}}
- $let:
    i: {$std.get: n}
- $std.set:
    n: ${i + 1}
- ${x}${i}
```

結果は `[a0, b0]` である。
文に置いた状態のハンドラは選択より後にあるので、分岐ごとに立て直される。

貫流が ListT (State s) に、分岐点で分かれる形が StateT s [] に対応する。

この区別は、`$in` を省いたハンドラをどの `$do` の文に置くかでも表現できる。
選択のハンドラを包む `$do` に置けば貫流になり、選択のハンドラの中の `$do` に置けば分岐点で分かれる。

```yaml
$do:
- $handler: {$std.state: {i: 0}}
- $handler: ${std.list}
- $for:
    x: [a, b, c]
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

先に文脈を導入した状態のハンドラが選択のハンドラを包み、状態が分岐から分岐へ持ち越される。

## 連番の採番

貫流を使った例である。
既定の状態ハンドラは境界にあり、選択のハンドラより外側なので、明示のハンドラを立てなくても貫流する。

```yaml
$handler: ${std.list}
$do:
- $std.set: {n: 0}
- $for:
    name: [web, db, cache]
- $let:
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

`id` の束縛は `name` の選択より後にあるから、分岐ごとに読み直される。
二つの文を入れ替えると読み出しは分岐の前に一度だけ実行され、全分岐の `id` が 0 になる。

## fold と unfold

状態のハンドラは [std.collect](std.collect.md) と組み合わせて、アキュムレータを伴う fold や、種と関数からの unfold を書くのに使う（[std.range](std.range.md) の用例を参照）。

## 関連

- [std.get](std.get.md)、[std.set](std.set.md)
- [std.list](std.list.md)（選択と状態の関係）
- [$handler](handler.md)、[std.collect](std.collect.md)（展開が使う機構）
- [$do](do.md)（`$in` を省いたハンドラを置ける文の位置）
- [言語仕様の文脈の導入の節](../grammar.md)
