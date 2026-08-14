# OKF v0.1 リファレンス

OKF (Open Knowledge Format) v0.1 の書式仕様。knowledge bundle の frontmatter・リンク記法・ファイル構成で困ったときに参照する。`type` 以外の制約は**ソフトな指針**であり、consumer は欠損フィールド・未知の type・壊れたリンクを理由に bundle を拒否してはならない、という寛容な設計が前提。

## bundle 構成

```
knowledge/                    # bundle ルート
├── index.md                  # 常に作成（progressive disclosure）
├── log.md                    # git 管理下では作らない／既存なら維持
├── <concept>.md              # ルート直下の concept
└── <subdir>/                 # concept のグループ
    ├── index.md
    └── <concept>.md
```

- `index.md` と `log.md` は**予約ファイル名**。concept ドキュメントには使わない。それ以外の `.md` はすべて concept。
- **Concept ID** = `.md` を除いたファイルパス（例: `tables/orders`）。

## concept ドキュメント

frontmatter（YAML）+ markdown 本文。

```yaml
---
type: <種類名>                 # 必須・非空。これだけが唯一の必須フィールド
title: <表示名>                # 推奨。無ければファイル名から導出される
description: <1 行要約>        # 推奨。index やプレビューで使われる
resource: <正規 URI>          # 任意。対象資産を一意に指す URI
tags: [<tag>, <tag>]          # 任意
timestamp: <ISO 8601 日時>    # 任意。最終更新日時
# producer 独自のキーを追加してよい
---
```

本文は**構造化 markdown**を優先（見出し・箇条書き・表・コードブロック）。散文より構造の方が人間の読解にも Agent の検索にも効く。慣例的な見出し（いずれも任意）:

| 見出し | 用途 |
|--------|------|
| `# Schema` | 対象のカラム/フィールドの構造的記述 |
| `# Examples` | コードブロックでの具体的な利用例 |
| `# Citations` | 本文の主張を裏付ける外部出典 |

## クロスリンク

concept どうしは標準 markdown リンクでつなぐ。リンク A→B は「A と B に関係がある」という主張で、関係の種類は周囲の文章で表す（リンク自体は無向・無型として扱われる）。

- **絶対（bundle 相対）リンク**: `/` 始まりで bundle ルートから解釈。ドキュメント移動に強いので**推奨**。例: `[orders テーブル](/tables/orders.md)`
- **相対リンク**: 通常の相対パス。例: `[隣の concept](./other.md)`
- リンク先が存在しなくてもよい（未執筆の知見を指しているだけ、と解釈される）。

## index files

`index.md` は**frontmatter を持たない**（唯一の例外: bundle ルートの `index.md` は `okf_version: "0.1"` の宣言**のみ**を目的とした frontmatter を持ってよい。サブディレクトリの `index.md` は frontmatter なし）。本文はセクションごとに concept を箇条書きする:

```markdown
# セクション見出し

* [Title 1](relative-url-1) - 短い説明
* [Title 2](relative-url-2) - 短い説明

# 別のセクション

* [サブディレクトリ](subdir/) - 説明
```

各エントリの説明はリンク先 concept の `description` から取る。

## log files

`log.md` は変更履歴。日付でグループ化したフラットなリストで、**新しい順**。日付は ISO 8601 `YYYY-MM-DD`。エントリは散文で、先頭の太字は慣例（必須ではない）。

```markdown
# Update Log

## 2026-06-18
* **Update**: Added [Customer Metrics](/tables/customer-metrics.md).
* **Creation**: Established [Dataplex Playbook](/playbooks/dataplex.md).

## 2026-06-15
* **Initialization**: Created directory structure.
```

## citations

本文が外部資料に基づく主張をする場合、出典を `# Citations` 見出し以下に番号付きで列挙する。リンクは絶対 URL でも bundle 相対パスでも、`references/` サブディレクトリ内の資料でもよい。

```markdown
# Citations

[1] [BigQuery announcement](https://cloud.google.com/blog/...)
[2] [Internal runbook](https://wiki.acme.internal/data/quality)
```

## conformance（適合条件）

bundle が OKF v0.1 に適合するのは:

1. 予約ファイル以外のすべての `.md` がパース可能な YAML frontmatter を持つ
2. すべての frontmatter が非空の `type` フィールドを持つ
3. 予約ファイル名（`index.md` / `log.md`）が存在する場合は所定の構造に従う

それ以外（欠損フィールド・未知 type・未知キー・壊れたリンク・index 欠如）は適合性を損なわない。

## 一次資料

OKF の一次資料:

- README（概要）: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf/README.md
- SPEC（仕様）: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
