/**
 * Pure-logic unit semantics: tape 条目语义与跨轮连续性。
 *
 * 原文件还含 region registry / elasticity 两组（移植自 test_region_registry.py
 * 与 test_context_elasticity.py）——它们测的分区表、四档保真度和弹性控制器已被
 * src/slice/assemble.ts 取代，随之删除。tape 与 continuity 部分原样保留。
 */
import { describe, expect, it } from "vitest";
import { searchSessionEvents, renderSearchHits } from "../src/recall.js";
import {
  TapeEntry, composeAfter, baseEntry, patchEntry, tapeChars, applyUnified, unifiedPatch, _h,
} from "../src/slice/tape.js";
import { createContinuity, recordUser, fillAssistant, sealTurn, compactTurn, compactTurnSpan } from "../src/continuity.js";


describe("tape entry semantics (test_session_tape.py)", () => {
  it("renderers are deterministic and typed entries round-trip", () => {
    const a = baseEntry("dir/a file.py", "x = 1\n");
    expect(a.kind).toBe("base");
    expect(a.path).toBe("dir/a file.py");
    expect(a.payload).toBe("x = 1\n");
    expect(a.postHash).toBe(_h("x = 1\n"));
    const r = TapeEntry.fromRecord(a.toRecord());
    expect(r.rendered).toBe(a.rendered);
    expect(r.path).toBe(a.path);
    expect(r.payload).toBe(a.payload);
    expect(r.postHash).toBe(a.postHash);
  });

  it("no-trailing-newline roundtrip", () => {
    const e1 = baseEntry("f.py", "x = 1");
    expect(e1.noNl).toBe(true);
    expect(e1.rendered).toContain("no trailing newline");
    const e2 = patchEntry("f.py", "x = 1", "x = 2");
    expect(e2.noNl).toBe(true);
    expect(composeAfter(e1, "")).toBe("x = 1");
    expect(composeAfter(e2, "x = 1")).toBe("x = 2");
    expect(_h(composeAfter(e2, "x = 1"))).toBe(e2.postHash);
  });
});

describe("goal compaction survives ring eviction (评审 #18)", () => {
  it("rewrites the goal by turn number after its ring row is evicted", () => {
    const c = createContinuity();
    const secret = "ORIGINAL SENSITIVE OBJECTIVE TEXT";
    recordUser(c, secret, 1);
    fillAssistant(c, "ok");
    sealTurn(c, { turnId: "slice-turn-1", status: "completed", userRequest: secret, assistantReply: "ok", sessionId: "s" });
    c.goal = secret;
    c.goalTurn = 1;

    // 推够轮数，把第 1 轮挤出对话环（硬顶 12 行）。
    for (let turn = 2; turn <= 30; turn += 1) {
      recordUser(c, `later ${turn}`, turn);
      fillAssistant(c, `reply ${turn}`);
      sealTurn(c, { turnId: `slice-turn-${turn}`, status: "completed", userRequest: `later ${turn}`, assistantReply: `reply ${turn}`, sessionId: "s" });
    }
    expect(c.conversation.some((row) => row.turn === 1)).toBe(false);

    // 宿主遮蔽第 1 轮：goal 必须被改写，原文不得残留在最高权级区块里。
    compactTurn(c, 1, { user: "[redacted by compaction]" }, "s");
    expect(c.goal).toBe("[redacted by compaction]");
    expect(c.goal).not.toContain(secret);
  });
});

describe("multi-turn compaction shrinks the tape (评审 #17)", () => {
  const build = (turns: number) => {
    const c = createContinuity();
    for (let turn = 1; turn <= turns; turn += 1) {
      recordUser(c, `ask ${turn}`, turn);
      fillAssistant(c, `reply ${turn}`);
      sealTurn(c, {
        turnId: `slice-turn-${turn}`, status: "completed",
        userRequest: `ask ${turn}`, assistantReply: `reply ${turn}`, sessionId: "s",
      });
    }
    return c;
  };

  it("replaces a shadowed span with ONE entry instead of copying the summary per turn", () => {
    const c = build(20);
    const before = tapeChars(c.sessionTape);
    const summary = "S".repeat(800);

    compactTurnSpan(c, Array.from({ length: 20 }, (_unused, i) => i + 1), summary, "s");

    // 压缩必须缩小上下文——逐轮重渲会把 3.4k 撑到 31.7k（20 份同一摘要）。
    expect(tapeChars(c.sessionTape)).toBeLessThan(before);
    const copies = c.sessionTape.filter((entry) => entry.rendered.includes(summary)).length;
    expect(copies).toBe(1);
    // 被遮蔽的那批对话条目整体消失，换成一条区间标记。
    expect(c.sessionTape.filter((entry) => entry.kind === "digest")).toHaveLength(0);
    expect(c.sessionTape.filter((entry) => entry.kind === "reply")).toHaveLength(0);
    const marker = c.sessionTape.find((entry) => entry.kind === "epoch");
    expect(marker?.ref).toBe("slice-turn-1");
    expect(marker?.refEnd).toBe("slice-turn-20");
  });

  it("keeps single-turn compaction on the per-entry rewrite path", () => {
    const c = build(3);
    compactTurnSpan(c, [2], "just this one", "s");
    // 单轮无放大：保留逐条重渲（digest 元数据不丢）。
    expect(c.sessionTape.filter((entry) => entry.kind === "epoch")).toHaveLength(0);
    expect(c.sessionTape.filter((entry) => entry.kind === "digest")).toHaveLength(3);
  });

  it("never collapses file anchors — they carry disk state, not conversation", () => {
    const c = build(4);
    c.pendingEdits = [{ path: "a.py", body: "x = 1\n" }];
    sealTurn(c, {
      turnId: "slice-turn-5", status: "completed",
      userRequest: "edit", assistantReply: "done", sessionId: "s",
    });
    const basesBefore = c.sessionTape.filter((entry) => entry.kind === "base").length;
    expect(basesBefore).toBeGreaterThan(0);

    compactTurnSpan(c, [1, 2, 3, 4, 5], "summary", "s");
    expect(c.sessionTape.filter((entry) => entry.kind === "base")).toHaveLength(basesBefore);
  });
});

