"""
Pure utilities ported from ``packages/types/src/index.ts``. These must stay
bit-identical to the TypeScript implementations since content hashes and
token estimates computed here are compared against ones computed by the TS
SDK/server on the same content.
"""

import random
import time
from typing import List, Optional

# offset basis 0xcbf29ce484222325, FNV prime 0x100000001b3 (2**40 + 0x1b3).
# The TS implementation splits these into four 16-bit limbs to stay inside
# double-precision safe-integer math; Python has native arbitrary-precision
# integers, so the direct 64-bit form is equivalent and simpler.
_FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325
_FNV_PRIME_64 = 0x100000001B3
_MASK_64 = 0xFFFFFFFFFFFFFFFF


def _utf16_code_units(text: str) -> List[int]:
    """
    Expand a Python string (sequence of Unicode code points) into the
    sequence of UTF-16 code units JavaScript's ``String.charCodeAt`` would
    see. Python strings index by code point, so a single astral character
    (code point > 0xFFFF) is one Python character but two JS UTF-16 code
    units (a surrogate pair) — this must be split to match JS semantics
    exactly, both for hashing and for token-estimate length.
    """
    units: List[int] = []
    for ch in text:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            units.append(0xD800 + (cp >> 10))
            units.append(0xDC00 + (cp & 0x3FF))
        else:
            units.append(cp)
    return units


def fnv1a64(text: str) -> str:
    """
    FNV-1a 64-bit hash, hex-encoded (16 lowercase chars, zero-padded).
    Iterates UTF-16 code units to match the TS implementation's use of
    ``String.prototype.charCodeAt``, so astral-plane characters (encoded as
    surrogate pairs) hash identically on both sides.
    """
    h = _FNV_OFFSET_BASIS_64
    for unit in _utf16_code_units(text):
        h ^= unit
        h = (h * _FNV_PRIME_64) & _MASK_64
    return format(h, "016x")


def estimate_tokens(text: str) -> int:
    """
    Rough token estimate: ceil(utf16_length / 4). Mirrors the TS
    implementation's use of ``string.length`` (a UTF-16 code unit count),
    not the Python code-point count, so astral characters count as 2.
    """
    length = len(_utf16_code_units(text))
    if length == 0:
        return 0
    return -(-length // 4)  # ceil division without importing math


_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"  # crockford-ish, lowercase


def generate_id(prefix: Optional[str] = None) -> str:
    """
    ULID-like sortable id: 9 chars of base32 timestamp + 14 chars of
    randomness. Mirrors the TS `generateId` bit for bit (same alphabet,
    same digit count, same encoding direction).
    """
    ts = int(time.time() * 1000)
    time_chars: List[str] = []
    for _ in range(9):
        time_chars.append(_ID_ALPHABET[ts % 32])
        ts //= 32
    time_part = "".join(reversed(time_chars))
    rand_part = "".join(random.choice(_ID_ALPHABET) for _ in range(14))
    generated = time_part + rand_part
    return f"{prefix}_{generated}" if prefix else generated
