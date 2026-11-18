"""Issue #4・#7 の回帰テスト。標準ライブラリだけで実行する。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_meaning import NUM, check, norm
from revert_broken import one_pass


class NumericChecks(unittest.TestCase):
    def test_unknown_units_keep_all_digits(self):
        for value in ("20", "25", "5", "0.5", "20.5", "1,024"):
            with self.subTest(value=value):
                self.assertEqual(NUM.findall(value + "MiB"), [value])

    def test_supported_units_remain_part_of_value(self):
        for value in ("20kg", "20g", "1.5ms", "30分", "3時間", "20MB"):
            with self.subTest(value=value):
                self.assertEqual(NUM.findall(value), [value])

    def test_mib_value_change_is_flagged(self):
        items = check("容量は20MiBです。", "容量は25MiBです。")
        self.assertTrue(any("減ったもの: 20" in item for item in items))
        self.assertTrue(any("増えたもの: 25" in item for item in items))

    def test_single_digit_and_decimal_changes_are_flagged(self):
        for before, after in (("5", "6"), ("0.5", "0.6"), ("20.5", "20.6")):
            with self.subTest(before=before, after=after):
                self.assertTrue(check(f"容量は{before}MiBです。", f"容量は{after}MiBです。"))

    def test_normalization_and_unchanged_values(self):
        self.assertEqual(NUM.findall(norm("２０MiB")), ["20"])
        self.assertEqual(check("容量は20MiBです。", "容量は20MiBです。"), [])


class NoCandidateChecks(unittest.TestCase):
    def test_unchanged_long_text_does_not_compare_sentence_pairs(self):
        text = "\n".join(f"案件{i}の受付は午後3時です。" for i in range(400))
        with patch("revert_broken.best", side_effect=AssertionError("不要な文間比較")):
            self.assertEqual(one_pass(text, text), (text, []))

    def test_equivalent_rewrite_does_not_compare_sentence_pairs(self):
        source = "申請の締め切りは午後3時です。窓口は西口です。"
        draft = "申請の締め切りは15時、窓口は西口です。"
        with patch("revert_broken.best", side_effect=AssertionError("不要な文間比較")):
            self.assertEqual(one_pass(source, draft), (draft, []))

    def test_real_numeric_change_still_restores(self):
        source = "再送は最大2回までです。"
        restored, log = one_pass(source, "再送は最大3回までです。")
        self.assertEqual(restored, source)
        self.assertTrue(log)


if __name__ == "__main__":
    unittest.main()
