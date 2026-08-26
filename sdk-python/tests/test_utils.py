import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from context_trace.utils import _ID_ALPHABET, estimate_tokens, fnv1a64, generate_id


class TestFnv1a64(unittest.TestCase):
    def test_empty_string(self):
        self.assertEqual(fnv1a64(""), "cbf29ce484222325")

    def test_single_char(self):
        self.assertEqual(fnv1a64("a"), "af63dc4c8601ec8c")

    def test_foobar(self):
        self.assertEqual(fnv1a64("foobar"), "85944171f73967e8")

    def test_astral_plane_char(self):
        # Cross-checked against the TS implementation in
        # packages/types/src/index.ts run under node directly, since JS
        # iterates UTF-16 code units (surrogate pairs) via charCodeAt.
        self.assertEqual(fnv1a64("\U0001F600"), "e5e45a0a241b88d8")  # 😀
        self.assertEqual(fnv1a64("\U0001D11E"), "e5a1aa0a23be6de7")  # 𝄞

    def test_astral_plane_mixed_with_ascii(self):
        self.assertEqual(fnv1a64("a\U0001F600b"), "72aaf0fb746e9b41")

    def test_output_is_lowercase_hex_16_chars(self):
        h = fnv1a64("some arbitrary content")
        self.assertRegex(h, r"^[0-9a-f]{16}$")


class TestEstimateTokens(unittest.TestCase):
    def test_empty_string(self):
        self.assertEqual(estimate_tokens(""), 0)

    def test_ceil_division(self):
        self.assertEqual(estimate_tokens("a"), 1)
        self.assertEqual(estimate_tokens("abcd"), 1)
        self.assertEqual(estimate_tokens("abcde"), 2)
        self.assertEqual(estimate_tokens("a" * 8), 2)
        self.assertEqual(estimate_tokens("a" * 9), 3)

    def test_astral_char_counts_as_two_utf16_units(self):
        # JS `.length` for a single astral character is 2 (surrogate
        # pair), not 1 (Python code point count) — estimate_tokens must
        # use the same UTF-16 length so it matches the TS SDK's estimate
        # for identical content.
        self.assertEqual(estimate_tokens("\U0001F600"), 1)  # ceil(2/4) == 1
        self.assertEqual(estimate_tokens("\U0001F600" * 3), 2)  # ceil(6/4) == 2


class TestGenerateId(unittest.TestCase):
    # Derived from the actual alphabet the implementation uses, rather than
    # a hand-typed character class, so this can't silently drift.
    ID_PATTERN = re.compile(r"^[" + re.escape(_ID_ALPHABET) + r"]{23}$")

    def test_format_without_prefix(self):
        generated = generate_id()
        self.assertRegex(generated, self.ID_PATTERN)
        self.assertEqual(len(generated), 23)  # 9 timestamp + 14 random

    def test_format_with_prefix(self):
        generated = generate_id("ses")
        self.assertTrue(generated.startswith("ses_"))
        rest = generated[len("ses_"):]
        self.assertRegex(rest, self.ID_PATTERN)

    def test_ids_are_distinct(self):
        ids = {generate_id() for _ in range(50)}
        self.assertEqual(len(ids), 50)


if __name__ == "__main__":
    unittest.main()
