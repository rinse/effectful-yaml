# effectful-yaml

既存の YAML (JSON) パーサーの上で動くインタプリタフレームワークです。
YAML の文法内で独自の記法を定め、それを評価して新しい YAML を返したり、フレームワーク利用者の定義する副作用を起こしたりします。
名前の Effectful は、独自記法のアイデアが Koka の Effect や Haskell の do 文に着想を得ていることに由来します。

## ドキュメント

- [ドキュメント索引](docs/index.md)
- [言語仕様（草案 0.11）](docs/grammar.md)
- [処理系の利用](docs/usage.md)
- [CLI（eff-yaml）](docs/cli.md)
