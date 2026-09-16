# std.range

`std.range` は自然数を、その個数ぶんの添字のリストに変える。
数から構造への唯一の橋であり、回数の上界つきの反復に使う。

- 種別：std の関数（作用を起こさない）

## 構文

```yaml
{$std.range: 自然数 n}
```

## 規則

- 値はリスト `[0, 1, ..., n-1]` である。
- 引数が自然数（0 以上の整数）でなければエラーになる。
- 演算ではないので作用集合に寄与せず、ハンドラの節で捕捉もできない。作用は引数の式の作用だけである。反復の中身が作用を起こせば、その作用は通常どおり合流する。
- 導出できないが評価器の協力も要らないので、意味は値から値への規則で定まる。
- 述語で止める unfold（while ループ）は fix と同じ強さを持つため提供しない。回数の上界がある反復だけが書ける。

## 例

```yaml
{$std.range: 5}
```

```yaml
[0, 1, 2, 3, 4]
```

種と関数から列を生成する unfold は、`std.range` が回数をリストに変え、[std.collect](std.collect.md) が回り、[std.state](std.state.md) が種を持ち回ることで書ける。

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

種 1 と関数 `(*2)` から先頭 5 要素を生成している。
アキュムレータを伴う fold も同じ組み合わせで書ける。

## 関連

- [std.collect](std.collect.md)
- [std.state](std.state.md)
