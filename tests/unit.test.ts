/**
 * Pure-logic unit semantics ported from the Python test anchors
 * (test_region_registry.py / test_context_elasticity.py / test_session_tape.py).
 */
import { describe, expect, it } from "vitest";
import {
  ContextBlock, ContextUnfitError, ElasticityController, Fidelity, FreshnessClass,
  InstructionClass, PyTypeError, REGIONS, REGION_META, REGION_ORDER, REGION_ROLES,
  RepresentationLoss, TAPE_ZONE, TapeEntry, ValueError, assertPlacementLaw, composeAfter, contextBlock,
  baseEntry, patchEntry, regionZone, renderProgressSignals, tapeChars, applyUnified, unifiedPatch, _h,
} from "../src/slice/index.js";
import { sliceCapacityChars } from "../src/driver.js";
import { createContinuity, recordUser, fillAssistant, sealTurn, compactTurn, compactTurnSpan } from "../src/continuity.js";

const kw = {
  alternativeGroup: "g",
  priority: 1,
  instructionClass: InstructionClass.DATA,
  freshness: FreshnessClass.LIVE,
  fidelity: Fidelity.FULL,
  representationLoss: RepresentationLoss.NONE,
  content: "c",
};

describe("region registry invariants (test_region_registry.py)", () => {
  it("names are unique", () => {
    const names = REGIONS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("derivation is total (no META/ROLES drift)", () => {
    for (const r of REGIONS) {
      expect(REGION_META.has(r.name)).toBe(true);
      expect(REGION_ROLES.has(r.name)).toBe(true);
      const meta = REGION_META.get(r.name) as readonly [number, InstructionClass, FreshnessClass, boolean];
      expect(meta).toEqual([r.priority, r.instructionClass, r.freshness, r.mandatory]);
      expect(REGION_ROLES.get(r.name)).toBe(r.role);
    }
    expect(REGION_ORDER.map((t) => t[0])).toEqual(REGIONS.map((r) => r.name));
  });

  it("golden layout snapshot (name, zone)", () => {
    expect(REGIONS.map((r) => [r.name, r.zone])).toEqual([
      ["intent", 2], ["task_objective", 2], ["corrections", 2],
      ["task_constraints", 2], ["open_files", 2], ["related_code", 3],
      ["skills", 2], ["memory", 2], ["session_tape", 1],
      ["findings", 5], ["progress", 5], ["world", 5],
      ["threads", 5], ["turn_contract", 6], ["focus", 6],
      ["worktree", 6], ["user_report", 6], ["reconciliation", 6],
      ["error", 6],
    ]);
  });

  it("exactly ONE tape region; HEAD is empty by proof", () => {
    expect(REGIONS.filter((r) => r.zone === TAPE_ZONE).map((r) => r.name)).toEqual(["session_tape"]);
    expect(REGIONS.filter((r) => r.zone === 0)).toEqual([]);
  });

  it("corrections is tier-1 mandatory user authority", () => {
    expect(REGION_META.get("corrections")).toEqual([98, InstructionClass.USER, FreshnessClass.REVISION_BOUND, true]);
    const corr = (REGION_META.get("corrections") as readonly [number, unknown, unknown, unknown])[0];
    const objective = (REGION_META.get("task_objective") as readonly [number, unknown, unknown, unknown])[0];
    expect(corr).toBeGreaterThan(objective);
  });

  it("region_zone is total: unknown names land in the TAIL", () => {
    for (const r of REGIONS) {
      expect(regionZone(r.name)).toBe(r.zone);
      expect(regionZone(`region:${r.name}`)).toBe(r.zone);
    }
    expect(regionZone("active-work")).toBe(2);
    expect(regionZone("active-receipt")).toBe(5);
    expect(regionZone("a-region-invented-next-year")).toBe(2);
  });

  it("the factory refuses a hand-picked slot and derives the lawful one", () => {
    expect(() => contextBlock("intent", { ...kw, blockId: "x", slot: 0 })).toThrow(PyTypeError);
    const blk = contextBlock("intent", { ...kw, blockId: "x" });
    expect(blk.slot).toBe(REGIONS.find((r) => r.name === "intent")?.zone);
  });

  it("the seam rejects any producer above the tape, and tape duplicates", () => {
    for (const [item, slot] of [["region:session_tape", 0], ["region:intent", 0], ["session_tape", 0], ["future-producer", 0]] as const) {
      expect(() => new ContextBlock({ ...kw, blockId: "x", itemId: item, slot })).toThrow(ValueError);
    }
    for (const [item, slot] of [["region:session_tape", 5], ["region:intent", 6]] as const) {
      const blk = new ContextBlock({ ...kw, blockId: "x", itemId: item, slot });
      expect(() => assertPlacementLaw([blk])).toThrow(ValueError);
    }
    const tapes = ["a", "b"].map((id) => new ContextBlock({ ...kw, blockId: id, itemId: "region:session_tape", slot: TAPE_ZONE }));
    expect(() => assertPlacementLaw(tapes)).toThrow(/2 blocks in the TAPE zone/);
    expect(new ContextBlock({ ...kw, blockId: "x", itemId: "future-producer" }).slot).toBe(2);
  });
});

describe("elasticity semantics (test_context_elasticity.py)", () => {
  const block = (name: string, text: string, extra: Partial<ConstructorParameters<typeof ContextBlock>[0]> = {}) =>
    new ContextBlock({
      blockId: `${name}:${(extra.fidelity ?? Fidelity.FULL) as string}`,
      itemId: name,
      alternativeGroup: name,
      priority: 5,
      instructionClass: InstructionClass.TASK_STATE,
      freshness: FreshnessClass.DERIVED,
      fidelity: Fidelity.FULL,
      representationLoss: RepresentationLoss.NONE,
      content: text,
      ...extra,
    });

  it("incomplete representation requires recovery", () => {
    expect(() => block("x", "summary", {
      fidelity: Fidelity.DIGEST,
      representationLoss: RepresentationLoss.SUMMARY,
    })).toThrow(/recovery/);
  });

  it("revision-tagged live excerpt can be re-observed", () => {
    const excerpt = block("file:a", "lines 10-20", {
      fidelity: Fidelity.EXCERPT,
      representationLoss: RepresentationLoss.SELECTION,
      reobservable: true,
    });
    expect(new ElasticityController().select([excerpt]).blocks).toEqual([excerpt]);
  });

  it("mandatory meaning never degrades lossily", () => {
    const exact = block("intent", "do exactly this", { mandatory: true, priority: 100 });
    expect(() => block("intent", "do this", {
      mandatory: true,
      fidelity: Fidelity.DIGEST,
      representationLoss: RepresentationLoss.SUMMARY,
      handles: ["turn:1"],
    })).toThrow(ValueError);
    try {
      new ElasticityController().select([exact], { capacityChars: 3 });
      expect.unreachable("mandatory state that cannot fit must fail honestly");
    } catch (exc) {
      expect(exc).toBeInstanceOf(ContextUnfitError);
      expect((exc as ContextUnfitError).mandatoryItems).toEqual(["intent"]);
    }
  });

  it("legacy execution progress is not projected as cross-turn truth", () => {
    const rendered = renderProgressSignals([
      { kind: "blocked", detail: "spawn_agent failed", count: 13 },
      { kind: "edit", detail: "a.py", count: 1 },
      { kind: "evidence", detail: "new evidence from spawn_agent", count: 11 },
      { kind: "reconciliation", detail: "workspace re-observed", count: 1 },
    ]);
    expect(rendered).not.toContain("spawn_agent");
    expect(rendered).not.toContain("a.py");
    expect(rendered).toBe("- reconciliation: workspace re-observed");
  });
});

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
    // 折叠是罕见事件（实测 300 轮 0–2 次）。频繁重折会打光前缀缓存，
    // 这里钉住它不退化成抖动。
    expect(folds).toBeLessThan(20);
  });
});

