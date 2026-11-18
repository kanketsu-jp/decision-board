"""Issue #23。伏せた値の戻り、コロンの時刻、負の数、~~~ のコードブロックを確かめる。値はすべて架空。"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from check_meaning import check  # noqa: E402
from trim_commas import trim  # noqa: E402


def revert(source, draft, request):
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        for name, text in (("source", source), ("draft", draft), ("request", request)):
            (folder / (name + ".txt")).write_text(text, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(SCRIPTS / "revert_broken.py"),
             str(folder / "source.txt"), str(folder / "draft.txt"),
             str(folder / "final.txt"), "--request", str(folder / "request.txt")],
            capture_output=True, check=True,
        )
        return (folder / "final.txt").read_text(encoding="utf-8"), result.stdout.decode("utf-8")


class MaskedValueTests(unittest.TestCase):
    def test_split_sentence_does_not_bring_back_masked_phone(self):
        source = "受付窓口の電話番号は090-0000-1111で、受付は15時からです。\n"
        draft = "電話番号は非公開です。受付は16時からです。\n"
        request = "電話番号を伏せてください。受付は16時からに変えてください。\n"
        actual, log = revert(source, draft, request)
        self.assertNotIn("090-0000-1111", actual)
        self.assertIn("16時", actual)
        self.assertIn("残っている候補", log)


class ClockTests(unittest.TestCase):
    def test_requested_clock_time_is_kept(self):
        actual, _ = revert("会議は13:00からです。\n", "会議は14:00からです。\n", "14:00 に変更してください。\n")
        self.assertEqual(actual, "会議は14:00からです。\n")

    def test_named_clock_time_is_kept_and_other_is_restored(self):
        actual, _ = revert("会議は13:00から、懇親会は18:00からです。\n",
                           "会議は14:00から、懇親会は19:00からです。\n",
                           "会議を14:00に変更してください。\n")
        self.assertEqual(actual, "会議は14:00から、懇親会は18:00からです。\n")

    def test_time_request_does_not_allow_other_units(self):
        actual, _ = revert("定員は20名です。\n", "定員は30名です。\n", "14:00 に変更してください。\n")
        self.assertEqual(actual, "定員は20名です。\n")


class SignTests(unittest.TestCase):
    def test_minus_sign_is_checked(self):
        self.assertTrue(check("明日の最低気温は-5℃です。", "明日の最低気温は5℃です。"))

    def test_triangle_minus_is_checked(self):
        self.assertTrue(check("前年比は▲3%です。", "前年比は3%です。"))

    def test_phone_number_is_not_negative(self):
        self.assertEqual(check("電話は090-0000-1111です。", "電話は090-0000-1111です。"), [])


class FenceTests(unittest.TestCase):
    def test_tilde_fence_is_kept(self):
        text = "説明です。\n\n~~~\na = 1、b = 2\n今日は、晴れ\n~~~\n"
        self.assertEqual(trim(text)[0], text)

    def test_text_after_fence_is_still_trimmed(self):
        text = "~~~\nx、y\n~~~\n今日は、晴れ。\n"
        self.assertEqual(trim(text)[0], "~~~\nx、y\n~~~\n今日は晴れ。\n")

    def test_backtick_fence_is_kept(self):
        text = "```py\n今日は、晴れ\n```\n"
        self.assertEqual(trim(text)[0], text)

    def test_unclosed_fence_is_kept_to_end(self):
        text = "~~~\n今日は、晴れ\n"
        self.assertEqual(trim(text)[0], text)


if __name__ == "__main__":
    unittest.main()
