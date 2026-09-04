# -*- coding: utf-8 -*-
# signal-core.js(判定ロジック本体)と worker_body.js(Worker固有部分)を連結して
# notify_worker/worker.js を生成する。Cloudflare ダッシュボードにそのまま貼り付けられる
# 単一ファイルにするため。signal-core.js を変更したら必ず再生成すること:
#   python notify_worker/build_worker.py
import pathlib

here = pathlib.Path(__file__).resolve().parent
root = here.parent

core = (root / "signal-core.js").read_text(encoding="utf-8")
body = (here / "worker_body.js").read_text(encoding="utf-8")

header = (
    "// [自動生成] `python notify_worker/build_worker.py` で\n"
    "// signal-core.js + worker_body.js から生成。直接編集しない。\n"
    "// signal-core.js を変更したら再生成してから Cloudflare に貼り直すこと。\n\n"
)

out = header + core.rstrip() + "\n\n" + body
(here / "worker.js").write_text(out, encoding="utf-8")
print(f"wrote {here / 'worker.js'} ({len(out)} bytes)")
