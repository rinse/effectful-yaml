# std.first

`std.first` は本体の閉包を受け取り、選択と失敗を処理して、失敗しなかった最初の分岐の値に評価される。
バックトラック探索とフォールバックの連鎖に使う。

- 種別：std の関数（ハンドラを立てる）
- 処理する演算：`std.each` `std.fail`

## 形

```yaml
$handler: ${std.first}
$in: 本体の式
```

`$handler` の式が関数なら本体の閉包を渡す呼び出しに展開されるので、この形は `{$std.first: {$fn: 捨て名, $body: 本体}}` と同じ意味である（[$handler](handler.md) のハンドラの再利用）。

## 規則

- 分岐を文書順に試し、失敗も打ち切りもしなかった最初の分岐の値に評価される。
- 採用された分岐より後の分岐は評価されず、その作用も起きない。
- すべての分岐が失敗または打ち切りなら、全体が `std.fail` になる。
- 値は選ばれた一つの分岐のものであり、リストではない。全分岐が要るときは [std.list](std.list.md) を使う。
- 本体の `std.get` と `std.set` は処理しない。成功の印の持ち回りはローカル作用で行うので、本体の状態と衝突しない（下記）。

## 展開と関数による実装

`std.first` の値は次の関数である。
処理系は等価な組み込みで最適化してよいが、観測できる振る舞い（値、作用、ログの順序）はこの関数と一致しなければならない。
失敗の値の文言だけは組み込みと異なる。

展開は二段のハンドラからなる。
外側は成功の印を持ち回り、内側は選択と失敗を処理する。
印の持ち回りには、[std.state](std.state.md) の展開が `std.get` / `std.set` に対して行うのと同じ技法、すなわち各節が「現在の印を受け取り、次の印への適用を経て最終的な値を返す関数」を返すパラメータ付きハンドラを使う。
ただし `std.state` をそのまま流用することはできない。
本体（利用者の式）自身が `std.get` や `std.set` を使えば同じ記憶を共有してしまい、印が利用者の状態と衝突するからである。
そこで印は、[$handler](handler.md) のローカル作用の宣言で `taken`（印を読む）と `mark`（印を立てる）を宣言した独立のハンドラで持ち回る。
宣言が作る演算の値は宣言ごとに新しく、文書の他のどの演算とも別なので、本体の作用と衝突しない。

この印のハンドラは、選択を処理する内側の `$handler` を**包む**位置に置く。
`std.state` の「貫流」の配置（選択を状態のハンドラが包む形）と同じである。
包む順序が逆で選択の内側に印を置くと、各分岐がそれぞれ真新しい印を持つことになり、先行する分岐の成功が後続の分岐から見えなくなって、短絡（最初の成功より後を評価しない）が起きない。

```yaml
$let:
  first:
    $fn: run
    $body:
      $let:
        step:
          $handler:
            taken:
              $fn: _
              $body:
                $fn: t
                $body:
                  $let:
                    k:
                      $resume: ${t}
                  $in:
                    $.k: ${t}
            mark:
              $fn: _
              $body:
                $fn: t
                $body:
                  $let:
                    k:
                      $resume: null
                  $in:
                    $.k: true
            return:
              $fn: x
              $body:
                $fn: t
                $body: ${x}
          $in:
            $handler:
              std.each:
                $fn: xs
                $body:
                  $std.collect:
                    in: ${xs}
                    with:
                      $fn: x
                      $body:
                        $if: {$.taken: null}
                        $then: []
                        $else:
                          $resume: ${x}
              std.fail:
                $fn: _
                $body: []
              return:
                $fn: x
                $body:
                  $do:
                  - $.mark: null
                  - - ${x}
            $in: {$.run: null}
        results: {$.step: false}
      $in: ${results[0]}
$in:
  $handler: ${first}
  $do:
  - $for:
      v: [{$std.param: log_level, $default: null}, info]
  - $std.where: ${v != null}
  - ${v}
```

パラメータを何も渡さずに評価すると次になる。

```yaml
info
```

外側の `$handler` の節は、印 `t` を受け取って次の印へ渡す状態変換関数を返す。
`taken` は印をそのまま返して同じ印で続行し、`mark` は印を `true` に変えて続行し、`return` は印を捨てて値を通す。

内側の `$handler` が持つ節の役割は次のとおりである。

- **`std.each`**：`std.collect` で候補を先頭から回る。印が立っていれば、その候補では再開せず `[]` を返す（評価も作用も起きない）。印が立っていなければ、候補の値で `$resume` する。[std.where](std.where.md) の打ち切りは空の `$std.each` として現れ、この節が 0 個の候補を畳んで `[]` を返す。
- **`std.fail`**：ハンドラは深いので、`std.each` の分岐の途中で起きた失敗もこの節が受け止める。再開せず `[]` を返すので、失敗した分岐は候補の列に何も残さず、`std.collect` は次の候補へ進む。打ち切られた分岐と同じ扱いで消える。
- **`return`**：本体が演算を起こさず値 `x` に達したら、まず印を立ててから `x` を要素 1 のリストに包む。値に達する（＝成功する）ことと印を立てることを同じ場所で行うので、以後の `std.each` の候補はその成功を確実に見られる。

内側の `$handler` の値は、`std.list` の展開と同じ理由でリストになる。
`std.collect` 自体は候補の全要素を回るが、印が立った後の候補では `$resume` を呼ばないので、その候補に続く計算（残りの本体や、さらに後にある `std.each` の分岐）は評価されない。
外側のハンドラが返す状態変換関数を初期の印 `false` に適用したものが `results` であり、`$handler: ${std.first}` の値は `${results[0]}` である。
`${hits[0]}` が未初期化のセルでちょうど `std.fail` を起こす [std.state](std.state.md) の展開と同じ理由で、`results` が空リストのとき（＝すべての分岐が失敗または打ち切りだったとき）`${results[0]}` はちょうど `std.fail` を起こす。
この `std.fail` は二段のハンドラの外で起きるので、どちらの節も受け止めず、そのまま外側へ伝播する。

## 例

```yaml
log_level:
  $handler: ${std.first}
  $for:
    v: [{$std.param: log_level, $default: null}, {$std.param: fallback_log_level, $default: null}, info]
  $do:
  - $std.where: ${v != null}
  - ${v}
```

パラメータを何も渡さずに評価すると次になる。

```yaml
log_level: info
```

`std.first` が選択を処理するので、値はリストではなく、条件を満たした最初の分岐のものになる。
`std.lookup` の展開もこの形であり、キーの照合を選択で書いて最初の一致を採る。

## 関連

- [std.fail](std.fail.md)（失敗した分岐の扱い）
- [std.where](std.where.md)（打ち切られた分岐の扱い）
- [std.list](std.list.md)（全分岐が要るとき）
- [std.state](std.state.md)（印の持ち回りが使う技法）
- [std.lookup](std.lookup.md)（`std.first` を使う照会）
- [$handler](handler.md)、[std.collect](std.collect.md)（展開が使う機構）
