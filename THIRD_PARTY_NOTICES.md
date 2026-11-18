# Third-party notices

## yomiyasu

この作業の一部は、[yomiyasu](https://github.com/nanaism/yomiyasu) の基本原則、語彙カタログ、検査スクリプトを元にしています。

派生・書き換えたファイル:

- `references/writing.md`: yomiyasu の基本原則と語彙カタログを、判断を求める文向けに書き換えたもの
- `scripts/text_lint.py`: `yomiyasu_lint.py` を元に、判断ボードのJSON走査と検査を加えたもの

このリポジトリに同梱する単体 Skill の派生物:

- `skills/clear-japanese/SKILL.md`
- `skills/clear-japanese/references/rewrite-rules.md`: yomiyasu の基本原則を元にしたもの
- `skills/clear-japanese/references/rewrite-examples.md`: yomiyasu の構文変換原則（旧 `gemini-syntax.md`）の例と参考文献を元にしたもの
- `skills/clear-japanese/references/ai-patterns.md`: 後半の語彙カタログが yomiyasu の語彙カタログ（旧 `slop-catalog.md`）を元にしたもの
- `skills/clear-japanese/references/technical-writing.md`: yomiyasu の技術記事向け仕様（旧 `domains/tech.md`）を取り込んだもの
- `skills/clear-japanese/references/slides-and-documents.md`: yomiyasu の業務文書向け仕様（旧 `domains/business.md`）を取り込んだもの
- `skills/clear-japanese/references/essays-and-promotion.md`: yomiyasu のエッセイ向け仕様（旧 `domains/essay.md`）を取り込んだもの
- `skills/clear-japanese/references/summarize.md`
- `skills/clear-japanese/scripts/yomiyasu_lint.py`
- `skills/clear-japanese/scripts/yomiyasu_diff.py`
- `skills/clear-japanese/LICENSE`
Copyright (c) 2026 nanaism

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## nihongo

同梱する単体 Skill「clear-japanese」の一部は、[nihongo](https://github.com/AnIT012/nihongo) v2.3.1 の判断の原則、場面ごとの資料、短い版、検査スクリプト、テスト、検証の記録を元にしています。

派生・書き換えたファイル:

- `skills/clear-japanese/SKILL.md`: nihongo の `SKILL.md` の原則と手順を、yomiyasu を元にした手順と統合したもの
- `skills/clear-japanese/ALWAYS.md`: nihongo の `ALWAYS.md` を clear-japanese 向けに書き換えたもの
- `skills/clear-japanese/README.md`: 使用例が nihongo の README を元にしたもの
- `skills/clear-japanese/references/` のうち次の資料: `ai-patterns.md`（前半の索引）、`business-email.md`、`conversation.md`、`craft.md`、`entry-sheet.md`、`essays-and-promotion.md`、`keigo.md`、`length-and-content.md`、`make-profile.md`、`media.md`、`messaging.md`、`notices.md`、`orthography.md`、`personal-profile.md`、`review.md`、`slides-and-documents.md`、`speech.md`、`technical-writing.md`、`titles.md`、`translation.md`、`ui-copy.md`
- `skills/clear-japanese/scripts/check_meaning.py`
- `skills/clear-japanese/scripts/revert_broken.py`
- `skills/clear-japanese/scripts/trim_commas.py`
- `skills/clear-japanese/tests/`: nihongo の `tests/` を、スクリプトのパスだけ変えて取り込んだもの（`run_all.py` は clear-japanese で足したもの）
- `skills/clear-japanese/evaluations/`: nihongo の `evaluations/` を取り込んだもの（課題はそのまま）
- `skills/clear-japanese/LICENSE`

Copyright (c) 2026 AnIT012

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