describe("tape stays bounded over a long session (评审 #16 / G)", () => {
  /**
   * 本项目的唯一卖点是"峰值随任务规模而非会话长度增长"。之前没有任何测试
   * 断言过体积上界——删掉 sealTurn 里的 compactTape GC、或调大预算，CI 照样全绿。
   * 这条门把论点变成可回归的事实。
   */
  const longSession = (turns: number, withFiles: boolean) => {
    const c = createContinuity();
    let folds = 0;
    const sizes: number[] = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const reply = `${"R".repeat(600)}${turn}`;
      recordUser(c, `ask ${turn}`, turn);
      fillAssistant(c, reply);
      if (withFiles) {
        c.pendingEdits = Array.from({ length: 6 }, (_unused, f) => ({
          path: `f${f}.py`, body: `${"L".repeat(3000)}\n// turn ${turn}\n`,
        }));
      }
      const info = sealTurn(c, {
        turnId: `slice-turn-${turn}`, status: "completed",
        // 封存进 tape 的是这里的 reply——必须与环里的同尺寸，否则测不到稳态。
        userRequest: `ask ${turn}`, assistantReply: reply, sessionId: "s",
      });
      folds += info.epochFolds;
      sizes.push(tapeChars(c.sessionTape));
    }
    return { c, folds, sizes };
  };

  it("plateaus instead of growing linearly with turn count", () => {
    const { sizes } = longSession(600, false);
    // 硬上界：GC + fold 必须把 tape 压在预算量级内（实测峰值 ~119.7k / 预算 120k）。
    expect(Math.max(...sizes)).toBeLessThan(200_000);
    // 触顶而非线性：稳态区间（300→600 轮）实测只涨 1.11×。线性增长会 ~2×。
    expect(sizes[599]!).toBeLessThan(sizes[299]! * 1.5);
  });

  it("keeps the tape bounded when every turn edits files", () => {
    const { sizes, folds } = longSession(300, true);
    expect(Math.max(...sizes)).toBeLessThan(200_000);
    // 折叠是罕见事件（实测 300 轮 4 次、约 47 轮一折）。频繁重折会打光前缀
    // 缓存，这里钉住它不退化成抖动——曾抓到 base/patch 选型踩平手刀刃时
    // 折叠飙到 39 次（修复见 continuity.ts 的 0.9 边际）。
    expect(folds).toBeLessThan(20);
  });
});

describe("applyUnified boundary: -0,0 hunk against a non-empty source", () => {
  it("prepends instead of corrupting the file mid-way", () => {
    // hunkPos = oldStart - 1 用到 -0,0 上会得到 -1；负索引不是报错而是【静默损坏】：
    // slice(pos, -1) 丢掉最后一行，插入点还落到文件中间。
    const src = "line1\nline2\nline3\n";
    expect(applyUnified(src, "@@ -0,0 +1,1 @@\n+NEW\n")).toBe("NEW\nline1\nline2\nline3\n");
  });

  it("keeps the in-repo empty-source case correct (this shape IS emitted here)", () => {
    // 本仓库的 unifiedPatch 对空源就会产出 `@@ -0,0 +1 @@`——这个形状是在带内的。
    const patch = unifiedPatch("f.txt", "", "NEW\n");
    expect(patch).toContain("@@ -0,0");
    expect(applyUnified("", patch)).toBe("NEW\n");
  });

  it("round-trips every difflib-produced patch it can emit", () => {
    for (const [before, after] of [
      ["line1\nline2\nline3\n", "NEW\nline1\nline2\nline3\n"],
      ["", "NEW\n"],
      ["a\nb\n", "X\nY\na\nb\n"],
      ["a\nb\n", "c\nd\n"],
      ["a\nb\nc\n", "a\nc\n"],
    ] as const) {
      expect(applyUnified(before, unifiedPatch("f.txt", before, after))).toBe(after);
    }
  });
});

