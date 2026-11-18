"""表記の修正・値の変更・削除を区別し、許可を別項目に広げない。"""
import sys
import unittest
from pathlib import Path

from test_redacted_insertion import revert

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from revert_broken import remaining


class RequestPermissionsTests(unittest.TestCase):
    SOURCE = "受付は15時で、定員は20名です。"

    def test_style_request_does_not_allow_lost_capacity(self):
        draft = "受付は15時です。"
        request = "定員の表記を自然に直してください。"
        self.assertTrue(remaining(self.SOURCE, draft, request))
        actual, _ = revert(self.SOURCE, draft, request)
        self.assertEqual(actual, self.SOURCE)

    def test_mentioning_original_value_does_not_allow_deletion(self):
        actual, _ = revert(self.SOURCE, "受付は15時です。", "定員20名の表記を自然に直してください。")
        self.assertEqual(actual, self.SOURCE)

    def test_style_request_does_not_allow_changed_capacity(self):
        actual, _ = revert(self.SOURCE, "受付は15時で、定員は25名です。", "定員の表記を自然に直してください。")
        self.assertEqual(actual, self.SOURCE)

    def test_soft_negative_does_not_allow_time_change(self):
        draft = "受付は16時で、定員は20名です。"
        request = "受付を16時に変える必要はありません。"
        self.assertTrue(remaining(self.SOURCE, draft, request))
        actual, _ = revert(self.SOURCE, draft, request)
        self.assertEqual(actual, self.SOURCE)

    def test_same_value_in_other_field_is_not_authorized(self):
        source = "受付は15時です。終了は15時です。"
        draft = "受付は16時です。終了は16時です。"
        request = "受付を15時から16時に変更してください。終了は変更しないでください。"
        expected = "受付は16時です。終了は15時です。"
        self.assertTrue(remaining(source, draft, request))
        actual, log = revert(source, draft, request)
        self.assertEqual(actual, expected)
        self.assertNotIn("残っている候補", log)
        self.assertEqual(remaining(source, expected, request), [])

    def test_same_value_in_same_sentence_is_not_authorized(self):
        source = "受付は15時で、終了は15時です。"
        draft = "受付は16時で、終了は16時です。"
        request = "受付を16時に変更してください。終了は変更しないでください。"
        actual, _ = revert(source, draft, request)
        self.assertEqual(actual, "受付は16時で、終了は15時です。")

    def test_unchanged_occurrence_does_not_consume_permission(self):
        source = "受付は15時です。終了は15時です。"
        draft = "受付は15時です。終了は16時です。"
        request = "受付を16時に変更してください。終了は変更しないでください。"
        self.assertTrue(remaining(source, draft, request))
        actual, _ = revert(source, draft, request)
        self.assertEqual(actual, source)

    def test_reordered_fields_keep_their_permissions(self):
        source = "受付は15時です。終了は15時です。"
        draft = "終了は16時です。受付は16時です。"
        request = "受付を16時に変更してください。終了は変更しないでください。"
        actual, _ = revert(source, draft, request)
        self.assertEqual(actual, "終了は15時です。受付は16時です。")

    def test_same_value_without_explicit_keep(self):
        source = "受付は15時です。終了は15時です。"
        actual, _ = revert(source, "受付は16時です。終了は16時です。", "受付を16時に変更してください。")
        self.assertEqual(actual, "受付は16時です。終了は15時です。")

    def test_numbered_labels_do_not_share_permission(self):
        source = "会場1の受付は15時です。会場2の受付は15時です。"
        draft = "会場1の受付は16時です。会場2の受付は16時です。"
        request = "会場1の受付を15時から16時に変更してください。"
        actual, _ = revert(source, draft, request)
        self.assertEqual(actual, "会場1の受付は16時です。会場2の受付は15時です。")

    def test_target_qualifier_limits_phone_masking(self):
        source = "本人の電話番号は03-0000-0000です。会社の電話番号は03-1111-1111です。"
        draft = "本人の電話番号は［非公開］です。会社の電話番号は［非公開］です。"
        request = "本人の電話番号だけを伏せてください。"
        self.assertTrue(remaining(source, draft, request))
        actual, _ = revert(source, draft, request)
        self.assertEqual(actual, "本人の電話番号は［非公開］です。会社の電話番号は03-1111-1111です。")

    def test_general_phone_request_keeps_both_masks(self):
        source = "本人の電話番号は03-0000-0000です。会社の電話番号は03-1111-1111です。"
        draft = "本人の電話番号は［非公開］です。会社の電話番号は［非公開］です。"
        actual, _ = revert(source, draft, "電話番号を伏せてください。")
        self.assertEqual(actual, draft)

    def test_explicit_change_does_not_allow_deletion(self):
        source = "受付は15時です。"
        request = "受付を16時に変更してください。"
        self.assertTrue(remaining(source, "受付です。", request))
        actual, _ = revert(source, "受付です。", request)
        self.assertEqual(actual, source)

    def test_explicit_deletion_is_kept(self):
        draft = "受付は15時です。"
        actual, _ = revert(self.SOURCE, draft, "定員を削除してください。")
        self.assertEqual(actual, draft)

    def test_comma_separates_change_and_keep(self):
        actual, _ = revert(self.SOURCE, "受付は16時で、定員は25名です。",
                           "受付を15時から16時に変更し、定員は20名を維持してください。")
        self.assertEqual(actual, "受付は16時で、定員は20名です。")

    def test_partial_phone_mask_is_preserved(self):
        source = "お問い合わせは03-0000-0000までお願いします。"
        draft = "お問い合わせは03-****-****までお願いします。"
        actual, _ = revert(source, draft, "電話番号の市外局番以外を伏せてください。")
        self.assertEqual(actual, draft)

    def test_explicit_phone_value_without_phone_label_is_masked(self):
        source = "予約についてのお問い合わせは03-0000-0000までお願いします。受付は15時です。"
        draft = "予約についてのお問い合わせは［非公開］までお願いします。受付は16時です。"
        actual, _ = revert(source, draft, "電話番号03-0000-0000を［非公開］にしてください。")
        self.assertEqual(actual, "予約についてのお問い合わせは［非公開］までお願いします。受付は15時です。")

    def test_unfixable_omission_keeps_warning(self):
        draft = "お知らせです。"
        request = "定員の表記を自然に直してください。"
        actual, log = revert(self.SOURCE, draft, request)
        self.assertTrue("20名" in actual or "残っている候補" in log)

    def test_repeat_is_stable(self):
        source = "受付は15時です。終了は15時です。"
        request = "受付を16時に変更してください。終了は変更しないでください。"
        first, _ = revert(source, "受付は16時です。終了は16時です。", request)
        second, _ = revert(source, first, request)
        self.assertEqual(first, "受付は16時です。終了は15時です。")
        self.assertEqual(second, first)


if __name__ == "__main__":
    unittest.main()
