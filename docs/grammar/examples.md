# 用例

## 設定に文脈を足す

```yaml
$let:
  registry: ghcr.io/acme
  env: {$std.param: env, $default: dev}
name: api
image: ${registry}/api:${env}
replicas:
  $if: ${env == 'prod'}
  $then: 3
  $else: 1
```

パラメータを渡さずに評価すると次になる。

```yaml
name: api
image: ghcr.io/acme/api:dev
replicas: 1
```

素の YAML の設定に、文脈を導入する `$let` を足した形であり、データのキーは動かない。
導入された束縛は、残りから参照できる。

## パラメータと条件分岐

```yaml
server:
  host: {$std.param: db_host}
  port: {$std.param: db_port, $default: 5432}
  tls:
    $if: {$std.param: use_tls}
    $then:
      cert: /etc/ssl/cert.pem
    $else: null
```

`db_host: example.com` と `use_tls: false` を渡して評価すると次になる。

```yaml
server:
  host: example.com
  port: 5432
  tls: null
```

三つの境界は互いに独立であり、パラメータは読み出し専用なので、評価順序は結果に影響しない。

## 選択の基本形

```yaml
$handler: ${std.list}
$for:
  x: [a, b, c]
  y: [x, y, z]
$in:
  $std.each:
  - ${x}
  - ${y}
```

```yaml
[a, x, a, y, a, z, b, x, b, y, b, z, c, x, c, y, c, z]
```

`std.list` が全分岐の結果を文書順に並べる。
`$in` の本体も選択なので、分岐は 3 × 3 × 2 の 18 本ある。

`$in` の本体を literal なリストに変えると、意味が「2 つの結果を選ぶ」から「2 要素のリストを返す」に変わる。

```yaml
$handler: ${std.list}
$for:
  x: [a, b, c]
  y: [x, y, z]
$in:
- ${x}
- ${y}
```

```yaml
[[a, x], [a, y], [a, z], [b, x], [b, y], [b, z], [c, x], [c, y], [c, z]]
```

この 2 例の対比が「リストは常にデータ、選択は `$std.each`」という原則の眼目である。

## 打ち切りつきの選択

```yaml
$do:
- $handler: ${std.list}
- $for:
    x: [1, 2, 3]
    y: [1, 2, 3]
- $std.where: ${x < y}
- - ${x}
  - ${y}
```

```yaml
[[1, 2], [1, 3], [2, 3]]
```

リスト内包表記に相当する形である。
文に置いた `$handler` と `$for` が残りの文に文脈を導入し、`$std.where` が条件を満たさない分岐を打ち切る。

## 選択の束縛

形ごとのレーベルの列を、レーベルごとの形に組み替える。

```yaml
$let:
  forms:
    "a{id}": [x, y]
    "b{id}": [z]
$handler: ${std.mapping}
$for:
  entry: ${forms}
  label: ${entry.value}
key: ${label}
value:
  id: ${entry.key}
```

```yaml
x:
  id: a{id}
y:
  id: a{id}
z:
  id: b{id}
```

`entry` はマッピングのエントリを、`label` はそのエントリの値のリストの要素を選ぶ。
後の束縛の右辺から先の束縛が見えるので、二段の選択が入れ子の反復になる。
`std.mapping` が全分岐の `{key, value}` を集め直す。
途中に `$std.where` を挟めば、条件を満たすエントリだけを残せる。

## 分岐を貫く状態

```yaml
$do:
- $handler: ${std.list}
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

状態の既定ハンドラは境界にあり、`std.list` より外側なので、セル `n` は分岐をまたいで貫流し、連番が振られる。
`id` の束縛は `name` の束縛より後、すなわち選択より後にあるから、分岐ごとに読み直される。
二つの文を入れ替えると読み出しは分岐の前に一度だけ実行され、全分岐の `id` が 0 になる。

## 欠落するデータの除外

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

2 行目には `code` が無いので、照会が `std.fail` を起こし、`$default` の `{$std.where: false}` がそれを分岐の打ち切りに変える。
失敗を null で埋めたいときは `$default: null` と書く。

## 最初に成功する分岐

```yaml
log_level:
  $handler: ${std.first}
  $for:
    v: [{$std.param: log_level, $default: null}, {$std.param: fallback_log_level, $default: null}, info]
  $do:
  - $std.where: ${v != null}
  - ${v}
