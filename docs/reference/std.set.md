# std.set

`std.set` はセルに値を書く。

- 種別：標準演算
- 作用：状態（state モナドに対応する）

## 形

```yaml
- $std.set:
    セル名: 式
```

## 規則

- 最も近い `$std.state` の記憶へ書く。未作成のセルは作られる。
- 複数のセルを一度に書ける。右辺は文書順に評価される。
- 文としての値は null である（YAML に unit 型がないため、null を unit の代用とする）。
- 現在値に基づく更新は、`std.get` の結果を `$let` で束縛してから書く。`${}` の中に演算は書けないからである。

## 例

```yaml
$do:
- $std.set:
    n: 1
    m: 2
- $let:
    a: {$std.get: n}
    b: {$std.get: m}
- ${a + b}
```

```yaml
3
```

## 関連

- [std.get](std.get.md)
- [std.state](std.state.md)
