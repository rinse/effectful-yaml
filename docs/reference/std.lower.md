# std.lower

`std.lower` は文字列を小文字化する。

- 種別：第一階の標準演算（作用を起こさない）

## 形

```yaml
{$std.lower: 文字列の式}
```

## 規則

- 値は引数の文字列を小文字化した文字列である。
- 作用を起こさないので、値がそのまま計算に合流する。

## 例

```yaml
{$std.lower: HELLO}
```

```yaml
hello
```

## 関連

- [std.upper](std.upper.md)
- [$op](op.md)、[$pipe](pipe.md)