```

`std.first` が選択を処理するので、値はリストではなく、条件を満たした最初の分岐のものになる。
パラメータが一つも渡されていなければ `info` になる。

## 回数つきの unfold

```yaml
$handler: {$std.state: {acc: 1}}
$in:
  $std.collect:
    in: {$std.range: 5}
    with:
      $fn: _
      $body:
        $do:
        - $let:
            v: {$std.get: acc}
        - $std.set:
            acc: ${v * 2}
        - - ${v}
```

```yaml
[1, 2, 4, 8, 16]
```

種 1 と関数 (*2) から先頭 5 要素を生成する。
`std.range` が回数をリストに変え、`std.collect` が回り、`std.state` が種を持ち回る。
アキュムレータを伴う fold も同じ組み合わせで書ける。

## 関数の部分適用

表を固定した照会関数を作り、キーの各分岐に適用する。

```yaml
$handler: ${std.list}
$let:
  codes: {ja: 81, us: 1}
  look:
    $fn: [m, k]
    $body:
      $std.lookup:
        in: ${m}
        key: ${k}
  dial:
    $.look: ${codes}
$for:
  c: [ja, us]
$in:
  $.dial: ${c}
```

```yaml
- 81
- 1
```

マッピング引数の関数は、引数を組み立てるカリー化された関数を一度宣言すれば部分適用できる。
部分適用 `{$.look: 表}` の引数はその位置で一度だけ評価され、閉包に捕まる。
返った閉包 `dial` は残りの引数 `k` を待つ普通の関数値であり、`std.collect` の `with` にもそのまま置ける。

## 失敗の捕捉

```yaml
port:
  $handler:
    std.fail:
      $fn: msg
      $body:
        $do:
        - $std.log: ${msg}
        - 5432
  $let:
    p: {$std.param: port, $default: 0}
  $if: ${p <= 0 || p > 65535}
  $then:
    $std.fail: invalid port ${p}
  $else: ${p}
```

節が `$resume` を呼ばないので、失敗した時点で本体は打ち切られ、節の値 5432 がハンドラ全体の値になる。

節が `$resume` で再開すれば、失敗した位置から本体が続く。

```yaml
database:
  $handler:
    std.fail: {$fn: _, $body: {$resume: null}}
  host: {$std.param: db_host}
  port: {$std.param: db_port}
```

`db_host: db` を渡して評価すると次になる。

```yaml
database:
  host: db
  port: null
```

マッピングの中の未渡しのパラメータがそれぞれ null になる。

## 引数で調整するハンドラ

```yaml
$let:
  orElse:
    $fn: [d, run]
    $body:
      $handler:
        std.fail: {$fn: _, $body: "${d}"}
      $in: {$.run: null}
$in:
  a:
    $handler: {$.orElse: 0}
    $in: {$std.lookup: {in: {}, key: missing}}
  b:
    $handler: {$.orElse: 0}
    $in: 7
```

```yaml
a: 0
b: 7
```

`orElse` は既定値と本体の閉包をとるカリー化された関数である。
`{$.orElse: 0}` の部分適用が本体の閉包を待つ関数になり、`$handler` がそれに本体を渡す。
節の本体は定義位置の束縛を捕まえるので、引数 `d` が節から見える。

## 残りが主形

```yaml
$handler: ${std.list}
$for:
  i0: {$std.range: 15}
$let:
  i: ${i0 + 1}
$if: ${i % 15 == 0}
$then: fizzbuzz
$else:
  $if: ${i % 3 == 0}
  $then: fizz
  $else:
    $if: ${i % 5 == 0}
    $then: buzz
    $else: "${i}"
```

```yaml
[1, 2, fizz, 4, buzz, fizz, 7, 8, fizz, buzz, 11, fizz, 13, 14, fizzbuzz]
```

`$handler` の直下で `$for` と `$let` が文脈を導入し、残りが `$if` の主形なので、束縛は分岐から見える。

## 引数で受けた演算の処理

```yaml
$let:
  run:
    $fn: sig
    $body:
      $handler:
        .sig:
          $fn: _
          $body: handled
      $in: {$.sig: null}
  outer:
    $handler:
      signal:
        $fn: _
        $body: unreachable
    $in: ${signal}
$in:
  $.run: ${outer}
```

```yaml
handled
```

`outer` は宣言した演算の値をハンドラの外へ持ち出している。
値の持ち出しは誤りではなく、`run` の `$handler` が節の名前 `.sig` で引数の演算に解決し、呼び出しを処理する。

---

［[言語仕様](index.md)］　前: [キーの順序](order.md)
