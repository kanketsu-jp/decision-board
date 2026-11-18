"""原文の1文を直した文で2文に分けた時、revert_broken が戻せるかの試験（Full推敲で「必ず」が落ちた件）。
tests/ に置き、原文・直した文は下の文字列を使う。"""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")

ORIG = ("お疲れ様です。来週のゼミについてなのですが、日程が変更されることになりましたので、ご連絡させていただきます。"
        "来週の水曜日の14時から予定されていたゼミについてですが、先生のご都合により、木曜日の16時からの開始に変更となりました。"
        "場所に関しては変更はなく、いつもの302教室で行われます。"
        "なお、発表担当の方は、資料を水曜日の正午までに共有フォルダにアップロードしていただかなくても大丈夫ですが、"
        "木曜日の朝9時までには必ずアップロードをお願いいたします。よろしくお願いいたします。\n")
DRAFT = ("お疲れ様です。来週のゼミの日程が変わりましたので、ご連絡します。\n\n"
         "先生のご都合により、水曜日14時からの予定だったゼミが、木曜日16時からの開始に変更となりました。場所は変更なく、いつもの302教室です。\n\n"
         "発表担当の方は、資料を木曜日の朝9時までに共有フォルダにアップロードしてください。水曜日の正午までに上げる必要はありません。\n\n"
         "よろしくお願いいたします。\n")


def run(script, *args):
    return subprocess.run([sys.executable, os.path.join(SCRIPTS, script), *args], capture_output=True, text=True, encoding="utf-8")


def test_check_meaning_flags_lost_kanarazu():
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, "a.md"), os.path.join(d, "b.md")
        open(a, "w", encoding="utf-8").write(ORIG); open(b, "w", encoding="utf-8").write(DRAFT)
        out = run("check_meaning.py", a, b).stdout
        assert "「必ず」が減った" in out


def test_revert_split_sentence_restores_kanarazu_without_duplicate():
    with tempfile.TemporaryDirectory() as d:
        a, b, o = (os.path.join(d, x) for x in ("a.md", "b.md", "o.md"))
        open(a, "w", encoding="utf-8").write(ORIG); open(b, "w", encoding="utf-8").write(DRAFT)
        run("revert_broken.py", a, b, o)
        res = open(o, encoding="utf-8").read()
        assert "必ず" in res                      # 落ちた「必ず」が戻る
        assert res.count("水曜日の正午") == 1      # 分けた片方が残って二重にならない
        assert "見直す候補はありません" in run("check_meaning.py", a, o).stdout
