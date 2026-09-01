#!/usr/bin/env python3
"""behavior-metrics.py — header 去重实验的行为奇偶度量。

从 session.jsonl.zstd 的 assistant/message 帧(data.turn + data.message.content[])提取:
  reads_after_own_edit  自己编辑过的文件又被 read 的次数(冗余重读代理:
                        这些场景无外部改写者,编辑后 tape 合成即现行文本,
                        再读即未行使 hash 信任)
  recall_calls          recall_turn + recall_search 调用数(n1 的命门)
  turns_with_closeout   末条 assistant 消息为纯文本(无 tool-call)的轮数
  turns_total           总轮数

用法: behavior-metrics.py <session.jsonl.zstd 路径>
输出: 单行 JSON。
"""
import io
import json
import sys

import zstandard

READ_TOOLS = {"read", "read_file"}
EDIT_TOOLS = {"write", "write_file", "edit", "edit_file", "apply_patch", "patch"}
RECALL_TOOLS = {"recall_turn", "recall_search"}


def main(path):
    dctx = zstandard.ZstdDecompressor()
    edited = set()
    reads_after_own_edit = 0
    recall_calls = 0
    last_msg_kind = {}  # turn -> "closeout" | "tool"

    with open(path, "rb") as fh, dctx.stream_reader(fh) as raw:
        for line in io.TextIOWrapper(raw, encoding="utf-8"):
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            if frame.get("type") != "assistant/message":
                continue
            data = frame.get("data") or {}
            turn = data.get("turn")
            content = ((data.get("message") or {}).get("content")) or []

            calls = [c for c in content if c.get("type") == "tool-call"]
            has_text = any(
                c.get("type") == "text" and str(c.get("text", "")).strip() for c in content
            )
            for c in calls:
                name = str(c.get("name", "")).lower()
                try:
                    args = json.loads(c.get("arguments") or "{}")
                except ValueError:
                    args = {}
                fp = args.get("file_path") or args.get("path")
                if name in RECALL_TOOLS:
                    recall_calls += 1
                if name in READ_TOOLS and fp and fp in edited:
                    reads_after_own_edit += 1
                if name in EDIT_TOOLS and fp:
                    edited.add(fp)

            if turn is not None:
                last_msg_kind[turn] = "tool" if calls else ("closeout" if has_text else "empty")

    print(json.dumps({
        "reads_after_own_edit": reads_after_own_edit,
        "recall_calls": recall_calls,
        "turns_with_closeout": sum(1 for k in last_msg_kind.values() if k == "closeout"),
        "turns_total": len(last_msg_kind),
    }))


if __name__ == "__main__":
    main(sys.argv[1])
