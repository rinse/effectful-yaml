# $handler

`$handler` はハンドラを立てるカーネル構文である。
頭のキー `$handler` に節を書き、その下で `$in` の本体を評価する。
ハンドラは値の種類ではない。
再利用するハンドラは、本体の閉包を受け取る関数として書き、その関数の式を `$handler` に置く。

- 種別：カーネル構文（ハンドラ）
- 処理する作用：節に挙げた演算
- 補助キー：`$in`（本体）、`$resume`（節の本体でだけ書ける）

## 構文

節のマッピングを書く形。

```yaml
$handler:
  演算名:
    $fn: 引数名
    $body: 節の本体
  return:
    $fn: 値名
    $body: 式
$in: 本体の式
```

関数の式を書く形。

```yaml
$handler: 関数の式
$in: 本体の式
```

`$in` を省いて頭だけを書いた `{$handler: 式}` は、それを置いた並びの残りにハンドラを導入する（[言語仕様の文脈の導入の節](../grammar/derived.md)）。

## 値の判別

`$handler` の値は書き方で二つに分かれ、解決の優先順位のような暗黙の規則を持たない。

| `$handler` の値 | 読み |
|---|---|
| `$` で始まるキーを持たないマッピング | literal な節のマッピング。キーが節の名前、値が節の関数である |
| それ以外（`${std.list}` のような参照、`{$std.state: {n: 0}}` のような `$` 式） | 式として評価し、本体の閉包を受け取る関数を得る |

節のマッピングだけがローカル作用を宣言でき、節の本体だけが `$resume` を書ける。
関数の式で与えたハンドラは、宣言も `$resume` も持たない。

## 節のマッピング

### 節名

節の名前は `$handler` の位置の環境で解決する。

| 節の名前 | 意味 |
|---|---|
| `return` | return 節 |
| ドットを含む名前（`std.each`、`vault.read`） | パスとして解決した演算の節 |
| 先頭がドットの名前（`.sig`） | 一区画のパスとして解決した演算の節（束縛 `sig` の値） |
| ドットを含まない名前（`throw`） | ローカル作用の宣言（下記） |

- 解決先が演算でなければエラーである。節の値は一引数の関数でなければならない。
- 捕捉の単位は作用ではなく演算である。`std.get` だけを捕まえて `std.set` を素通しにすることもできる。節に書かなかった演算は外側のハンドラへ抜ける。
- 言語が裸の名前の空間に予約する節名は `return` ただ一つである。`return` は束縛を導入しないので、`$.return` の形の呼び出しは決して解決せず、その出現は評価前に `return is reserved: $.return is not callable` で拒まれる（[$fn](fn.md)）。

### 節の起動

- 本体の中で、節を持つ演算が呼ばれると、対応する節が演算の引数を受け取って評価される。
- 節の本体では `{$resume: 値}` で継続を再開できる。その値は、演算の呼び出し位置に「値」を返して残りの計算（`return` 節を含む）を進めた結果である。一度も呼ばない（打ち切り）ことも、複数回呼ぶことも許される。
- 節が `$resume` を呼ばずに値に達したときは、演算を呼んだ計算の残りは行われず、その値がその節の起動の値になる（打ち切り）。起動が本体から直接起きたのなら、それがハンドラ全体の値である。別の節が呼んだ `$resume` の継続の中で起きたのなら、それがその `$resume` の値であり、呼んだ節の本体はそこから続く（[std.first](std.first.md) の展開はこの規則で失敗した分岐を飛ばす）。
- ハンドラは深い。再開後の計算にも同じハンドラが効き続ける。
- 節の本体が起こす作用は、このハンドラ自身ではなく外側で処理される。演算を加工して呼び直す転送（下記のログの計装）がこの規則で書ける。
- `return` 節は、本体が演算を起こさず値に達したときにその値を変換する。省略時は恒等である。
- 作用の推論では、節が挙げた演算が集合から除かれ、節と `return` の本体の作用が加わる。

### $resume を書ける位置

`$resume` を書けるのは、literal な節のマッピングの節の本体の中だけである。
節の本体に書いた `$fn` の本体も含み、その閉包が捕まえるのはその節の起動に対応する継続である。
それ以外の位置（`return` 節、ハンドラの本体、`$handler` の外にある関数の本体）に書いた `$resume` は構文の誤りであり、評価前に拒まれる。

