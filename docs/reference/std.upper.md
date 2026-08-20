# std.upper

`std.upper` は文字列を大文字化する。

- 種別：第一階の標準演算（作用を起こさない）

## 形

```yaml
{$std.upper: 文字列の式}
```

## 規則

- 値は引数の文字列を大文字化した文字列である。
- 作用を起こさないので、値がそのまま計算に合流する。

## 例

```yaml
{$std.upper: hello}
```

```yaml
HELLO
```

## 関連

- [std.lower](std.lower.md)
