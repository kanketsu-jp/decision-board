---
name: decision-board
description: AI エージェントが人間に判断・選択・承認を求めるとき、または読ませたい資料（Markdown）を渡すときに使う。1 つのディレクトリに 1 枚の HTML を作り、ローカルの受け口で回答を受け取り、回答をエージェントへ「閉じるコマンド」付きで知らせる。「判断ボード」「回答フォーム」「質問をまとめて」「HTML で聞いて」「よみものを追加」と言われたとき、または端末で選択肢を並べて聞きそうになったときに使う。
license: MIT
---

# decision-board

## いつ使うか

人間に複数の判断をまとめて求めるとき、選択肢や資料を見やすく提示したいときに使います。1 件の yes/no を会話の流れで聞くだけなら不要です。回答が不要な説明は、質問ではなくよみものにします。

`<skill>` は、この `SKILL.md` があるディレクトリの絶対パスです。以下のコマンドでは、実際の絶対パスに置き換えます。

## 最初の 1 回

1 プロジェクトにつき 1 ディレクトリ、1 枚の HTML だけを作ります。

```sh
node <skill>/scripts/board.mjs init --dir .temp/bord --session "<セッション名>" --cwd "$PWD"
```

エージェントへ知らせるコマンドがある場合は、`--inbox` にコマンドと引数を JSON 配列で渡します。

```sh
node <skill>/scripts/board.mjs init --dir .temp/bord --session "<セッション名>" --cwd "$PWD" --inbox '["<知らせるコマンド>","<宛先>"]'
```

回答が届くと、指定した argv の最後に回答本文を足して実行します。マルチエージェントの道具があれば、自分のセッションへメッセージを送る CLI を指定します。無ければ `--inbox` を省略し、人が画面の「JSON を写す」で会話に貼ります。

## 判断を足す

`references/question-template.md` の型で、1 件につき 1 つの判断を `item.json` にします。すべての型に自由記入欄が付くので、「その他」は作りません。
推奨があるときは `answer.recommended` に値を入れる（回答者は何も選ばずに「推奨」で送れる）

| 聞くこと | `answer.type` | 値 |
|---|---|---|
| どれを採るか | `choice` | 選んだ値の文字列 |
| いくつ採るか | `multi` | 選んだ値の文字列配列 |
| どのくらい重要か・満足か | `rating` | 1〜`max` の数 |
| 端から端までどの位置か | `scale` | `min`〜`max` の数 |
| 進めてよいか | `yesno` | `true` または `false` |
| いつまでに・何日か | `number` | 数 |
| 選択肢で表せない判断 | `text` | 自由記入の `note` |

```sh
python3 <skill>/scripts/text_lint.py --item item.json
node <skill>/scripts/board.mjs add --dir .temp/bord --file item.json
```

文面の lint がエラー 0 件になってから `add` を実行します。文面の規則は `references/writing.md` に従います。

## 区分に分ける

判断が2系統以上に分かれるとき（たとえば、ある案件の判断とそれ以外）が区分を使う場面です。区分名は前後の空白を除いて1〜30文字です。

```sh
node <skill>/scripts/board.mjs add --dir .temp/bord --file item.json --group "<区分>"
node <skill>/scripts/board.mjs group --dir .temp/bord --id q-3 --id q-4 --group "<区分>"
node <skill>/scripts/board.mjs group --dir .temp/bord --id q-3 --clear
node <skill>/scripts/board.mjs groups --dir .temp/bord --set '["<区分A>","<区分B>"]'
node <skill>/scripts/board.mjs groups --dir .temp/bord
```

`add --group` は item.json の `group` より優先されます。`group` は `--id` を何度でも指定でき、`--clear` で区分を外せます。`groups --set '[]'` は表示順を消す指定です。`groups` は保存した表示順と item に付いた区分名を1行1件で表示し、`--json` では配列を出します。item が0件の区分も表示されます。

区分がある判断は、区分ごとの折りたたみで表示される構成です。既定の状態は開いたままです。「その他」は区分のない item の入れ物として表示されます。よみものは区分しません。

## よみものを足す

回答を求めない Markdown は、よみものとして追加します。

```sh
node <skill>/scripts/board.mjs read --dir .temp/bord --file x.md --title "<タイトル>"
```

## 見せる

```sh
node <skill>/scripts/board.mjs serve --dir .temp/bord --open
```

受け口は `127.0.0.1` だけで待ち受けます。外（トンネル）から開くときは、トンネルで受け口のポートを公開し、その URL を `serve --public-url <URL>` で渡します。指定した URL 以外の Host / Origin は 403 のままです。公開した URL には認証（例: アクセス制御サービス）をかけることを勧めます。チャットに残すのは結論 1 行と URL です。

## 回答が届いたら

回答本文の判断を反映し、本文の最後にある close コマンドをそのまま実行します。

```sh
node <skill>/scripts/board.mjs close --dir .temp/bord --id <id>
```

HTML は `board.json` から自動で描き直されます。HTML を手で直しません。やり直すときは `reopen` を使います。

```sh
node <skill>/scripts/board.mjs reopen --dir .temp/bord --id <id>
```

## 状態を見る

```sh
node <skill>/scripts/board.mjs list --dir .temp/bord
node <skill>/scripts/board.mjs answers --dir .temp/bord
```

区分付きの item が1件でもあると、`list` の行末に区分の列が付きます（区分なしは「その他」です）。

## してはいけないこと

- `index.html` を手で編集しません。
- 2 枚目の HTML を作りません。
- 回答済みの項目を open のまま放置しません。必ず close します。
- 「回答は不要です」と書いた質問を作りません。よみものにします。