範囲は字句で決まるので、節の本体の中に入れ子にした `$handler` の本体と `return` 節からは、外側の節の継続が見える。
[$default](default.md) の式は展開により `std.fail` の節の本体なので、そこに書いた `$resume` は失敗した位置から本体を再開する。

この位置の規則は構文で決まるので、ハンドラとして振る舞う関数の本体であっても、literal な節の外では `$resume` を書けない。
継続を再開する処理は節に書き、関数はその節を持つ `$handler` を包む形にする（下記のハンドラの再利用）。

閉包から `$resume` を呼べる規則は、`std.collect` に渡す関数の中から継続を再開する書き方を可能にする。
[std.list](std.list.md) の値がその具体例であり、`std.each` の節が候補の列を `std.collect` で回り、その関数の本体で `$resume: ${x}` を呼ぶ。

## ハンドラの再利用

再利用するハンドラは、本体の閉包を受け取る関数として書く。
`$handler` の値が節のマッピングでなければ、意味は次の展開で定まる。
内部名と捨て名は処理系内部の名前であり、文書から参照できない。

```
{$handler: 関数の式, $in: 本体} ≡ {$let: {内部名: 関数の式}, $in: {$.内部名: {$fn: 捨て名, $body: 本体}}}
```

```yaml
$let:
  fallback:
    $fn: run
    $body:
      $handler:
        std.fail: {$fn: _, $body: 0}
      $in: {$.run: null}
$in:
  a:
    $handler: ${fallback}
    $in: {$std.lookup: {in: {}, key: missing}}
  b:
    $handler: ${fallback}
    $in: 7
```

```yaml
a: 0
b: 7
```

- 本体を閉包で渡すのは、呼び出しが値渡しだからである。`{$.fallback: 本体}` と書けば本体の作用は引数の評価で周囲へ合流し、`fallback` の節には届かない。`$handler` と `$in` はカーネルにある唯一の遅延位置であり、本体の閉包化はここで済む。
- `std.list`・`std.mapping`・`std.first`・`std.state` の値はこの形の関数である。`$handler: ${std.list}` と `{$std.list: {$fn: 捨て名, $body: 本体}}` は同じ意味である。
- 引数で節を調整するハンドラは、カリー化した関数で書き、`$handler: {$.orElse: 0}` のように部分適用の呼び出しを式に置く。節の本体は定義位置の束縛を捕まえるので、引数が節から見える。
- 関数値の流れの検査は、本体の閉包を受け取る関数を、その閉包の本体の中で再び使う形を自己適用として拒む。入れ子にしたいときは、`$let` で値を二つ作るか、内側を literal な節で書く。`std` の関数はホストの値であり `$fn` ではないので、`std.list` の中に `std.list` を重ねることはこの制限を受けない。

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

## ローカル作用の宣言

節のマッピングのキーのうち、ドットを含まない名前（`return` を除く）は、そのハンドラだけが処理するローカルな作用を宣言する。

```yaml
$handler:
  throw: 節
$in: 本体
```

宣言は、`$handler` を評価するたびに新しい演算の値を作り、その節を置き、本体に名前を束縛する。
本体は `{$.throw: 引数}` でその演算を呼び、節が引数を受け取る。
`$let` が値を束縛して `$.名前` で呼ぶのと同じ読み方が `$handler` にも通るので、利用者は名前空間を書かずに自分の作用を宣言できる。
名前空間つきの演算が要るのは、std とホストと文書間の約束、すなわち外の世界が関与する場所だけである。

