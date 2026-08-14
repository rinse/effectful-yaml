---
description: Use this skill whenever the user wants to capture or consolidate knowledge gained during work into a persistent, reusable form. Triggers on phrases like "知見を貯めて", "知見をまとめて", "ナレッジ化して", "capture this knowledge". Writes an Open Knowledge Format (OKF) bundle of markdown concept files under the project's knowledge/ directory.
license: MIT
metadata:
    author: rinse <rinse418@gmail.com>
    github-path: skills/okf-knowledge
    github-ref: refs/heads/main
    github-repo: https://github.com/rinse/skills
    github-tree-sha: c1bf86568d0d048c7dc898d1f3e5f72cac1ef588
    source: https://github.com/rinse/skills
name: okf-knowledge
---
# OKF Knowledge

作業の中で得た**知見**を、後から人間にも Agent にも再利用できる形で残すためのスキルです。知見を Open Knowledge Format (OKF)（一次資料は [references/okf-spec.md](references/okf-spec.md) 末尾を参照）に従った **knowledge bundle**（YAML frontmatter 付き markdown ファイルのディレクトリ）として記録します。

「知見を貯めて」「知見をまとめて」のような依頼が来たら、いま終えた（または進行中の）作業・会話から再利用価値のある知見を抽出し、OKF の concept ファイルとして bundle に書き出します。

## 文章スタイル

concept ファイルの本文は**技術文書**として書く。読者（人間・Agent を問わず）が次に同じ文脈に来たとき、迷わず内容を使えるよう情報を構成する。

**日本語で依頼が来た場合、かつ `technical-writing-ja` スキルが利用可能な場合**は、concept ファイルの執筆を始める前に Skill ツールで `technical-writing-ja` を呼び出し、その文章規範を適用する。規範の要点：整形（一文一改行・コードブロック）、段落構成（パラグラフライティング）、論証の厳密さ、冗長の排除、LLM っぽい予告・総括・空虚な形容の禁止。

## このスキルの肝は「何を knowledge にするか」の判断

OKF の書式（frontmatter のフィールド、リンク記法、ファイル構成）は [references/okf-spec.md](references/okf-spec.md) にまとめてあり、必要になったときに読めば十分です。書式は機械的に従えば済むので、このスキルで本当に難しく価値があるのは **「いま得た知見のうち何を、どの粒度で、どんな concept として残すか」という判断**です。ここに思考を集中させてください。

### 何を残すか

残す価値があるのは、**次に同じ文脈に来た人（や Agent）が知らずに同じ落とし穴にはまる／同じ調査をやり直す**ような知見です。例:

- 非自明な事実・制約（「この API は X のとき Y を返す」「このテーブルの `status` は歴史的経緯で 3 種類の意味を持つ」）
- ハマりどころと回避策（「ビルドが Z で失敗するのは W が原因」）
- 設計判断とその理由（なぜその方式を選んだか／選ばなかったか）
- 手順・プレイブック（再現性のある操作手順）
- ドメイン用語・概念の定義と関係

逆に**残さないもの**: コード・git 履歴・既存ドキュメントを読めば自明なこと、その場限りで再利用されない一過性の事情。迷ったら「3 ヶ月後の誰かがこれを読んで時間を節約できるか？」で判断します。

### どの粒度で分けるか（1 concept = 1 つの知識単位）

OKF の concept は「1 つの知識単位」を表す 1 ファイルです。粒度の指針:

- **1 つの対象・トピックにつき 1 concept。** 「テーブル orders」「認証フロー」「デプロイ手順」のように、見出しを付けられる単位で切る。
- 複数の独立した知見を 1 ファイルに詰め込まない。逆に、互いに切り離すと意味をなさない断片を無理に分けない。
- 関連する concept はサブディレクトリでまとめてよい（例: `tables/`, `playbooks/`, `concepts/`）。最初は浅い構成で始め、増えてきたら整理する。

### type / title / リンクを丁寧に選ぶ

- **`type`**（必須）: その concept の種類を表す短い文字列。`Playbook`, `API Endpoint`, `Domain Concept`, `Gotcha`, `Design Decision`, `BigQuery Table` など、**説明的で自己説明的**な値を選ぶ。中央レジストリはないので、プロジェクト内で一貫した語彙を使う。
- **`title`**: 人が一覧で見て中身が分かる名前。
- **クロスリンク**: concept どうしの関係は、本文中の markdown リンクで表現する（リンク記法は [references/okf-spec.md](references/okf-spec.md) 参照）。関連する既存 concept があれば積極的にリンクし、知識をグラフとしてつなぐ。リンク先がまだ無くてもよい（未執筆の知見を指しているだけ、と解釈される）。

