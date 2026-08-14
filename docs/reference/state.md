# $state

`$state` は状態作用の新しいスコープを作る。

- 種別：ハンドラ
- 処理する作用：状態
- 補助キー：`$in`

## 形

```yaml
$state:
  セル名: 初期値
$in: 本体の式
```

## 規則

- 本体の中の `$get` と `$set` は、最も近い `$state` の記憶に解決される。セルごとに別の `$state` へ振り分けることはしない。
- 初期値のマッピングは空でもよい。セルは `$set` で作れる。
- 値は本体の値である。最終状態は捨てられるので、要るなら本体の最後で `$get` する。
- 文書の最外には暗黙の `$state: {}` があり、これが状態の既定ハンドラである。

## 選択との関係

`$state` を選択に対してどこに置くかで、状態と分岐の関係が決まる。

```yaml
# 貫流（既定と同じ）: 状態が分岐から分岐へ持ち越される
$state: {n: 0}
$in:
  $list: 選択を含む本体
```

```yaml
# 分岐点で分かれる: 各分岐が選択時点の状態を引き継ぎ、以後は独立に進む
$list:
  $state: {n: 0}
  $in: 選択を含む本体
```

```yaml
# 分岐ごとに初期化: 各分岐が初期値から作り直す
$do:
- $let:
    x: {$each: [a, b]}
- $state: {n: 0}
  $in: 分岐の中の処理
```

貫流が ListT (State s) に、分岐点で分かれる形が StateT s [] に対応する。

## 例

貫流を使った連番の採番である。

```yaml
$do:
- $set: {n: 0}
- $let:
    name: {$each: [web, db, cache]}
    id: {$get: n}
- $set:
    n: ${id + 1}
- name: ${name}
  id: ${id}
```

```yaml
- name: web
  id: 0
- name: db
  id: 1
- name: cache
  id: 2
```

## 関連

- [$get](get.md)、[$set](set.md)
- [$list](list.md)
- [$handle](handle.md)
