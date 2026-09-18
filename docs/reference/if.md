# $if

`$if` は条件の値に応じて二つの式の一方だけを評価する。

- 種別：カーネル構文（分岐。作用を持たない）
- 補助キー：`$then` `$else`

## 構文

```yaml
$if: 条件式
$then: 式
$else: 式
```

## 規則

- 条件の値が真なら `$then` を、偽なら `$else` を評価する。評価されるのは一方だけである。
- `$else` は省略できない。「暗黙の null を作らない」原則による。
- 条件は真偽値でなければならない。真偽値への暗黙の変換は行わない。条件には呼び出しも書ける（`$if: {$std.input: use_tls}`）。
- データの位置にも `$do` の文としても書ける。
- 作用の推論は出現主義なので、実行されない側の分岐の演算も作用シグネチャに数える。ただし実際に起きる作用は選ばれた側のものだけであり、`$then` にだけ選択が現れる `$if` は、`$else` 側が選ばれれば選択を起こさない。

## 例

```yaml
tls:
  $if: {$std.input: use_tls}
  $then:
    cert: /etc/ssl/cert.pem
  $else: null
```

`use_tls: false` を渡して評価する。

```yaml
tls: null
```

## 関連

- [std.where](std.where.md)（分岐でなく打ち切りが必要なとき）
- [$default](default.md)（失敗したときだけ評価される、もう一つの遅延位置）
- [std.input](std.input.md)
