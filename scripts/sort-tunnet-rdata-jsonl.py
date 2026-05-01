#!/usr/bin/env python3
"""
Process **``tunnet-rdata-strings.jsonl``** (from ``extract-tunnet-rdata-strings.py``) by the
JSON **``length``** field.

**Sorted mode (default):** one pass records ``(length, offset)``, sort in memory, second
pass seeks and copies lines. A 900MB file is fine (~16 bytes per line for keys).

**Filter-only mode (**``--no-sort``**):** one streaming pass; **original line order** is
kept. Only lines with ``length`` ≥ ``--min-length`` are written.

Usage::

  # Longest first, preview 40 lines on stdout
  python scripts/sort-tunnet-rdata-jsonl.py --in out/tunnet-rdata-strings.jsonl --head 40

  # Full sorted copy (still large)
  python scripts/sort-tunnet-rdata-jsonl.py --in out/tunnet-rdata-strings.jsonl --out out/tunnet-rdata-strings-by-length.jsonl

  # Shortest first
  python scripts/sort-tunnet-rdata-jsonl.py --in out/tunnet-rdata-strings.jsonl --head 30 --ascending

  # Drop short runs then sort
  python scripts/sort-tunnet-rdata-jsonl.py --in out/tunnet-rdata-strings.jsonl --min-length 32 --out out/long-only-sorted.jsonl

  # Drop short runs, **keep input order** (no sort)
  python scripts/sort-tunnet-rdata-jsonl.py --in out/tunnet-rdata-strings.jsonl --no-sort --min-length 32 --out out/long-only.jsonl
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# ``length`` appears before ``value`` in records from extract-tunnet-rdata-strings.py.
_LEN_RE = re.compile(br'"length"\s*:\s*(\d+)')


def length_from_line(line: bytes) -> int:
    m = _LEN_RE.search(line)
    if not m:
        raise ValueError(f"missing length field in line: {line[:120]!r}")
    return int(m.group(1))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--in",
        dest="in_path",
        type=Path,
        default=Path("out/tunnet-rdata-strings.jsonl"),
        help="Input JSONL (default: out/tunnet-rdata-strings.jsonl)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write full sorted JSONL here (optional)",
    )
    ap.add_argument(
        "--head",
        type=int,
        default=None,
        metavar="N",
        help="Write at most N lines to stdout after sort/filter (UTF-8); order matches mode",
    )
    ap.add_argument(
        "--no-sort",
        action="store_true",
        help="Single pass: filter by --min-length only, preserve original file order (ignores --ascending)",
    )
    ap.add_argument(
        "--ascending",
        action="store_true",
        help="Shortest first when sorting (default: longest first); ignored with --no-sort",
    )
    ap.add_argument(
        "--min-length",
        type=int,
        default=0,
        metavar="N",
        help="Omit records whose JSON ``length`` field is below N (default: 0 = keep all)",
    )
    args = ap.parse_args()

    if not args.in_path.is_file():
        print(f"error: input not found: {args.in_path}", file=sys.stderr)
        return 1

    if args.out is None and args.head is None:
        print(
            "error: specify --out FILE and/or --head N (refusing to dump entire file to stdout)",
            file=sys.stderr,
        )
        return 1

    if args.min_length < 0:
        print("error: --min-length must be >= 0", file=sys.stderr)
        return 1

    if args.no_sort:
        return _run_filter_only(args)

    keys: list[tuple[int, int]] = []
    total_in = 0
    skipped_short = 0
    with args.in_path.open("rb") as f:
        while True:
            off = f.tell()
            line = f.readline()
            if not line:
                break
            if not line.strip():
                continue
            total_in += 1
            try:
                ln = length_from_line(line)
            except ValueError as e:
                print(f"error at offset {off}: {e}", file=sys.stderr)
                return 1
            if ln < args.min_length:
                skipped_short += 1
                continue
            keys.append((ln, off))

    rev = not args.ascending
    # Stable tie-break: original file order (``off``) when ``length`` matches.
    keys.sort(key=lambda t: (-t[0], t[1]) if rev else (t[0], t[1]))

    out_fp = args.out.open("wb") if args.out else None
    try:
        n_print = 0
        with args.in_path.open("rb") as f:
            for _ln, off in keys:
                f.seek(off)
                line = f.readline()
                if out_fp:
                    out_fp.write(line)
                if args.head is not None and n_print < args.head:
                    sys.stdout.buffer.write(line)
                    n_print += 1
                if out_fp is None and args.head is not None and n_print >= args.head:
                    break
    finally:
        if out_fp:
            out_fp.close()

    print(
        f"[sort-rdata-jsonl] mode=sort read={total_in} kept={len(keys)} omitted_short={skipped_short} min_length={args.min_length} "
        f"order={'desc' if rev else 'asc'} out={args.out or '-'} "
        f"printed_head={args.head if args.head is not None else 0}",
        file=sys.stderr,
    )
    return 0


def _run_filter_only(args: argparse.Namespace) -> int:
    total_in = 0
    omitted_short = 0
    kept = 0
    n_print = 0
    out_fp = args.out.open("wb") if args.out else None
    try:
        with args.in_path.open("rb") as f:
            while True:
                off = f.tell()
                line = f.readline()
                if not line:
                    break
                if not line.strip():
                    continue
                total_in += 1
                try:
                    ln = length_from_line(line)
                except ValueError as e:
                    print(f"error at offset {off}: {e}", file=sys.stderr)
                    return 1
                if ln < args.min_length:
                    omitted_short += 1
                    continue
                kept += 1
                if out_fp:
                    out_fp.write(line)
                if args.head is not None and n_print < args.head:
                    sys.stdout.buffer.write(line)
                    n_print += 1
                if out_fp is None and args.head is not None and n_print >= args.head:
                    break
    finally:
        if out_fp:
            out_fp.close()

    print(
        f"[sort-rdata-jsonl] mode=filter(no-sort) read={total_in} kept={kept} omitted_short={omitted_short} "
        f"min_length={args.min_length} out={args.out or '-'} "
        f"printed_head={args.head if args.head is not None else 0}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
