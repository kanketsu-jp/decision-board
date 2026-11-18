"""Issue #9。依頼で伏せた連絡先を差し込み処理が復活させないことを確かめる。"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/revert_broken.py"
SOURCE = "連絡先はtaro@example.invalidです。"
MASKED = "連絡先は［非公開］です。"
REQUEST = "連絡先を［非公開］にしてください。"


def revert(source, draft, request):
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        for name, text in (("source", source), ("draft", draft), ("request", request)):
            (folder / (name + ".txt")).write_text(text, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(SCRIPT),
             str(folder / "source.txt"), str(folder / "draft.txt"),
             str(folder / "final.txt"), "--request", str(folder / "request.txt")],
            capture_output=True, check=True,
        )
        return (folder / "final.txt").read_text(encoding="utf-8"), result.stdout.decode("utf-8")


class RedactedInsertionTests(unittest.TestCase):
    def test_masked_email_is_kept_once(self):
        actual, log = revert(SOURCE, MASKED, REQUEST)
        self.assertEqual(actual, MASKED)
        self.assertIn("残っている候補", log)

    def test_masked_sentence_after_other_content(self):
        prefix = "資料の提出期限は金曜です。\n"
        actual, _ = revert(prefix + SOURCE, prefix + MASKED, REQUEST)
        self.assertEqual(actual, prefix + MASKED)

    def test_unrelated_error_is_restored(self):
        source = SOURCE + "締め切りは15時です。"
        draft = MASKED + "締め切りは16時です。"
        actual, _ = revert(source, draft, REQUEST)
        self.assertEqual(actual, MASKED + "締め切りは15時です。")

    def test_error_in_same_sentence_is_restored(self):
        source = "連絡先はtaro@example.invalidで、締め切りは15時です。"
        draft = "連絡先は［非公開］で、締め切りは16時です。"
        actual, _ = revert(source, draft, REQUEST)
        self.assertEqual(actual, "連絡先は［非公開］で、締め切りは15時です。")

    def test_repeat_does_not_reinsert_email(self):
        first, _ = revert(SOURCE, MASKED, REQUEST)
        second, _ = revert(SOURCE, first, REQUEST)
        self.assertEqual(second, MASKED)

    def test_multiple_redacted_contacts(self):
        source = SOURCE + "担当者のメールはhanako@example.invalidです。"
        draft = MASKED + "担当者のメールは［非公開］です。"
        actual, _ = revert(source, draft, "メールアドレスを［非公開］にしてください。")
        self.assertEqual(actual, draft)

    def test_multiple_masks_in_one_sentence(self):
        source = "連絡先はtaro@example.invalidとhanako@example.invalidです。"
        draft = "連絡先は［非公開］と［非公開］です。"
        actual, _ = revert(source, draft, "メールアドレスを［非公開］にしてください。")
        self.assertEqual(actual, draft)

    def test_mask_inside_existing_brackets(self):
        source = "連絡先は[taro@example.invalid]です。"
        draft = "連絡先は[非公開]です。"
        actual, _ = revert(source, draft, "連絡先を[非公開]にしてください。")
        self.assertEqual(actual, draft)

    def test_existing_missing_content_restoration(self):
        source = "申請書の提出期限は金曜です。窓口は西口です。"
        actual, _ = revert(source, "窓口は西口です。", "")
        self.assertIn("申請書の提出期限は金曜です。", actual)

    def test_mask_without_request_does_not_disable_restoration(self):
        actual, _ = revert(SOURCE, MASKED, "")
        self.assertIn(SOURCE, actual)

    def test_unrelated_missing_sentence_is_restored_with_mask_request(self):
        missing = "申請書の提出期限は金曜です。"
        actual, _ = revert(missing + SOURCE, MASKED, REQUEST)
        self.assertIn(missing, actual)
        self.assertEqual(actual.count(MASKED), 1)
        self.assertNotIn("taro@example.invalid", actual)

    def test_different_contact_label_does_not_suppress_missing_sentence(self):
        source = SOURCE + "担当者は［非公開］です。"
        actual, _ = revert(source, "担当者は［非公開］です。", "担当者の名前を伏せてください。")
        self.assertIn(SOURCE, actual)


class DeletedOrRewordedContactTests(unittest.TestCase):
    """Issue #18。行ごと消した連絡先や、言い換えて伏せた連絡先を差し込まない。"""

    def test_deleted_line_is_not_reinserted(self):
        source = SOURCE + "\n締め切りは15時です。\n"
        draft = "締め切りは15時です。\n"
        actual, log = revert(source, draft, "メールアドレスを含む行を削除してください。")
        self.assertEqual(actual, draft)
        self.assertIn("残っている候補", log)

    def test_reworded_masked_sentence_is_not_reinserted(self):
        draft = "お問い合わせ先は［非公開］です。\n"
        actual, _ = revert(SOURCE + "\n", draft, "メールアドレスを伏せ、文章を自然にしてください。")
        self.assertEqual(actual, draft)

    def test_dropped_line_without_request_is_restored(self):
        source = SOURCE + "\n締め切りは15時です。\n"
        actual, _ = revert(source, "締め切りは15時です。\n", "文章を自然にしてください。")
        self.assertIn("taro@example.invalid", actual)


if __name__ == "__main__":
    unittest.main()
