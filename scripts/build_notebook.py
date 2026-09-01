"""Build the Kaggle notebook from the cell-marked script.

Validates every code cell parses before writing. A notebook that does not
compile is worse than no notebook: the failure surfaces ten minutes into a GPU
session, in a cell whose traceback points at the symptom rather than the cause.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / (sys.argv[1] if len(sys.argv) > 1 else "kaggle_leffa_ood.py")
DST = SRC.with_suffix(".ipynb")


def strip_magics(code: str) -> str:
    """Replace IPython magics with `pass`, preserving indentation.

    Blanking them instead would empty an if/else body and invent a syntax
    error that is not in the real notebook.
    """
    out = []
    for line in code.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("!", "%")):
            out.append(" " * (len(line) - len(stripped)) + "pass")
        else:
            out.append(line)
    return "\n".join(out)


def main() -> int:
    text = SRC.read_text(encoding="utf-8")

    doc = re.match(r'^"""(.*?)"""\s*', text, re.DOTALL)
    header = doc.group(1).strip() if doc else ""
    body = text[doc.end():] if doc else text

    cells: list[tuple[str, str]] = []
    if header:
        cells.append(("markdown", "# Does Leffa handle Pakistani ethnic wear?\n\n" + header))

    parts = re.split(r"^# %%(?: \[markdown\])?\s*$", body, flags=re.MULTILINE)
    markers = re.findall(r"^# %%(?: \[markdown\])?\s*$", body, flags=re.MULTILINE)

    for marker, chunk in zip(markers, parts[1:]):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        if "[markdown]" in marker:
            md = "\n".join(re.sub(r"^# ?", "", ln) for ln in chunk.splitlines())
            cells.append(("markdown", md.strip()))
        else:
            cells.append(("code", chunk))

    failures = []
    for i, (kind, content) in enumerate(cells):
        if kind != "code":
            continue
        try:
            ast.parse(strip_magics(content))
        except SyntaxError as exc:
            failures.append((i, exc))

    if failures:
        print(f"REFUSING TO WRITE - {len(failures)} cell(s) do not parse:", file=sys.stderr)
        for i, exc in failures:
            print(f"  cell {i}: line {exc.lineno}: {exc.msg}", file=sys.stderr)
            lines = cells[i][1].splitlines()
            for n in range(max(1, exc.lineno - 2), min(len(lines), exc.lineno + 1) + 1):
                print(f"      {n:3} | {lines[n-1]}", file=sys.stderr)
        return 1

    def source(s: str) -> list[str]:
        lines = s.splitlines()
        return [ln + "\n" for ln in lines[:-1]] + ([lines[-1]] if lines else [])

    nb = {
        "cells": [
            {
                "cell_type": kind,
                "metadata": {},
                "source": source(content),
                **({"outputs": [], "execution_count": None} if kind == "code" else {}),
            }
            for kind, content in cells
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
            "accelerator": "GPU",
            "kaggle": {"accelerator": "nvidiaTeslaT4", "dataSources": [], "isInternetEnabled": True},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    DST.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")

    code = sum(1 for k, _ in cells if k == "code")
    print(f"wrote {DST.relative_to(ROOT)}")
    print(f"  {len(cells)} cells ({code} code), all parse")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
