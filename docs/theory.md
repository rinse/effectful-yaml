# 理論的背景

本書は規範ではない。
文法と評価モデルの規範は[言語仕様](grammar.md)である。
本書は、effectful-yaml の直接スタイルがどのような意味論に支えられているかを、Moggi の計算のラムダ計算（λc）、Haskell の do 記法、Koka の直接スタイルとの対応で説明する。
設計の判断としての記録は[設計の経緯](history.md)にあり、本書はその背景を敷衍する。

この言語は `>>=` や `pure` を書かせるモナディックスタイルではなく、演算を直接呼び出す Koka 風の直接スタイルを採る。
モナドは意味論にのみ現れて紙面には現れない。
名前が monadic-yaml ではなく effectful-yaml であるのはこのためである。
以下では、この「意味論にのみ現れる」の正確な意味を λc の言葉で述べる。

## Moggi の λc

### 構文

Moggi の計算のラムダ計算（λc）の構文は、let を持つ普通のラムダ計算である。

```
e ::= x | λx.e | e1 e2 | let x = e1 in e2 | 定数・演算
```

重要なのはここに無いものである。
型にも項にも `T`（モナド）、`return`、`>>=` は現れない。
型は `A → B` のような普通の型で、判断 `x:A ⊢ e:B` も普通の形をしている。
作用は暗黙であり、すべての項が計算でありうる。
書き手から見れば λc は直接スタイルの言語そのものである。

### 等式理論

普通のラムダ計算と違うのは等式理論だけである。
β 簡約は値に制限され（βv）、代わりに let の律が公理になる。

1. `let x = v in e ≡ e[v/x]`（v は値）
2. `let x = e in x ≡ e`
3. `let x2 = (let x1 = e1 in e2) in e3 ≡ let x1 = e1 in let x2 = e2 in e3`（x1 は e3 に自由に現れない）

### メタ言語への翻訳

Moggi はもう一つの体系として、モナドが型に明示的に現れるメタ言語 λml（型 `T A`、`return`、bind を持つ）を与え、λc から λml への値渡し（CBV）翻訳 (−)\* を定めた。

- 判断 `x:A ⊢ e:B` の項は Kleisli 射 `A → T B` として解釈される。
- `(let x = e1 in e2)* = e1* >>= λx. e2*`。let がそのまま bind である。
- 値 `v` の翻訳には `return` が暗黙に挿入される。
- 関数型は `(A → B)* = A* → T B*` に翻訳される。呼び出しの作用は本体の型に現れる。

先行する束縛を後続の計算に持ち回すため、この解釈にはモナドの強度（strength）が要る。

### 同じ構文の二つの射影

λc の一つの項言語には、二つの解釈が与えられる。
第一は恒等な読みであり、項を「e1 を評価し、結果を x に束縛して e2 に進む」とそのまま読む。
ML や Koka のプログラマの読みであり、effectful-yaml の紙面もこちらである。
第二は翻訳 (−)\* による読みであり、項を λml のモナドの計算として読む。

この二つが「同じ構文の二つの像」だと言えるのは、翻訳が健全かつ完全だからである。
すなわち λc で `e1 ≡ e2` であることと、λml で `e1* ≡ e2*` であることが一致する。
対応の要は、let 律の三つが翻訳を通してちょうどモナド則の三つに写ることである。

| λc の let 律 | モナド則 |
|---|---|
| `let x = v in e ≡ e[v/x]` | 左単位元 `return v >>= f ≡ f v` |
| `let x = e in x ≡ e` | 右単位元 `e >>= return ≡ e` |
| let の結合律 | `>>=` の結合律 |

直接スタイルの let について認めるべき等式と、モナド則は、同じものの二つの表現である。
直接スタイルとモナディックスタイルの行き来が恣意でないのは、この往復が等式理論を保つ翻訳として固定されているからである。

## Haskell の do 記法

Haskell はモナディックスタイル、すなわち λml 側に住む言語である。
`T` は型に現れ（`IO a` や `State s a`）、`return` と `>>=` を書き手が書く。
do 記法はその上の糖衣であり、次の規則で `>>=` へ脱糖される。

```
do { x <- e; 残り }  =  e >>= \x -> do { 残り }
do { e; 残り }       =  e >>= \_ -> do { 残り }
do { e }             =  e
```

effectful-yaml の `$do` の展開（言語仕様の束縛と制御の節）はこの脱糖と同型である。
`x <- e` が `$let` の束縛に、束縛しない文が捨て名への束縛（`>>` すなわち `>>= \_ ->`）に対応し、最後の文がそのまま残ることも一致する。
言語仕様の用例「選択の基本形」は次の do 式に対応する。

```haskell
do x <- each ["a", "b", "c"]
   y <- each ["x", "y", "z"]
   each [x, y]
```

束縛を持たない文の並び `$do: [f, g, h]` は `f >> g >> h` に対応する。

一点だけ、Haskell と YAML では糖衣の背負う必然性が違う。
Haskell では λ の本体が式の末尾まで延びるので、do を使わなくても bind の連鎖を平坦に書ける。

```haskell
e1 >>= \x ->
e2 >>= \y ->
e3
```