- 宣言は節のマッピングのキーとしてだけ書ける。束縛の導入は構文の仕事であり、値は束縛を導入できない。
- 束縛が見えるのは本体だけである。同じ `$handler` の節の本体、`return` 節、ハンドラの外側からは見えない。`$in` を省いた `$handler` では、残りが本体にあたり、束縛はそこから見える（[$let](let.md) と同じスコープ規則）。
- 演算の値は宣言ごとに、評価のたびに作られる。別のハンドラが同じ `throw` を宣言していても値は別なので、束縛を経た呼び出しは必ず宣言元のハンドラに届き、偶然の捕捉は起こらない。同じ `$handler` が二度評価されれば、二つの起動は別の演算を持つ。
- 束縛は普通の束縛である。再束縛で隠せるし、`${throw}` で参照して別名を付けられるし、値として文書の外に残せば脱出のエラーになる。
- 宣言した演算をハンドラの外へ持ち出し、別の `$handler` で処理してよい。そのハンドラの節の名前は `.throw` のように書き、束縛を経て同じ演算に解決する。
- 名前空間つきの節や `return` との混在も、一つの `$handler` に複数の宣言を書くことも許される。
- どのハンドラにも捕まらずに境界へ達したローカル作用は、`local effect 'throw' escaped its handler (declared at 宣言位置)` のエラーになる。宣言位置は、宣言を書いた `$handler` の構文パスである。

```yaml
$handler:
  throw:
    $fn: msg
    $body: caught ${msg}
$in:
  $do:
  - {$.throw: boom}
  - never
```

```yaml
caught boom
```

節が `$resume` を呼ばないので、`$.throw` の呼び出しで本体が打ち切られ、節の値がハンドラ全体の値になる。
`std.fail` の節を持つ `$handler` と同じ形を、名前空間を持たない自前の作用で書いたものである。

入れ子のハンドラが同じ名前を宣言しても、演算の値が別なので取り違えは起こらない。

```yaml
$handler:
  throw:
    $fn: m
    $body:
      $resume: outer ${m}
$in:
  $do:
  - $let:
      up: ${throw}
  - $handler:
      throw:
        $fn: m
        $body:
          $resume: inner ${m}
    a: {$.throw: x}
    b: {$.up: y}
```

```yaml
a: inner x
b: outer y
```

内側の本体で `$.throw` が指すのは内側の宣言なので、`a` は内側の節が受ける。
`up` は外側の宣言が束縛した演算の別名であり、内側のハンドラの中で呼んでも別の演算なので、内側の節を素通しして外側の節に届く。

引数で受け取った演算は、節の名前を `.名前` と書いて処理する。

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

## 入れ子

ハンドラを重ねるには、`$in` を省いた `$handler` を `$do` の文に並べる。
先に文脈を導入した `$handler` ほど外側になる。

```yaml
$do:
- $handler: {$std.state: {n: 0}}
- $handler: ${std.list}
- $for:
    name: [web, db]
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
```

状態のハンドラが選択のハンドラを包むので、セル `n` は分岐をまたいで貫流する。
二つの文を入れ替えれば、各分岐が選択時点の状態を引き継いで独立に進む（[std.state](std.state.md) の選択との関係）。

## 例

失敗を捕捉し、ログを流して既定値に置き換える。

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

`port` を渡さずに評価すると次になり、ログに `invalid port 0` が流れる。

```yaml
port: 5432
```

節が `$resume` を呼ばないので、失敗した時点で本体は打ち切られ、節の値がハンドラ全体の値になる。

マッピングのキーに置けば、残りが本体になる。

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

節が `$resume: null` で再開するので、マッピングの中の未渡しのパラメータがそれぞれ null になる。

演算を加工して呼び直す転送の形である。
節の本体で起こした `std.log` は自分では捕まらず、外側で処理される。

```yaml
$handler:
  std.log:
    $fn: msg
    $body:
      $do:
      - $std.log: 'app: ${msg}'
      - {$resume: null}
$do:
- $std.log: hello
- 42
```

結果は `42` で、外のログには `app: hello` が流れる。
`std.log` の値は null なので、null で再開している。

## 関連

- [$default](default.md)（`std.fail` の節ひとつを持つ `$handler` への展開で定まる補助キー）
- [std.list](std.list.md)、[std.mapping](std.mapping.md)、[std.first](std.first.md)、[std.state](std.state.md)（本体の閉包を受け取る std の関数）
- [std.fail](std.fail.md)、[std.log](std.log.md)、[std.each](std.each.md)
- [$fn](fn.md)（閉包と呼び出し）
- [$do](do.md)（`$in` を省いた `$handler` を置ける文の位置）
- [$let](let.md)、[$for](for.md)（同じく `$in` を省いて文脈を導入できる形）
- [言語仕様の $handler の節](../grammar/syntax.md)
