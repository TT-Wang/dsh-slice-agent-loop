/**
 * Pure-logic unit semantics ported from the Python test anchors
 * (test_region_registry.py / test_context_elasticity.py / test_session_tape.py).
 */
import { describe, expect, it } from "vitest";
import {
  ContextBlock, ContextUnfitError, ElasticityController, Fidelity, FreshnessClass,
  InstructionClass, PyTypeError, REGIONS, REGION_META, REGION_ORDER, REGION_ROLES,
  RepresentationLoss, TAPE_ZONE, TapeEntry, ValueError, assertPlacementLaw, composeAfter, contextBlock,
  baseEntry, patchEntry, regionZone, renderProgressSignals, _h,
} from "../src/slice/index.js";

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
