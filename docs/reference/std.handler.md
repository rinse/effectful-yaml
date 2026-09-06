# std.handler

`$std.handler` は節から関数値を作る導出形である。
値は一級のハンドラ値であり、本体をサンク（引数一つの関数）として受け取り、それを null で呼んだ計算を節の下で評価する。

- 種別：関数を作る導出形（作用を持たない。適用の作用は節の本体とサンクの本体に由来する）
- 補助キー：なし

## 形

```yaml
$std.handler:
  演算名:
    $fn: 引数名
    $body: 節の本体
  return:
    $fn: 値名
    $body: 式
```

## 展開

私的名は文書から参照できない捨て名である。

```
{$std.handler: 節} ≡ {$fn: 私的名, $body: {$with: 節, $in: {$.私的名: null}}}
```

## 規則

- 節の書き方と意味（節名の分類、`$resume`、`return`、深さ、節の本体の作用の扱い）は [$with](with.md) と同じである。
- 節の本体は、`$std.handler` を書いた位置の束縛を捕まえる。閉包を作るときに束縛が決まり、適用のたびには決まらない。
- 本体はサンクで渡す。引数は値渡しなので、本体の式をそのまま引数に書くと、ハンドラが立つ前にその作用が起きる。
- 節に書いたローカル作用の宣言が導入する束縛は、展開の本体 `{$.私的名: null}` からしか見えない。サンクは別の位置で書かれるのでその束縛を呼べず、ハンドラの値が意味を与える演算は名前空間つきの演算だけである。
- 同じハンドラの値を、それに渡すサンクの本体の中で再び適用することは、関数値の流れの検査が自己適用として拒む。入れ子にするには、値を二つ作るか、内側を `$with` で書く。
- 閉包なので、作用境界の外へ出て文書の値に残ることはエラーである（[$fn](fn.md)）。

## 例

一度作ったハンドラの値を、二つの本体に掛ける。

```yaml
$let:
  fallback:
    $std.handler:
      std.fail: {$fn: _, $body: 0}
$in:
  a: {$.fallback: {$fn: _, $body: {$std.lookup: {in: {}, key: missing}}}}
  b: {$.fallback: {$fn: _, $body: 7}}
```

```yaml
a: 0
b: 7
```

節の本体は定義位置の束縛を捕まえるので、関数の本体に置けば、引数で節を調整したハンドラの値を作れる。

```yaml
$let:
  fallback:
    $fn: default
    $body:
      $std.handler:
        std.fail: {$fn: _, $body: "${default}"}
  zero: {$.fallback: 0}
  empty: {$.fallback: ""}
$in:
  n: {$.zero: {$fn: _, $body: {$std.lookup: {in: {}, key: missing}}}}
  s: {$.empty: {$fn: _, $body: {$std.lookup: {in: {}, key: missing}}}}
```

```yaml
n: 0
s: ""
```

## 関連

- [$with](with.md)（ハンドラの二項形。節の規則はそこで定める）
- [$fn](fn.md)（閉包と呼び出し）
- [理論的背景](../theory.md)（Koka の `handler` との対応）
