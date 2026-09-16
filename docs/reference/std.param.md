# std.param

`std.param` は起動時に与えられたパラメータを読む。

- 種別：std の演算
- 作用：パラメータ（reader モナドに対応する）

## 形

```yaml
{$std.param: 名前}
```

```yaml
$std.param: 名前
$default: 式
```

## 規則

- 引数は名前の文字列である。パラメータは文書の評価時に処理系へ渡され、既定ハンドラが供給する。
- 名前のパラメータが渡されていれば、その値になる。
- 渡されていないときは、呼び出し位置で `std.fail` を起こす。捕捉されなければ境界で文書全体のエラーになる。
- 既定値を添えるには補助キー [$default](default.md) を使う。`$default` は遅延位置であり、パラメータが渡されていれば評価されず、その中の作用も起きない。
- パラメータは読み出し専用なので、どの順序で読んでも結果は変わらない。パラメータだけを読む複数の作用境界は互いに独立である。
- `${}` の参照でパラメータは読めない。作用を起こす読み出しは演算として紙面に現れる、という原則による。

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

- [$default](default.md)（既定値の補助キーと、その展開）
- [std.get](std.get.md)（読み出し専用でない状態が必要なとき）
- [std.fail](std.fail.md)、[$handler](handler.md)（未渡しの読み出しが起こす作用と、その捕捉）
- [言語仕様の既定ハンドラの節](../grammar/effects.md)
