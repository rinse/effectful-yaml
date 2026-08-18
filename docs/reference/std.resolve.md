# std.resolve

`std.resolve` は URL を解決する。
`base` を基準に `path` を絶対 URL にする。

- 種別：第一階の標準演算（作用を起こさない）

## 形

```yaml
$std.resolve: {base: 文字列, path: 文字列}
```

## 規則

- 値は `path` を `base` に対して解決した絶対 URL の文字列である。解決の規則は RFC 3986 の相対参照解決に従う。
- `base` は絶対 URL でなければならない。
- `path` が既に絶対 URL であれば、`base` を無視してそのまま正規化される。
- 作用を起こさないので、値がそのまま計算に合流する。

## 例

```yaml
$std.resolve: {base: https://example.com/a/b/, path: ../c}
```

```yaml
https://example.com/a/c
```

スクレイピングで拾った相対リンクを、ページの URL を基準に絶対化する用途に使う。

```yaml
$do:
- $let:
    page: https://example.com/articles/index.html
    link: ../images/cover.png
- $std.resolve:
    base: ${page}
    path: ${link}
```

```yaml
https://example.com/images/cover.png
```

## 関連

- [言語仕様の第一階の標準演算](../grammar.md)
