"""依頼で許した直しの範囲と、入れ替わった文の戻し方の回帰テスト（#10〜#13）。

    python3 tests/test_request_scope.py
"""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "revert_broken.py")
CHECK = os.path.join(ROOT, "scripts", "check_meaning.py")


def run(src, draft, request=""):
    with tempfile.TemporaryDirectory() as t:
        paths = {k: os.path.join(t, k + ".txt") for k in ("source", "draft", "request", "final")}
        for k, v in (("source", src), ("draft", draft), ("request", request)):
            with open(paths[k], "w", encoding="utf-8") as f:
                f.write(v)
        args = [sys.executable, SCRIPT, paths["source"], paths["draft"], paths["final"]]
        if request:
            args += ["--request", paths["request"]]
        subprocess.run(args, check=True, capture_output=True)
        with open(paths["final"], encoding="utf-8") as f:
            return f.read().strip()


class SwappedSentences(unittest.TestCase):
    """#10：入れ替わった2文は、それぞれの位置で戻し、誤った文を残さない。"""

    def test_names(self):
        self.assertEqual(run("承認者は佐藤さんです。公開者は鈴木さんです。",
                             "承認者は鈴木さんです。公開者は佐藤さんです。"),
                         "承認者は佐藤さんです。公開者は鈴木さんです。")

    def test_times(self):
        self.assertEqual(run("東は10時に開始します。西は13時に開始します。",
                             "東は13時に開始します。西は10時に開始します。"),
                         "東は10時に開始します。西は13時に開始します。")

    def test_three_sentences_middle_swap(self):
        src = "受付は9時です。東は10時に開始します。西は13時に開始します。"
        self.assertEqual(run(src, "受付は9時です。東は13時に開始します。西は10時に開始します。"), src)


class RequestedChangeInSameSentence(unittest.TestCase):
    """#11：同じ文の誤りを戻しても、依頼で許した時刻変更は残す。"""

    def test_keep_requested_time(self):
        self.assertEqual(run("受付は15時で、定員は20名です。", "受付は16時で、定員は25名です。",
                             "受付を15時から16時に変更してください。定員は20名を維持してください。"),
                         "受付は16時で、定員は20名です。")

    def test_without_request_both_revert(self):
        self.assertEqual(run("受付は15時で、定員は20名です。", "受付は16時で、定員は25名です。"),
                         "受付は15時で、定員は20名です。")


class DeleteOrPlainMask(unittest.TestCase):
    """#12：削除や括弧なしの伏字でも、伏せた番号を戻さない。"""
    SRC = "お問い合わせは03-0000-0000までお願いします。"

    def test_delete(self):
        self.assertEqual(run(self.SRC, "お問い合わせをお願いします。", "電話番号を削除してください。"),
                         "お問い合わせをお願いします。")

    def test_plain_mask(self):
        self.assertEqual(run(self.SRC, "お問い合わせは非公開までお願いします。", "電話番号を伏せてください。"),
                         "お問い合わせは非公開までお願いします。")

    def test_delete_without_request_reverts(self):
        self.assertEqual(run(self.SRC, "お問い合わせをお願いします。"), self.SRC)

    def test_unrelated_request_reverts(self):
        self.assertEqual(run(self.SRC, "お問い合わせをお願いします。", "敬語を少しやわらかくしてください。"),
                         self.SRC)


class MaskScope(unittest.TestCase):
    """#13：伏字は、伏せるよう頼まれた項目だけに認める。"""

    def test_keep_capacity(self):
        self.assertEqual(run("電話番号は03-0000-0000で、定員は20名です。",
                             "電話番号は［非公開］で、定員は［無料］です。",
                             "電話番号を伏せ、定員は20名を維持してください。"),
                         "電話番号は［非公開］で、定員は20名です。")

    def test_capacity_not_named(self):
        self.assertEqual(run("電話番号は03-0000-0000で、定員は20名です。",
                             "電話番号は［非公開］で、定員は［非公開］です。",
                             "電話番号を伏せてください。"),
                         "電話番号は［非公開］で、定員は20名です。")

    def test_email_mask_still_kept(self):
        self.assertEqual(run("連絡先はtaro@example.invalidです。", "連絡先は［非公開］です。",
                             "連絡先を［非公開］にしてください。"),
                         "連絡先は［非公開］です。")


if __name__ == "__main__":
    unittest.main()
