# Add duplicate-candidate issue search with multi-query lexical union

## Summary

`linear issue list --query ... --json` 1 発だけでは、日本語の名詞句や助詞差分を含む duplicate 検知の recall が弱いです。execution manager 側では query variant expansion で吸収できますが、CLI 側で複数 query の union を直接返せると、duplicate candidate search をもっと安定して実装できます。

## Proposed CLI capability

- 複数 `--query` を受け付けて、各 query の union 結果を 1 回の JSON response で返す
- 返却 JSON に `matchedQueries` と簡易 score を含める
- CJK 向けに、助詞・敬称・空白差分に強い normalize option を持てると望ましい

## Example shape

```json
[
  {
    "identifier": "AIC-61",
    "title": "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
    "matchedQueries": [
      "金澤 chatgpt プロジェクト 招待",
      "プロジェクト 招待"
    ],
    "score": 0.86
  }
]
```

## Why this matters

- `金澤さんのChatGPTのプロジェクト招待` と `金澤さんのChatGPTプロジェクトに角井さんを招待してもらう` のような near-duplicate を見つけやすくなる
- repo 側が `issue list --query` を何度も呼んで union/rank する必要が減る
- duplicate candidate search を manager 系だけでなく、CLI 利用者全体で共通化できる
