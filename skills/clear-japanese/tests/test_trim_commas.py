"""trim_commas.py の回帰テスト。 python3 tests/test_trim_commas.py で動く（標準ライブラリだけ）。

作者が目隠しで「読点を外した方が自然か」を判定した20文のうち19文（2026-11-18）。
残る1文（宣伝文の「〜を、」）は、宣伝で語を立てたい時の読点として、スクリプトでは外す側に残している。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from trim_commas import trim, trim_sentence  # noqa: E402

# (文, 外すべきか)
CASES = [
    ("右下の「＋」ボタンで、はじめてみましょう。", True),
    ("弟の成長を、家族みんなで喜べたことが、最近いちばんうれしかったことです。", True),
    ("1つ目は、通勤の時間が減ることです。", False),
    ("申請の承認は、上長1人だけで完了します。", True),
    ("三つ目は、近所に好きなパン屋を見つけたこと。", False),
    ("1月から、打刻と承認のやり方が変わります", True),
    ("足先から順に、力を入れてからふっと抜いていく", False),
    ("最初の授業で、エラーが30個出た。", True),
    ("来週火曜のシフトを、木曜に変えてもらえないでしょうか。", True),
    ("2つ目は、家族と過ごす時間が増えることです。", False),
    ("撮るだけで、記録できる。", True),
    ("うちの父は、料理が苦手だ。", True),
    ("それでも弟は、おばあちゃんの家まで一人で行けた。", True),
    ("散歩を始めるまでは、その店のことを知らなかった。", False),
    ("認証には、セッションではなくJWTを使う。", True),
    ("ここに、あなたのメモが並びます。", True),
    ("私は、そういう父が好きだ。", True),
    ("終了日までに、写真の書き出しをお願いいたします。", True),
    ("私の強みは、課題に気づいたら仕組みで解決することです。", False),
]


def main():
    bad = 0
    for s, want in CASES:
        _, why = trim_sentence(s)
        if bool(why) != want:
            bad += 1
            print(f"NG: {s}（{'外した' if why else '残した'}、期待 {'外す' if want else '残す'}）")
    # 定型の前置き・接続詞・コードの中は外さない
    for s in ["お手数ですが、よろしくお願いします。", "ただ、set は順番を保証しない。", "利用は無料で、広告も表示されません。"]:
        if trim_sentence(s)[1]:
            bad += 1
            print(f"NG: 外してはいけない読点を外した：{s}")
    text = "資料を、明日送ります。\n```\nprint('a、b')\n```\n"
    out, _ = trim(text)
    if "print('a、b')" not in out or "資料を明日送ります。" not in out:
        bad += 1
        print("NG: コードブロックの扱い")
    # インラインコード・URLで文を切らない。直前の読点は残す（2.2.1）
    inline = [
        ("設定では、`config.yaml` の値を読み込んでから処理を始めるので、時間がかかります。",
         "設定では、`config.yaml` の値を読み込んでから処理を始めるので、時間がかかります。"),
        ("手順では、`npm install` を実行します。", "手順では、`npm install` を実行します。"),
        ("詳しくは、https://example.com を見てください。", "詳しくは、https://example.com を見てください。"),
        ("資料を、`out.md` に書きます。", "資料を、`out.md` に書きます。"),
        ("値は`a。b`です。次は、これだ。", "値は`a。b`です。次はこれだ。"),
        ("`print('a、b')` を、明日送ります。", "`print('a、b')` を明日送ります。"),
    ]
    for src, want in inline:
        got, _ = trim(src)
        if got != want:
            bad += 1
            print(f"NG: インラインコード・URL：{src} → {got}")
    total = len(CASES) + 4 + len(inline)
    print(f"{total - bad}/{total} OK")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
