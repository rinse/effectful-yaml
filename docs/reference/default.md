# $default

`$default` は、どの `$` 式にも添えられる補助キーである。
本体が `std.fail` を起こしたとき、その式の値を代わりにする。

- 種別：導出形（補助キー）
- 処理する演算：`std.fail`

## 構文

```yaml
$std.input: 名前
$default: 式
```

```yaml
$std.lookup: {in: マッピングの式, key: キーの式}
$default: 式
```

## 展開

意味は次の展開で定める。
節は引数を受け取らない（`$param` を省いた 0 引数の形である）。

```
{X ∪ {$default: 式}} ≡ {$handler: {std.fail: {$fn: 式}}, $in: X}
```

`$default` を除いた残り X が `$` 式全体である。
節が `$resume` を呼ばずに式へ達するので、失敗した時点で本体は打ち切られ、既定値がハンドラ全体の値になる。

## 規則

- 添えられるのは `$` 式、すなわち `$` で始まるキーを持つマッピングである。`$` 式の形の判定は `$default` を除いてから行うので、主形にも文脈の導入を伴うマッピングにも添えられる。後者では、頭と本体をまとめて包む。
- スカラーには添えられない。`${spec.pre}` のような参照の欠落を既定値で埋めるには、そのスカラーを一文の [$do](do.md) に包んで `$` 式にする（`{$do: ["${spec.pre}"], $default: ''}`）か、`std.lookup` で引くか、[$let](let.md) で束縛してその文脈の導入を伴うマッピングに添える（下の例）。
- 捕捉するのは `std.fail` だけである。渡されていない入力、欠落したキーと添字、未初期化のセルの読み出し、失敗を通知したホストの値の呼び出しは、いずれもこの作用なので一律に埋められる。選択や状態は捕捉しない。
- `$default` は遅延位置である。本体が失敗しなければ評価されず、その中の作用も起きない（`$if` の選ばれない分岐と同じ）。
- 作用の推論は出現主義なので、評価されない場合でも `$default` の中の演算は作用集合に数える。展開のとおり、本体の `std.fail` は除かれ、既定値の式の作用が加わる。
- 既定値の式は展開により `std.fail` の節の本体なので、そこに書いた `$resume` は失敗した位置から本体を再開する（`$default: {$resume: null}` は失敗を null で埋めて続行する）。
- 既定値は値を返す式に限らず、作用を起こす式でもよい。節の本体が起こす作用はこの `$handler` 自身ではなく外側で処理される（[$handler](handler.md) の規則）。
- 既定値を null にしたいときは `$default: null` と明示する。「暗黙の null を作らない」原則により、`$default` を省いた失敗はそのまま伝播する。

## 失敗した分岐を選択から外す定型

```yaml
$std.lookup: {in: "${row}", key: code}
$default: {$std.where: false}
```

展開では `$default` の式が `std.fail` の節の本体になるので、その打ち切り（`std.where` が起こす `std.each`）は外側で処理され、包囲する選択の分岐ごと打ち切られる。
失敗しうる式を要素とみなして選択に流し込むときの標準形であり、欠落したキーを持つデータを黙って除外する用途に使う。
打ち切りは選択なので、この形は選択のハンドラの内側で使う。

## 関数による実装

`$default` に対応する関数は、既定値と本体をそれぞれ閉包で受け取るハンドラである。
既定値は失敗したときだけ評価される遅延位置なので、既定値もサンクで渡す。
既定値を先に与えた部分適用が、その既定値を持つハンドラにあたる。

```yaml
$let:
  orElse:
    $param: [d, run]
    $fn:
      $handler:
        std.fail:
          $fn: {$.d: null}
      $in: {$.run: null}
$in:
  $handler: {$.orElse: {$fn: 5432}}
  $in: {$std.input: db_port}
```

入力を何も渡さずに評価すると次になる。

```yaml
5432
```

既定値を素の値で受け取る関数（`{$param: [d, run], $fn: {$handler: {std.fail: {$fn: "${d}"}}, $in: {$.run: null}}}`）も書けるが、そちらは既定値が本体より先に一度だけ評価されるので、`$default` の遅延位置とは振る舞いが異なる。

## 例

渡されていない入力を既定値で埋める。

```yaml
host: {$std.input: db_host}
port: {$std.input: db_port, $default: 5432}
```

`db_host: example.com` だけを渡して評価する。

```yaml
host: example.com
port: 5432
```

欠落したキーを持つ行を、選択から黙って外す。

```yaml
$handler: ${std.list}
$for:
  row:
  - {date: d1, code: c1}
  - {date: d2}
  - {date: d3, code: c3}
date: ${row.date}
code:
  $std.lookup: {in: "${row}", key: code}
  $default: {$std.where: false}
```

```yaml
- {date: d1, code: c1}
- {date: d3, code: c3}
```

2 行目には `code` が無いので照会が `std.fail` を起こし、`{$std.where: false}` がそれを分岐の打ち切りに変える。
`$default: null` に替えれば、2 行目は `{date: d2, code: null}` として残る。

参照の欠落を埋めるには、スカラーを一文の `$do` に包む。

```yaml
$let:
  spec: {}
pre:
  $do: ["${spec.pre}"]
  $default: ''
```

```yaml
pre: ''
```

`spec` に `pre` が無いので、パスアクセス `${spec.pre}` が `std.fail` を起こし、`$default` がそれを空文字列に置き換える。
`$let` で束縛してその文脈の導入を伴うマッピングに添えても同じである（`{$let: {p: "${spec.pre}"}, $in: "${p}", $default: ''}`）。

## 関連

- [$handler](handler.md)（展開先。`std.fail` 以外の演算を捕まえたいとき）
- [std.fail](std.fail.md)（捕捉する作用）
- [std.input](std.input.md)、[std.lookup](std.lookup.md)、[std.get](std.get.md)（`$default` で埋められる失敗の出所）
- [std.where](std.where.md)（`$default: {$std.where: false}` の定型）
- [$if](if.md)（もう一つの遅延位置）