YAML では入れ子が必ず字下げとして現れるため、`$let` の右入れ子は紙面でも右へ沈む。
さらに YAML は一つのマッピング内の重複キーを許さないので、値を捨てる文の羅列を一つの `$let` に収められない。
`$do` はこの基盤の制約を吸収する糖衣であり、同じ展開関係でありながら Haskell の do より重い役割を負う。

### Kleisli 合成

Kleisli 合成 `f >=> g >=> h` に対応する専用の形は無い。
直接スタイルでは呼び出しの入れ子がそのまま作用込みの合成なので、f と g と h をレキシカルに束縛された関数として、次に対応する。

```yaml
$fn: x
$body:
  $.h:
    $.g:
      $.f: ${x}
```

演算を挟むときも同じで、呼び出しの入れ子に演算の呼び出しを置く。
カーネルの関数がパラメータをちょうど一つに固定するのはこの合成のためである。
`>=>` で合成できるのは一引数の関数だけであり、一つに固定すれば関数は常に Kleisli 射 `A → T B` の直接スタイル版になる。

## Koka の直接スタイル

Koka は λc の直接スタイルを、モナド `T` を一つに固定せずに実用化した言語である。
作用は型の作用行（effect row）に現れ、演算は普通の関数のように直接呼び出す。

```koka
effect ask
  ctl ask() : int

fun greet() : ask int
  val x = ask()
  x + 1

fun main()
  with handler
    ctl ask() resume(41)
  greet()
```

`val x = ask()` では、純粋な束縛（let）と作用のある計算の逐次（bind）の区別が構文から消えている。
effectful-yaml の `$let` が bind 相当を兼ねるのは、この設計の踏襲である。

理論の系譜で言えば、Moggi のモナドの後、Plotkin と Power が「演算がモナドを生成する」という代数的作用の見方を与え、Plotkin と Pretnar がその演算を処理するハンドラを与えた。
Koka や Eff はこの線上にあり、effectful-yaml も同じ地点に立つ。
λc がモナド `T` を一つ抽象的に固定するのに対し、この系譜では、プログラムに出現する演算の集合が解釈を索引する。
effectful-yaml の作用シグネチャは Koka の作用行に相当し、演算の意味を包囲する最も近いハンドラが選ぶ規則も共通である。

## effectful-yaml との対応

以上を踏まえると、言語仕様の各部は次のように対応する。

| effectful-yaml | λc / λml | Haskell | Koka |
|---|---|---|---|
| `$let`（`$in`） | `let x = e1 in e2`（= `>>=`） | `x <- e` | `val x = e` |
| 値（`pure` を置かない） | 値の翻訳の暗黙の `return` | `pure` / `return` | 値 |
| `$do` | let への展開 | do 記法（`>>=` への脱糖） | 文の並び |
| 捨て名 `_` への束縛 | `let _ = e in ...` | `>>` | 値を捨てる文 |
| `$fn` と呼び出し | Kleisli 射 `A → T B` | `a -> m b` | 関数 |
| 演算 | 代数的作用の演算 | — | 演算（`ctl`） |
| `$handle` | — | — | `handler` |
| 作用シグネチャ | `T` の生成元の集合 | モナドの選択 | 作用行 |
| 既定ハンドラの系列 | モナドスタック | reader / state / list / except | 既定のハンドラ |

意味論のレベルでは、`$let` の束縛の連鎖が作用のモナドにおける `>>=` の連鎖に対応し、`$do` はそこへ展開される糖衣である。
既定ハンドラと明示のハンドラがそのモナドの解釈を与える。
三者を並べると次のようになる。

```
λc:             let x = get () in x + 1
Haskell (λml):  get () >>= \x -> return (x + 1)
effectful-yaml: {$let: {x: {$std.get: n}}, $in: ${x + 1}}
```

個別の対応をいくつか挙げる。

- パラメータ作用は reader モナドに、状態作用は state モナドに、選択は list モナドに対応する。
- `$std.list` の展開は list モナドの教科書どおりの形であり、`$collect` はモナドの列に対する bind（concatMap）である。`$collect` は圏論の言葉では畳み込み（catamorphism）でもあり、`$std.list` の展開が両者を結ぶ。
- `$std.state` を選択の外に置く貫流は `ListT (State s)` に、内に置いて分岐点で分かれる形は `StateT s []` に対応する。

## fine-grained call-by-value との関係

λc の後継の定式化に fine-grained call-by-value がある。
値と計算を構文のレベルで分離し、`return` を明示する体系である。
effectful-yaml のカーネルは、逐次を `$let` に一本化し適用を独立の原始に置く骨格をこちらと共有しつつ、`return` を暗黙にする点では λc 側に残った混合形である。
値だけの文書がそのまま評価の結果になり `pure` に相当する構文が要らないのは、λc が値の翻訳に `return` を暗黙に挿入することの再現である。

## 参考文献

- E. Moggi. Notions of Computation and Monads. Information and Computation, 1991.
- P. Wadler. Monads for Functional Programming. 1995.
- P. B. Levy, J. Power, H. Thielecke. Modelling Environments in Call-by-Value Programming Languages. Information and Computation, 2003.
- G. Plotkin, J. Power. Algebraic Operations and Generic Effects. Applied Categorical Structures, 2003.
- G. Plotkin, M. Pretnar. Handling Algebraic Effects. Logical Methods in Computer Science, 2013.
- D. Leijen. Type Directed Compilation of Row-typed Algebraic Effects. POPL, 2017.