describe("recall_search corpus and flood guard (Reasonix 借鉴)", () => {
  const ev = (type: string, data: unknown) => ({ type, data });
  const events = [
    ev("turn/start", { turn: 1 }),
    ev("user/message", { content: [{ type: "text", text: "deploy with token QQ-91" }] }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [
      { type: "text", text: "using token QQ-91 as instructed" },
      { type: "tool-call", name: "write", arguments: '{"file_path":"cfg.toml"}' },
    ] } }),
    ev("tool/result", { turn: 1, step: 1, message: { content: [{ type: "tool-result", isError: false,
      content: [{ type: "text", text: ("flood ".repeat(500)) + " token QQ-91 buried here" }] }] } }),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];

  it("默认 kind 集不搜普通 tool 输出(防洪),但搜 user/assistant/tool_input", () => {
    const hits = searchSessionEvents(events as never, "token QQ-91");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.kind !== "tool_output")).toBe(true);
  });

  it("显式 kinds:['tool_output'] 才进洪水区", () => {
    const hits = searchSessionEvents(events as never, "buried", { kinds: ["tool_output"] });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe("tool_output");
  });

  it("命中页给出可照抄的 recall_turn 定位符;零命中页给出 tool_output 换挡提示", () => {
    const hits = searchSessionEvents(events as never, "token");
    expect(renderSearchHits("token", hits)).toContain('recall_turn({"turn": "slice-turn-N"})');
    expect(renderSearchHits("nothing", [])).toContain('kinds: ["tool_output"]');
  });

  it("覆盖率优先:含全部查询词的短文档排在词频高的长文档前", () => {
    const long = ev("assistant/message", { turn: 2, step: 1, message: { content: [
      { type: "text", text: "token ".repeat(300) } ] } });
    const short = ev("assistant/message", { turn: 3, step: 1, message: { content: [
      { type: "text", text: "the deploy token is QQ-91" } ] } });
    const es = [
      ev("turn/start",{turn:2}), long, ev("turn/end",{turn:2,reason:{kind:"completed"}}),
      ev("turn/start",{turn:3}), short, ev("turn/end",{turn:3,reason:{kind:"completed"}}),
    ];
    const hits = searchSessionEvents(es as never, "deploy token");
    expect(hits[0].turn).toBe(3);
  });
});

describe("recall_search 评审修复三门(2026-08-12 复审)", () => {
  const ev = (type: string, data: unknown) => ({ type, data });

  it("①未封存的当前轮不进语料,recall 工具自身调用不进 tool_input", () => {
    const events = [
      ev("turn/start", { turn: 1 }),
      ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "the gateway port is 7443" }] } }),
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
      ev("turn/start", { turn: 2 }),
      ev("user/message", { content: [{ type: "text", text: "what gateway port did we pick?" }] }),
      ev("assistant/message", { turn: 2, step: 1, message: { content: [
        { type: "tool-call", name: "recall_search", arguments: '{"query":"gateway port"}' },
      ] } }),
    ];
    const hits = searchSessionEvents(events as never, "gateway port");
    expect(hits.length).toBe(1);
    expect(hits[0].turn).toBe(1);

    // 把 turn 2 封存后再搜:recall 自身的调用即使已进历史,也不得作为
    // tool_input 语料自命中(开轮排除罩不住这条,必须靠名字跳过)。
    const sealed = [...events, ev("turn/end", { turn: 2, reason: { kind: "completed" } })];
    const hits2 = searchSessionEvents(sealed as never, "gateway port");
    expect(hits2.every(h => h.kind !== "tool_input")).toBe(true);
  });

  it("②turn/end 之后注入的消息不归属已封存轮(与 renderSealedTurn 同规)", () => {
    const events = [
      ev("turn/start", { turn: 1 }),
      ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "real turn one" }] } }),
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
      ev("user/message", { content: [{ type: "text", text: "INJECTED BETWEEN TURNS" }] }),
      ev("turn/start", { turn: 2 }),
      ev("turn/end", { turn: 2, reason: { kind: "completed" } }),
    ];
    expect(searchSessionEvents(events as never, "INJECTED BETWEEN")).toEqual([]);
  });

  it("③零命中文案报告实际搜过的 kinds,不建议重复已做的事", () => {
    expect(renderSearchHits("x", [], ["tool_output"])).toContain("kinds tool_output");
    expect(renderSearchHits("x", [], ["tool_output"])).not.toContain('kinds: ["tool_output"]');
    expect(renderSearchHits("x", [])).toContain('kinds: ["tool_output"]');
  });
});