describe("slice capacity budget (评审 E)", () => {
  it("returns null only when the model context window is unknown", () => {
    expect(sliceCapacityChars(undefined, "sys", [])).toBeNull();
    expect(sliceCapacityChars(0, "sys", [])).toBeNull();
    expect(sliceCapacityChars(Number.NaN, "sys", [])).toBeNull();
    expect(sliceCapacityChars(100_000, "sys", [])).toBeGreaterThan(0);
  });

  it("subtracts the fixed system prefix and tool schemas from the window", () => {
    const wide = sliceCapacityChars(100_000, "", []);
    const withPrefix = sliceCapacityChars(100_000, "P".repeat(10_000), []);
    const withTools = sliceCapacityChars(100_000, "", [{ name: "t".repeat(5_000) }]);
    expect(withPrefix!).toBeLessThan(wide!);
    expect(withTools!).toBeLessThan(wide!);
  });

  it("clamps to a positive floor instead of falling back to unbounded", () => {
    // 固定开销吃满窗口时回退成 null（=不设限）会让窗口越小越不设限——
    // 正好是错误的失败方向。必须仍给一个正预算。
    const tiny = sliceCapacityChars(100, "P".repeat(50_000), []);
    expect(tiny).not.toBeNull();
    expect(tiny!).toBeGreaterThan(0);
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
  const { searchSessionEvents, renderSearchHits } = require("../src/recall.ts") as typeof import("../src/recall.js");
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
    const es = [ev("turn/start",{turn:2}), long, ev("turn/start",{turn:3}), short];
    const hits = searchSessionEvents(es as never, "deploy token");
    expect(hits[0].turn).toBe(3);
  });
});

