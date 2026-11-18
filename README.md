# decision-board

人間に複数の判断を求める HTML を、1 プロジェクト 1 枚で作れます。
回答はローカルの受け口が `board.json` に保存し、エージェントへ close コマンド付きで知らせます。
判断だけでなく、Markdown のよみものも同じ画面で見せられます。

## 画面

ヘッダにセッション名、作業パス、回答済み件数のバッジを表示します。中身には判断の説明、比較、回答欄を表示します。フッタには一覧、前へ、次へ、送信を置きます。

一覧には「判断」と「よみもの」のタブがあります。判断の一覧では回答済みも確認でき、よみものは Markdown を HTML に変換して表示します。
区分付きの判断がある場合は、判断の一覧が区分ごとの折りたたみに分かれます。区分は既定で開いています。よみものは区分しません。

### 回答の型

| 聞くこと | `answer.type` | 値 |
|---|---|---|
| どれを採るか | `choice` | 選んだ値の文字列 |
| いくつ採るか | `multi` | 選んだ値の文字列配列 |
| どのくらい重要か・満足か | `rating` | 1〜`max` の数 |
| 端から端までどの位置か | `scale` | `min`〜`max` の数 |
| 進めてよいか | `yesno` | `true` または `false` |
| いつまでに・何日か | `number` | 数 |
| 選択肢で表せない判断 | `text` | 自由記入の `note` |
| 表の行ごとに書いてほしい | `table` | 行と同じ長さの文字列配列（未記入は ""） |

どの型にも自由記入欄が付きます。「その他」は選択肢にしません。

## 導入

```sh
npx skills add <owner>/decision-board
```

手で入れる場合は、`skills` ディレクトリにこのリポジトリを置きます。

## 同梱の単体 Skill

日本語の文章を書く・直す・短くする・要約するときは、同梱の単体 Skill「clear-japanese」を使えます。clear-japanese は yomiyasu（MIT）と nihongo（MIT）を元にしています。
導入するコマンドは `npx skills add <owner>/decision-board --skill clear-japanese` です。
使い方は [skills/clear-japanese/README.md](skills/clear-japanese/README.md) にあります。

## 使い方

詳細は [SKILL.md](SKILL.md) を参照してください。流れは次のとおりです。

1. `init` で `.temp/bord` を初期化します。
2. `question-template.md` の型で item の JSON を作り、`text_lint.py` を通してから `add` します。
3. 判断が2系統以上に分かれる場合は、`add --group` または `group` と `groups` で区分を設定します。
4. `read` でよみものを追加します。
5. `serve --open` で画面を開きます。
6. 回答が届いたら、通知本文の close コマンドをそのまま実行します。
7. `list` と `answers` で状態を確認します。

トンネル経由で開くときは `serve --public-url https://board.example.test --open` のように指定します。
指定した公開 URL 以外の Host / Origin は 403 のままです。公開 URL には認証をかけてください。

デモは次のコマンドで実行します。

```sh
node examples/demo.mjs --open
```

## 設計の要点

- `board.json` が参照元で、HTML は描くだけです。
- 回答はローカルの受け口が受けて `board.json` に書きます。
- 受け口は回答を保存した直後に応答し、エージェントへの通知は後で行います。通知の結果は `serve` のログに残ります。
- 通知には、エージェントが実行する close コマンドを入れます。これで「回答したのに HTML に反映されない」問題をなくします。
- 受け口は `127.0.0.1` のみで待ち受け、指定した公開 URL を除き Host と Origin を検査します。
- Markdown は `marked` で変換し、`DOMPurify` で無害化します。
- 区分を使わないボードは、見た目も `board.json` も今までと同じです。

## 使っているもの

- Web Awesome 3.14.0（MIT）
- marked 18.1.0
- DOMPurify 3.4.16
- Chart.js 4.5.1（CDN・版固定）
- yomiyasu（MIT、`THIRD_PARTY_NOTICES.md`）
- nihongo（MIT、`THIRD_PARTY_NOTICES.md`）

## 試験

```sh
node --test test/*.test.mjs
```
