#!/usr/bin/env python3
"""
Find every ``call`` in ``.text`` that targets **`sub_140673b40`** (uniform index into a
small vector of ``(char*, len)`` rows — Tunnet’s subject / copy line picker), then decode
the **string literals** referenced by the ``lea rax, [rip+disp]`` rows immediately above
each call (same codegen family as Binary Ninja disassembly for ``sub_1402f9a40``).

**Limitations (still useful “all pools in this pattern”):**

- On the stock Steam build this targets **25** ``call`` sites; **22** decode to full
  string lists. **3** remain ``fail`` (linear scan cannot see the slot table: XMM spill /
  duplicate-site tail / ``jmp`` to a distant builder): call RVAs ``0x2fb46a``,
  ``0x2fb782``, ``0x2fb82c``. Use Binary Ninja / a CFG-aware disassembler for those.
- Only resolves **RIP-relative ``lea rax, [rip+disp]``** rows plus the matching
  ``mov [rsi|rbx|rdi+r],`` / ``mov qword [rsp+disp],`` noise we recognize.
- **Does not** map a pool to HLIL / “packet profile” — you get **RVA of the call site**
  and the string list; correlate to the simulator separately.
- **Image-relative RVAs** assume the default Tunnet image base **``0x140000000``** (PE
  optional header); the callee RVA is ``0x673b40``.

Writes JSON (default ``out/packet-string-pools.json``) with one record per call site.

Usage::

  python scripts/extract-packet-string-pools.py
  python scripts/extract-packet-string-pools.py --exe path/to/tunnet.exe --out out/pools.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from struct import unpack
from typing import Any


def pe_load(path: Path) -> tuple[bytes, int, list[tuple[str, int, int, int, int]]]:
    p = path.read_bytes()
    e_lfanew = unpack("<I", p[0x3C:0x40])[0]
    coff_off = e_lfanew + 4
    nsec = unpack("<H", p[coff_off + 2 : coff_off + 4])[0]
    size_opt = unpack("<H", p[coff_off + 16 : coff_off + 18])[0]
    sec_off = e_lfanew + 24 + size_opt
    opt = e_lfanew + 24
    img = unpack("<Q", p[opt + 24 : opt + 32])[0]
    secs: list[tuple[str, int, int, int, int]] = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = p[o : o + 8].split(b"\0", 1)[0].decode(errors="replace")
        vsz, va, rsz, raw = unpack("<IIII", p[o + 8 : o + 24])
        secs.append((name, va, vsz, raw, rsz))
    return p, img, secs


def abs_to_file_off(p: bytes, img: int, secs: list[tuple[str, int, int, int, int]], abs_addr: int) -> int | None:
    rva = abs_addr - img
    for _n, sva, _vsz, raw, rsz in secs:
        if sva <= rva < sva + rsz:
            return raw + (rva - sva)
    return None


def read_str(p: bytes, off: int | None, ln: int) -> str | None:
    if off is None or ln < 0 or ln > 65536:
        return None
    b = p[off : off + ln]
    if len(b) != ln:
        return None
    return b.decode("ascii", errors="replace")


def find_text(p: bytes, secs: list[tuple[str, int, int, int, int]]) -> tuple[bytes, int] | tuple[None, None]:
    for name, va, _vsz, raw, rsz in secs:
        if name == ".text":
            return p[raw : raw + rsz], va
    return None, None


def callee_rva_from_pe(img: int, p: bytes) -> int | None:
    """RVA of sub_140673b40 = VA 0x140673b40 - image base (default build)."""
    e_lfanew = unpack("<I", p[0x3C:0x40])[0]
    opt = e_lfanew + 24
    base = unpack("<Q", p[opt + 24 : opt + 32])[0]
    target_va = 0x140673B40
    if base != img:
        return None
    return target_va - base


def find_calls_to(text: bytes, text_va: int, img: int, callee_rva: int) -> list[int]:
    target_va = img + callee_rva
    hits: list[int] = []
    for j in range(len(text) - 5):
        if text[j] != 0xE8:
            continue
        disp = unpack("<i", text[j + 1 : j + 5])[0]
        rip = img + text_va + j + 5
        if rip + disp == target_va:
            hits.append(j)
    return hits


def try_skip_rsp_byte(text: bytes, cur: int) -> int:
    # ``mov byte [rsp+0x73], 1`` — 5 bytes, ends immediately before ``lea r8`` / next slot.
    if cur >= 5 and text[cur - 5 : cur] == b"\xc6\x44\x24\x73\x01":
        return cur - 5
    return cur


def try_skip_rsp_imm_qword(text: bytes, cur: int) -> int:
    """``mov qword [rsp+disp8], imm32`` (``48 c7 44 24`` + disp8 + imm32) — 9 bytes, before ``lea r8``."""
    if cur >= 9 and text[cur - 9 : cur - 5] == b"\x48\xc7\x44\x24":
        return cur - 9
    return cur


def apply_pre_slot_skips(text: bytes, cur: int) -> int:
    """Peel known stack/setup noise immediately below ``lea r8`` / before the first slot."""
    for _ in range(8):
        nxt = try_skip_rsp_byte(text, cur)
        nxt = try_skip_rsp_imm_qword(text, nxt)
        if nxt == cur:
            break
        cur = nxt
    return cur


def parse_mov_edx_pool(text: bytes, j_e8: int) -> tuple[int, int, str] | None:
    """Return (edx_opcode_index, pool_size, rcx_note)."""
    k = j_e8
    # Most sites: ``... BA pool ; mov rcx, reg ; E8`` (``mov`` is 3 bytes, ``mov edx`` is 5).
    if k >= 8 and text[k - 8] == 0xBA:
        opc = text[k - 3 : k]
        if opc in (
            b"\x48\x89\xf1",  # mov rcx, rsi
            b"\x48\x89\xd9",  # mov rcx, rbx
            b"\x48\x89\xf9",  # mov rcx, rdi
            b"\x4c\x89\xf1",  # mov rcx, r14
        ):
            pool = unpack("<I", text[k - 7 : k - 3])[0]
            note = {
                b"\x48\x89\xf1": "rcx_rsi",
                b"\x48\x89\xd9": "rcx_rbx",
                b"\x48\x89\xf9": "rcx_rdi",
                b"\x4c\x89\xf1": "rcx_r14",
            }[opc]
            return k - 8, pool, note
    if k >= 5 and text[k - 5] == 0xBA:
        pool = unpack("<I", text[k - 4 : k])[0]
        return k - 5, pool, "no_rcx_mov"
    return None


def peel_one_slot_backward(
    text: bytes,
    text_va: int,
    img: int,
    p: bytes,
    secs: list[tuple[str, int, int, int, int]],
    cur: int,
) -> tuple[int, str | None, str | None]:
    """
    Peel one (lea rax,rip -> ptr mov -> len mov) group ending at ``cur``.
    Returns (new_cur, string_or_None, error_or_None).
    """
    if cur < 8:
        return cur, None, "trunc"

    # --- length mov (end at cur) ---
    L_len = 0
    len_base = ""  # rsi | rbx | rdi
    len_off = 0

    if cur >= 11 and text[cur - 11 : cur - 8] == b"\x48\xc7\x86":  # mov qword [rsi+disp32], imm32
        L_len = 11
        len_base = "rsi"
        len_off = unpack("<i", text[cur - 8 : cur - 4])[0]
        imm = unpack("<I", text[cur - 4 : cur])[0]
    elif cur >= 11 and text[cur - 11 : cur - 8] == b"\x48\xc7\x87":  # mov qword [rdi+disp32], imm32
        L_len = 11
        len_base = "rdi"
        len_off = unpack("<i", text[cur - 8 : cur - 4])[0]
        imm = unpack("<I", text[cur - 4 : cur])[0]
    elif cur >= 8 and text[cur - 8 : cur - 5] == b"\x48\xc7\x46":
        L_len = 8
        len_base = "rsi"
        len_off = text[cur - 5]
        imm = unpack("<I", text[cur - 4 : cur])[0]
    elif cur >= 8 and text[cur - 8 : cur - 5] == b"\x48\xc7\x43":
        L_len = 8
        len_base = "rbx"
        len_off = text[cur - 5]
        imm = unpack("<I", text[cur - 4 : cur])[0]
    elif cur >= 8 and text[cur - 8 : cur - 5] == b"\x48\xc7\x47":
        L_len = 8
        len_base = "rdi"
        len_off = text[cur - 5]
        imm = unpack("<I", text[cur - 4 : cur])[0]
    else:
        return cur, None, f"unknown_len_tail:{text[max(0,cur-16):cur].hex()}"

    cur -= L_len

    # --- ptr mov into [base + off] ---
    ptr_base = ""
    ptr_off = 0
    L_ptr = 0

    if len_base == "rsi":
        if cur >= 7 and text[cur - 7 : cur - 4] == b"\x48\x89\x86":
            L_ptr = 7
            ptr_base = "rsi"
            ptr_off = unpack("<i", text[cur - 4 : cur])[0]
        elif cur >= 4 and text[cur - 4 : cur - 1] == b"\x48\x89\x46":
            L_ptr = 4
            ptr_base = "rsi"
            ptr_off = text[cur - 1]
        elif cur >= 3 and text[cur - 3 : cur] == b"\x48\x89\x06":
            L_ptr = 3
            ptr_base = "rsi"
            ptr_off = 0
        else:
            return cur + L_len, None, f"unknown_ptr_rsi:{text[max(0,cur-8):cur].hex()}"
    elif len_base == "rbx":
        if cur >= 4 and text[cur - 4 : cur - 1] == b"\x48\x89\x43":
            L_ptr = 4
            ptr_base = "rbx"
            ptr_off = text[cur - 1]
        elif cur >= 3 and text[cur - 3 : cur] == b"\x48\x89\x03":
            L_ptr = 3
            ptr_base = "rbx"
            ptr_off = 0
        else:
            return cur + L_len, None, f"unknown_ptr_rbx:{text[max(0,cur-8):cur].hex()}"
    elif len_base == "rdi":
        if cur >= 4 and text[cur - 4 : cur - 1] == b"\x48\x89\x47":
            L_ptr = 4
            ptr_base = "rdi"
            ptr_off = text[cur - 1]
        elif cur >= 3 and text[cur - 3 : cur] == b"\x48\x89\x07":
            L_ptr = 3
            ptr_base = "rdi"
            ptr_off = 0
        else:
            return cur + L_len, None, f"unknown_ptr_rdi:{text[max(0,cur-8):cur].hex()}"
    else:
        return cur + L_len, None, "internal_len_base"

    if ptr_base != len_base:
        return cur + L_len + L_ptr, None, f"ptr_len_base_mismatch:{ptr_base}!={len_base}"

    if ptr_off + 8 != len_off:
        return cur + L_len + L_ptr, None, f"ptr_len_off_mismatch:ptr{ptr_off}+8!=len{len_off}"

    cur -= L_ptr

    # --- lea rax, [rip+disp] ---
    if cur < 7:
        return cur, None, "trunc_lea"
    if text[cur - 7 : cur - 4] != b"\x48\x8d\x05":
        return cur, None, f"bad_lea:{text[cur-7:cur].hex()}"
    rel = unpack("<i", text[cur - 4 : cur])[0]
    lea_end_rva = text_va + cur
    str_va = img + lea_end_rva + rel
    s = read_str(p, abs_to_file_off(p, img, secs, str_va), imm)
    cur -= 7
    return cur, s, None


def decode_call_site(
    text: bytes,
    text_va: int,
    img: int,
    p: bytes,
    secs: list[tuple[str, int, int, int, int]],
    j_e8: int,
) -> dict[str, Any]:
    call_rva = text_va + j_e8
    parsed = parse_mov_edx_pool(text, j_e8)
    if parsed is None:
        return {
            "callRva": call_rva,
            "callRvaHex": f"0x{call_rva:x}",
            "poolSize": None,
            "strings": [],
            "decodeStatus": "no_mov_edx",
            "rcxNote": None,
        }
    edx_idx, pool, rcx_note = parsed
    cur = edx_idx
    if cur >= 5 and text[cur - 5 : cur] == b"\x4c\x8d\x44\x24\x78":
        cur -= 5
    cur = apply_pre_slot_skips(text, cur)

    out: list[str | None] = []
    err: str | None = None
    for slot in range(min(pool, 256)):
        cur = apply_pre_slot_skips(text, cur)
        cur, s, e = peel_one_slot_backward(text, text_va, img, p, secs, cur)
        if e is not None:
            err = f"slot{slot}:{e}"
            break
        out.append(s)

    if err is None and len(out) != pool:
        err = f"short_slots:{len(out)}!={pool}"

    ok = err is None and all(x is not None for x in out)
    partial = bool(out) and not ok
    st = "ok" if ok else ("partial" if partial else "fail")
    return {
        "callRva": call_rva,
        "callRvaHex": f"0x{call_rva:x}",
        "poolSize": pool,
        "strings": out,
        "decodeStatus": st,
        "decodeError": err,
        "rcxNote": rcx_note,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--exe",
        type=Path,
        default=Path(r"C:/Steam/steamapps/common/Tunnet/tunnet.exe"),
        help="Path to tunnet.exe",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=Path("out/packet-string-pools.json"),
        help="Output JSON path",
    )
    args = ap.parse_args()
    if not args.exe.is_file():
        print(f"error: exe not found: {args.exe}", file=sys.stderr)
        return 1

    p, img, secs = pe_load(args.exe)
    callee_rva = callee_rva_from_pe(img, p)
    if callee_rva is None:
        print("error: unexpected image base (expected 0x140000000)", file=sys.stderr)
        return 1

    text, text_va = find_text(p, secs)
    if text is None or text_va is None:
        print("error: no .text section", file=sys.stderr)
        return 1

    hits = find_calls_to(text, text_va, img, callee_rva)
    rows = [decode_call_site(text, text_va, img, p, secs, j) for j in hits]
    ok_n = sum(1 for r in rows if r["decodeStatus"] == "ok")
    partial_n = sum(1 for r in rows if r["decodeStatus"] == "partial")
    fail_n = sum(1 for r in rows if r["decodeStatus"] == "fail")
    none_n = sum(1 for r in rows if r["decodeStatus"] == "no_mov_edx")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "exe": str(args.exe.resolve()),
        "imageBase": img,
        "calleeRva": callee_rva,
        "calleeRvaHex": f"0x{callee_rva:x}",
        "callSiteCount": len(rows),
        "decodedOkCount": ok_n,
        "decodedPartialCount": partial_n,
        "decodedFailCount": fail_n,
        "noMovEdxCount": none_n,
        "pools": rows,
    }
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"[extract-packet-string-pools] wrote {args.out} sites={len(rows)} ok={ok_n} partial={partial_n} fail={fail_n} no_edx={none_n}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
