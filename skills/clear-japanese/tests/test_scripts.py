"""scripts/ の回帰テスト。 python3 tests/test_scripts.py で動く（標準ライブラリだけ）。

Issue #1・#2 で報告していただいた例と、見落としや戻しすぎが無いかを見る対照の例。
番号や人名はすべて架空。
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")
sys.path.insert(0, SCRIPTS)
from check_meaning import check  # noqa: E402

# (原文, 直した文, 候補が出るべきか)
CHECK_CASES = [
    ("承認は佐藤さん、公開は鈴木さんが担当します。", "承認は鈴木さん、公開は佐藤さんが担当します。", True),
    ("東京は10時に開始します。大阪は13時に開始します。", "東京は13時に開始します。大阪は10時に開始します。", True),
    ("旧版は使えません。新版は使えます。", "旧版は使えます。新版は使えません。", True),
    ("耐荷重は20kgです。", "耐荷重は20gです。", True),
    ("再送は最大2回までです。", "再送は最大3回までです。", True),
    # 意味が変わっていないので、候補は出ない
    ("申請の締め切りは午後3時です。窓口は西口です。", "申請の締め切りは15時、窓口は西口です。", False),
    ("承認は佐藤さんが担当します。期限は金曜です。", "期限は金曜で、承認は佐藤さんが担当します。", False),
    ("東京は10時に開始します。", "東京では10時に始めます。", False),
    # Issue #6：共通の文頭がある文、1文字の話題
    ("本番では旧版は使えません。本番では新版は使えます。", "本番では旧版は使えます。本番では新版は使えません。", True),
    ("東は10時に開始します。西は13時に開始します。", "東は13時に開始します。西は10時に開始します。", True),
    ("では、始めます。", "では、始めましょう。", False),
]

# (原文, 直した文, 依頼, 戻した後に残っているべき文字列, 戻した後に無いべき文字列)
REVERT_CASES = [
    ("お問い合わせ番号は4821-0093です。", "お問い合わせ番号は［非公開］です。",
     "お問い合わせ番号4821-0093を［非公開］に置き換えてください。", ["［非公開］"], ["4821-0093"]),
    ("申請の締め切りは午後3時です。窓口は西口です。", "申請の締め切りは15時、窓口は西口です。",
     "時刻を24時間表記にして、締め切りと窓口を一文にまとめてください。", ["15時", "西口"], []),
    # 依頼に無い数値の変更は、これまでどおり戻す
    ("再送は最大2回までです。", "再送は最大3回までです。", "", ["2回"], ["3回"]),
    # まとめた文を戻す時は、まとめた元の文を全部戻す
    ("締め切りは金曜です。窓口は西口です。", "締め切りは土曜、窓口は西口です。", "", ["金曜", "西口"], ["土曜"]),
    # Issue #3：番号を依頼に書かない伏字化、同じ文に別の誤りがある伏字化
    ("予約についてのお問い合わせは03-0000-0000までお願いします。窓口の担当は総務です。",
     "予約についてのお問い合わせは［非公開］までお願いします。窓口の担当は総務です。",
     "外部公開用の原稿です。電話番号を「［非公開］」に置き換えてください。それ以外は元のままにしてください。",
     ["［非公開］", "総務"], ["03-0000-0000"]),
    ("電話番号は03-0000-0000で、受付は15時までです。", "電話番号は［非公開］で、受付は16時までです。",
     "電話番号03-0000-0000を［非公開］にしてください。", ["［非公開］", "15時"], ["03-0000-0000", "16時"]),
    # Issue #5：「維持する・変更しない」は、変えてよいという意味ではない
    ("再送は最大2回までです。", "再送は最大5回までです。", "最大2回は維持してください。5回に変更しないでください。",
     ["2回"], ["5回"]),
    # Issue #6：入れ替わった否定を、検出だけでなく戻す
    ("旧版は使えません。新版は使えます。", "旧版は使えます。新版は使えません。", "",
     ["旧版は使えません", "新版は使えます"], ["旧版は使えます", "新版は使えません"]),
]


def run_revert(src, dst, req):
    with tempfile.TemporaryDirectory() as d:
        paths = [os.path.join(d, n) for n in ("src.md", "dst.md", "out.md", "req.md")]
        for p, s in zip(paths, (src, dst, "", req)):
            open(p, "w", encoding="utf-8").write(s)
        cmd = [sys.executable, os.path.join(SCRIPTS, "revert_broken.py"), *paths[:3]]
        if req:
            cmd += ["--request", paths[3]]
        subprocess.run(cmd, check=True, capture_output=True)
        return open(paths[2], encoding="utf-8").read()


def main():
    bad = 0
    for src, dst, want in CHECK_CASES:
        got = bool(check(src, dst))
        if got != want:
            bad += 1
            print(f"NG check: {dst}（候補 {'あり' if got else 'なし'}、期待 {'あり' if want else 'なし'}）")
    for src, dst, req, keep, gone in REVERT_CASES:
        out = run_revert(src, dst, req)
        if any(k not in out for k in keep) or any(g in out for g in gone):
            bad += 1
            print(f"NG revert: {dst} → {out}")
    total = len(CHECK_CASES) + len(REVERT_CASES)
    print(f"{total - bad}/{total} OK")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
