#!/usr/bin/env python3
"""
Extract printable ASCII runs from PE read-only sections of tunnet.exe (default: .rdata).

There is **no VA/file-offset window**: each named section is scanned from **first to last byte**
of its on-disk raw size (PE VirtualSize / raw length). Default is **``.rdata``** only; use
``--sections .rdata,.text`` to add more (noisier). **No content filtering**—every run is written
to ``--out``. Use ``rg`` / ``grep`` on that JSONL to narrow by phrase.

Default ``--min-len 0`` means **no minimum**: every isolated printable ASCII run (length >= 1).
On a full Tunnet build this can produce **millions** of lines and a **multi‑GB** JSONL file—use
``--min-len 4`` (or higher) if you only want longer runs.

Writes one JSONL file (one JSON object per line: ``section``, ``fileOffset``, ``rva``, ``va``,
``length``, ``value``).

Usage:
  python scripts/extract-tunnet-rdata-strings.py
  python scripts/extract-tunnet-rdata-strings.py --min-len 12
  python scripts/extract-tunnet-rdata-strings.py --sections .rdata,.text
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from struct import unpack


def pe_sections(path: Path) -> tuple[int, list[tuple[str, int, int, int, int]]]:
    d = path.read_bytes()
    e_lfanew = unpack("<I", d[0x3C:0x40])[0]
    coff_off = e_lfanew + 4
    nsec = unpack("<H", d[coff_off + 2 : coff_off + 4])[0]
    size_opt = unpack("<H", d[coff_off + 16 : coff_off + 18])[0]
    sec_off = e_lfanew + 24 + size_opt
    img = unpack("<Q", d[e_lfanew + 24 + 24 : e_lfanew + 24 + 32])[0]
    secs: list[tuple[str, int, int, int, int]] = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = d[o : o + 8].split(b"\0", 1)[0].decode(errors="replace")
        vsz, va, rsz, raw = unpack("<IIII", d[o + 8 : o + 24])
        secs.append((name, va, vsz, raw, rsz))
    return img, secs


def extract_runs(buf: bytes, min_len: int) -> list[tuple[int, int, bytes]]:
    """Return list of (start_index, end_exclusive, bytes) for contiguous printable ASCII."""
    m = 1 if min_len <= 0 else min_len
    out: list[tuple[int, int, bytes]] = []
    start: int | None = None
    for i, b in enumerate(buf):
        if 32 <= b < 127:
            if start is None:
                start = i
        else:
            if start is not None and i - start >= m:
                out.append((start, i, buf[start:i]))
            start = None
    if start is not None and len(buf) - start >= m:
        out.append((start, len(buf), buf[start:]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--exe",
        type=Path,
        default=Path(r"C:/Steam/steamapps/common/Tunnet/tunnet.exe"),
        help="Path to tunnet.exe",
    )
    ap.add_argument(
        "--min-len",
        type=int,
        default=0,
        help="Minimum run length (default 0 = no minimum: every run of length >= 1). Use N>=1 to filter.",
    )
    ap.add_argument(
        "--sections",
        default=".rdata",
        help="Comma-separated PE section names (default .rdata)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=Path("out/tunnet-rdata-strings.jsonl"),
        help="Output JSONL path",
    )
    args = ap.parse_args()
    if not args.exe.is_file():
        print(f"error: exe not found: {args.exe}", file=sys.stderr)
        return 1

    img, secs = pe_sections(args.exe)
    want = {n.strip() for n in args.sections.split(",") if n.strip()}
    raw_blob = args.exe.read_bytes()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    eff_min = 1 if args.min_len <= 0 else args.min_len

    with args.out.open("w", encoding="utf-8") as out_fp:
        for name, va, _vsz, raw, rsz in secs:
            if name not in want:
                continue
            buf = raw_blob[raw : raw + rsz]
            for start, end, chunk in extract_runs(buf, args.min_len):
                file_off = raw + start
                rva = va + start
                va_abs = img + rva
                try:
                    text = chunk.decode("ascii")
                except UnicodeDecodeError:
                    continue
                rec = {
                    "section": name,
                    "fileOffset": file_off,
                    "rva": rva,
                    "va": va_abs,
                    "length": len(text),
                    "value": text,
                }
                out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
                total += 1

    print(
        f"[extract-strings] wrote {args.out} lines={total} minLen={args.min_len} (effective {eff_min}) sections={sorted(want)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
