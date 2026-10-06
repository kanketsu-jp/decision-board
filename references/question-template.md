# 判断1件の組み立て方

`board.json` の `items` の各要素を、次の順で組み立てます。1件につき判断は1つだけにします。

## sections の推奨順

| 順 | type | 役割 |
|---:|---|---|
| 1 | `text` | 何を決めるか、なぜ今か。冒頭で問いを明示する |
| 2 | `text` または `table` | 判断に必要な背景。専門用語は初出で1行説明する |
| 3 | `options` | 比較する選択肢。2〜4個、互いに排他にする |
| 4 | `chart` または `metric` | 判断に効く数字だけ。単位と測定時点・出どころを添える |
| 5 | `callout` | 決めないと起きること。期限または止まる作業を書く |
| 6 | `text` | おすすめと理由を1文で書く。おすすめがなければ省く |

4番は必要な場合だけ置きます。数字を載せるためだけにグラフや指標を増やしません。

## 回答の型

| 何を聞くとき | `answer.type` | value の形 |
|---|---|---|
| どれを採るか | `choice` | 選んだ値の文字列 |
| いくつ採るか | `multi` | 選んだ値の文字列配列 |
| どのくらい重要か・満足か | `rating` | 1〜`max` の数 |
| 端から端までどの位置か | `scale` | `min`〜`max` の数 |
| 進めてよいか | `yesno` | `true` または `false` |
| いつまでに・何日か | `number` | 数 |
| 選択肢で表せない判断 | `text` | 自由記入の `note` |

すべての型に自由記入欄が付きます。「その他」を選択肢にはしません。`choice` と `multi` の選択肢は2個以上にします。

推奨がある場合は `answer.recommended` に、`value` と同じ形の値を指定します。`choice` は選択肢の `value`、`multi` は値の配列、`rating`・`scale`・`number` は数、`yesno` は `true` または `false` を入れます。`text` 型には指定できません。

## 完全な例: choice

```json
{
  "id": "q-input-id-is-ignored",
  "title": "ログの保存期間を何日にするか決めますか？",
  "status": "open",
  "createdAt": "2026-01-02T03:04:05Z",
  "importance": 4,
  "sections": [
    {
      "type": "text",
      "heading": "今回決めること",
      "md": "監視ログの保存期間を決めます。次回の運用開始までに決めないと、保存設定の作業が止まります。"
    },
    {
      "type": "table",
      "heading": "候補の比較",
      "columns": ["期間", "保管量", "確認できる範囲"],
      "rows": [
        ["7日", "少ない", "直近の調査"],
        ["30日", "多い", "月内の調査"]
      ]
    },
    {
      "type": "options",
      "items": [
        {
          "key": "seven-days",
          "label": "7日",
          "summary": "直近の調査に使います。",
          "pros": ["保管量を抑えられます。"],
          "cons": ["7日より前のログを確認できません。"]
        },
        {
          "key": "thirty-days",
          "label": "30日",
          "summary": "月内の調査に使います。",
          "pros": ["月内のログを確認できます。"],
          "cons": ["7日より保管量が増えます。"],
          "recommended": true
        }
      ]
    },
    {
      "type": "callout",
      "variant": "warning",
      "md": "今日中に決めない場合、保存設定の作業を開始できません。"
    },
    {
      "type": "text",
      "heading": "おすすめ",
      "md": "おすすめは30日です。月内のログを確認できるためです。"
    }
  ],
  "answer": {
    "type": "choice",
    "prompt": "保存期間を選んでください。",
    "options": [
      {"value": "7", "label": "7日"},
      {"value": "30", "label": "30日"}
    ]
  },
  "response": null,
  "closedAt": null,
  "closeNote": null
}
```

## 完全な例: rating

```json
{
  "id": "q-rating-id-is-ignored",
  "title": "移行手順の確認しやすさを5段階で評価しますか？",
  "status": "open",
  "createdAt": "2026-01-02T03:04:05Z",
  "importance": 3,
  "sections": [
    {
      "type": "text",
      "heading": "今回決めること",
      "md": "移行手順を初めて読む人が確認しやすいか、次の更新前に評価します。評価がないと、修正する箇所を決める作業が止まります。"
    },
    {
      "type": "text",
      "heading": "背景",
      "md": "確認しやすさは、手順を読んで作業内容を間違いなく把握できるかを表します。"
    },
    {
      "type": "metric",
      "items": [
        {"label": "確認にかかった時間", "value": 12, "unit": "分", "note": "2026年1月2日に3回測定した中央値"},
        {"label": "手順の項目数", "value": 8, "unit": "項", "note": "現行の手順から数えた値"}
      ]
    },
    {
      "type": "callout",
      "variant": "neutral",
      "md": "明日までに評価しない場合、更新前の修正候補を決める作業が止まります。"
    },
    {
      "type": "text",
      "heading": "評価の基準",
      "md": "1は確認しにくく、5は確認しやすい状態です。"
    }
  ],
  "answer": {
    "type": "rating",
    "max": 5,
    "label": "確認しやすさ"
  },
  "response": null,
  "closedAt": null,
  "closeNote": null
}
```
