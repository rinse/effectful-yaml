# $first

`$first` は失敗しなかった最初の分岐の値に評価される。
バックトラック探索とフォールバックの連鎖に使う。

- 種別：ハンドラ
- 処理する作用：選択と失敗

## 形

```yaml
{$first: 式}
```

## 規則

- 分岐を文書順に試し、失敗も打ち切りもしなかった最初の分岐の値に評価される。
- 採用された分岐より後の分岐は評価されない。
- すべての分岐が失敗または打ち切りなら、全体が失敗になる。
- 値は単値である。全分岐が要るときは `$list` を使う。

## 例

パラメータを何も渡さずに評価する。

```yaml
log_level:
  $first:
    $do:
    - $let:
        v: {$each: [{$param: log_level, $default: null}, info]}
    - $where: ${v != null}
    - ${v}
```

```yaml
log_level: info
```

## 関連

- [$fail](fail.md)
- [$where](where.md)
- [$list](list.md)