判断に迷う・知見が大量にある場合は、**先に「どんな concept を作るつもりか」を箇条書きでユーザーに提示して合意を取って**から書き出すと手戻りが減ります。

## 手順

### 1. bundle の場所を決める

特に指示がなければ、**プロジェクトルート直下の `knowledge/`** を bundle ルートとします。プロジェクトルートは次で判定します（この git 判定は後の `log.md` の判断にも使うので、ここで一度だけ確認しておく）:

```
git rev-parse --is-inside-work-tree   # git 管理下か
git rev-parse --show-toplevel         # git 管理下ならこれがプロジェクトルート
```

- **git 管理下**: `show-toplevel` の出力をプロジェクトルートとし、その直下の `knowledge/` を使う。
- **git 管理外**: カレントディレクトリをプロジェクトルートとみなす（曖昧なら場所をユーザーに確認する）。
- ユーザーが別の場所を指定した場合はそれに従う。

`knowledge/` が既に存在する場合は**新規作成ではなく既存 bundle への追記**として扱います（後述の「既存 bundle への追記」）。

### 2. concept ファイルを書き出す

上の「何を knowledge にするか」の判断に基づき、concept を OKF 準拠の markdown ファイルとして作成します。必須・推奨の frontmatter と本文の書き方は [references/okf-spec.md](references/okf-spec.md) に従ってください。

- 既存の concept と同じ対象を扱う場合は**新規ファイルを作らず既存ファイルを更新**する（重複を作らない）。
- `timestamp` には現在日時（ISO 8601）を入れる。

### 3. index.md を作成・更新する（常に）

bundle ルートの `index.md` は**常に**作成・維持します。サブディレクトリを作った場合はその階層にも `index.md` を置きます。`index.md` は progressive disclosure（中身を開く前に何があるか分かる）ためのもので、書式は [references/okf-spec.md](references/okf-spec.md) 参照。

- 新しく作った concept を、適切なセクションの箇条書きに、frontmatter の `description` 付きで追加する。
- 既存 `index.md` がある場合は該当セクションに**追記**する（全面書き換えしない）。

### 4. log.md の扱い（git 管理下かどうかで分岐）

`log.md` は変更履歴を記録する予約ファイルです。**作成するかどうかは bundle が git 管理下かで決めます**（手順 1 の判定を再利用）:

- **git 管理下**: `log.md` を**作成しない**。変更履歴は git が担うため。
- **git 管理外**: `log.md` を作成するかどうか**ユーザーに尋ねる**。希望されたら作成する。

ただしこの分岐は**新規作成の話**です。**既に `log.md` が存在する場合は、git 管理下かどうかに関わらず追記して維持します**（過去に非 git で作られた bundle が後から git 化したケースなどを壊さないため）。追記の書式は [references/okf-spec.md](references/okf-spec.md) 参照（ISO 8601 の日付見出し、新しい順）。

### 5. AGENTS.md / CLAUDE.md にポインタを張る（ほとんどの場合に必要）

Agent が knowledge bundle の存在にスムーズに気づけるよう、プロジェクトルートにポインタを張ります。プロジェクトによって `AGENTS.md` を使う場合と `CLAUDE.md` を使う場合があるため、**両方の存在を確認**してから対象を決めます。

1. プロジェクトルート直下の `AGENTS.md` と `CLAUDE.md` の両方を確認する（存在するものは中身も読む）。
2. **どちらか（存在する方）に、既に bundle への言及（`knowledge/` への参照など）がある場合**: 何もしない。
3. **既に存在する方にポインタを張る**: 両方存在する場合は `AGENTS.md` を優先する。「Agent が見つけられるよう `<対象ファイル>` にリンクを張ってよいか」をユーザーに尋ね、了承を得たら追記する（例: 「## Knowledge」セクションに `knowledge/index.md` への 1 行リンクと一言説明）。
4. **どちらも存在しない場合**: ポインタを記載した `AGENTS.md` を新規作成してよいか**尋ねる**。勝手に作らず、勝手に飛ばさない。

### 既存 bundle への追記（「知見を貯めて」の通常ケース）

`knowledge/` が既にある場合は、上の手順を**追記モード**で行います。要点:

- concept は対象ごとに**更新 or 新規**を判断（既存対象なら同じファイルを更新し、重複ファイルを作らない）。
- `index.md` は該当セクションに追記。
- `log.md` が**既にあれば**追記する（手順 4 の git ルールは「作るか否か」にのみ適用）。
- `AGENTS.md` / `CLAUDE.md` のポインタが**既にあれば**手順 5 の確認はスキップ。

## リファレンス

OKF の書式仕様（frontmatter、クロスリンク、index/log ファイル、conformance）と一次資料（README / SPEC）へのリンクは [references/okf-spec.md](references/okf-spec.md) にまとめてあります。必要になったときに読んでください。
