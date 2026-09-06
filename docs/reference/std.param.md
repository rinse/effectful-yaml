# std.param

`std.param` は起動時に与えられたパラメータを読む。

- 種別：標準演算
- 作用：パラメータ（reader モナドに対応する）
- 補助キー：`$default`

## 形

```yaml
{$std.param: 名前}
```

```yaml
$std.param: 名前
$default: 式
```

## 規則

- パラメータは文書の評価時に処理系へ渡され、既定ハンドラが供給する。
- 名前のパラメータが渡されていれば、その値になる。`$default` は評価されず、その中の作用も起きない（`$if` の選ばれない分岐と同じ遅延位置である）。
- 渡されていないとき、`$default` があればその値、なければ `std.fail` が境界まで伝播してエラーになる。
- 作用の推論は出現主義なので、`$default` の中の演算は評価されない場合でも作用シグネチャに数える。
- パラメータは読み出し専用なので、どの順序で読んでも結果は変わらない。
- `${}` の参照でパラメータは読めない。作用を起こす読み出しは演算として紙面に現れる、という原則による。

## 展開

`$default` はハンドラの語彙で説明できる。
`{$std.param: 名前, $default: 式}` は、`{$std.param: 名前}` を `std.fail` の節を持つ `$with` で包み、節が `$default` の式を返す形への展開と等価である。

```yaml
# {$std.param: 名前, $default: 式} の展開
$with:
  std.fail:
    $fn: _
    $body: 式
$in: {$std.param: 名前}
```

パラメータが渡されていないときの値が `$default` の式になり、`$default` を省いたときに `std.fail` がそのまま伝播するのはこの展開から従う。

## 例

`db_host: example.com` だけを渡して評価する。

```yaml
host: {$std.param: db_host}
port: {$std.param: db_port, $default: 5432}
```

```yaml
host: example.com
port: 5432
```

## 関連

- [std.get](std.get.md)（読み出し専用でない状態が必要なとき）
- [std.fail](std.fail.md)、[$with](with.md)（`$default` の展開が使う機構）
- [言語仕様の評価モデル](../grammar.md)（既定ハンドラ）
