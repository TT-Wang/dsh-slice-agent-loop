/**
 * TS mirror of tests/golden/gen_goldens.py: constructs ctx/blocks/tape entries
 * from cases.json through the PORTED engine and produces the same output strings
 * the Python generator wrote to expected.json. Both sides read the same cases.json.
 */
import {
  ContextBlock, ElasticityController, EpistemicRole, Fidelity, FreshnessClass, InstructionClass,
  RepresentationLoss, assertPlacementLaw, buildContextBlocks, contextBlock, entryFromOp,
  normalizeCtx, renderContextSelection, renderCurrentRequest, renderFindings, renderNow,
  renderRegions, SeedPlan, compactTape, composeAfter, baseEntry, patchEntry, tapeRender,
  unifiedPatch,
} from "../../src/slice/index.js";
import type { SliceCtx, TapeEntryOp } from "../../src/slice/index.js";

type Json = Record<string, unknown>;

/** Recursively expand {"__repeat__": [s, n], "__prefix__": p, "__suffix__": q} -> p + s*n + q. */
export function expand(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "__repeat__" in (v as Json)) {
    const j = v as Json;
    const [s, n] = j.__repeat__ as [string, number];
    return String(j.__prefix__ ?? "") + String(s).repeat(Number(n)) + String(j.__suffix__ ?? "");
  }
  if (Array.isArray(v)) return v.map(expand);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, expand(x)]));
  }
  return v;
}

/** Python json.dumps(obj, ensure_ascii=False) — default separators (", ", ": "). */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  const entries = Object.entries(v as Json).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`);
  return `{${entries.join(", ")}}`;
}

export function errText(exc: unknown): string {
  const anyExc = exc as { pyName?: string; message?: string };
  const name = anyExc.pyName ?? (exc as Error).constructor.name;
  return `${name}: ${(exc as Error).message}`;
}

export function buildCtx(spec: Json): SliceCtx {
  return normalizeCtx(expand(spec) as Json, (text, sources) => renderFindings([text], sources));
}

export function buildBlock(spec: Json): ContextBlock {
  const expanded = expand(spec) as Json;
  const b = { ...(expanded.block as Json | undefined ?? expanded) } as Json;
  const kw: ConstructorParameters<typeof ContextBlock>[0] = {
    blockId: String(b.block_id ?? "x"),
    itemId: String(expanded.item ?? b.item_id ?? ""),
    alternativeGroup: String(b.alternative_group ?? "g"),
    priority: Number(b.priority ?? 5),
    instructionClass: String(b.instruction_class ?? "task_state") as InstructionClass,
    freshness: String(b.freshness ?? "derived") as FreshnessClass,
    fidelity: String(b.fidelity ?? "full") as Fidelity,
    representationLoss: String(b.representation_loss ?? "none") as RepresentationLoss,
    content: String(b.content ?? ""),
    handles: Array.isArray(b.handles) ? (b.handles as string[]).map(String) : [],
    mandatory: Boolean(b.mandatory ?? false),
    reobservable: Boolean(b.reobservable ?? false),
    order: Number(b.order ?? 0),
  };
  const slot = (expanded.block ? expanded.slot : undefined) ?? b.slot;
  if (slot !== undefined) kw.slot = Number(slot);
  if (b.epistemic_role !== undefined) kw.epistemicRole = String(b.epistemic_role) as EpistemicRole;
  return new ContextBlock(kw);
}

export function runCase(caseSpec: Json): string {
  const kind = String(caseSpec.kind);
  try {
    if (kind === "render") {
      return renderRegions(buildCtx((caseSpec.ctx ?? {}) as Json));
    }
    if (kind === "render_capacity") {
      const ctx = buildCtx((caseSpec.ctx ?? {}) as Json);
      const blocks = buildContextBlocks(ctx);
      const sel = new ElasticityController().select(blocks, {
        capacityChars: caseSpec.capacity === undefined ? null : Number(caseSpec.capacity),
      });
      return renderContextSelection(sel);
    }
    if (kind === "assemble") {
      const ctx = buildCtx((caseSpec.ctx ?? {}) as Json);
      const plan = new SeedPlan({
        system: String(caseSpec.system ?? ""),
        blocks: buildContextBlocks(ctx),
        renderBlocks: renderContextSelection,
        requestBlock: renderCurrentRequest(String(caseSpec.request ?? "")),
        nowBlock: renderNow(String(caseSpec.hints ?? "")),
      });
      return plan.project(caseSpec.capacity === undefined ? null : Number(caseSpec.capacity))[1].content;
    }
    if (kind === "tape_render") {
      const entries = (expand(caseSpec.entries) as TapeEntryOp[]).map((op) => entryFromOp(op));
      return tapeRender(entries.filter((e) => e !== null));
    }
    if (kind === "tape_patch_diff") {
      const c = expand(caseSpec) as Json;
      return unifiedPatch(String(c.path), String(c.before), String(c.after));
    }
    if (kind === "tape_compose") {
      const c = expand(caseSpec) as Json;
      const entries = [baseEntry(String(c.path), String(c.base_body))];
      let content = String(c.base_body);
      for (const [before, after] of c.steps as [string, string][]) {
        if (content !== before) throw new Error("compose chain diverged in fixture");
        const e = patchEntry(String(c.path), before, after);
        entries.push(e);
        content = composeAfter(e, content);
      }
      return pyJson({ rendered: entries.map((e) => e.rendered), final: content });
    }
    if (kind === "tape_compact") {
      const c = expand(caseSpec) as Json;
      const tape = (c.entries as TapeEntryOp[]).map((op) => entryFromOp(op))
        .filter((e) => e !== null);
      const files: Record<string, { hash: string; content: string }> = {};
      for (const [p, v] of Object.entries((c.files ?? {}) as Json)) {
        files[p] = { hash: "", content: String((v as Json).content ?? "") };
      }
      const info = compactTape(tape, files, { budget: Number(c.budget) });
      return pyJson({ info, tape: tapeRender(tape) });
    }
    if (kind === "elasticity") {
      let blocks: ContextBlock[];
      try {
        blocks = ((caseSpec.blocks ?? []) as Json[]).map((b) => buildBlock(b));
      } catch (exc) {
        return pyJson({ error: errText(exc) });
      }
      try {
        const sel = new ElasticityController().select(blocks, {
          capacityChars: caseSpec.capacity === undefined ? null : Number(caseSpec.capacity),
        });
        return pyJson({
          blocks: sel.blocks.map((b) => b.blockId),
          pressure: sel.pressure,
          used_chars: sel.usedChars,
          capacity_chars: sel.capacityChars,
        });
      } catch (exc) {
        return pyJson({ error: errText(exc) });
      }
    }
    if (kind === "placement") {
      const out: string[] = [];
      for (const step of caseSpec.steps as Json[]) {
        const op = String(step.op);
        try {
          if (op === "factory") {
            const kw = expand(step.block) as Json;
            const blk = contextBlock(String(step.item), {
              blockId: String(kw.block_id ?? "x"),
              alternativeGroup: String(kw.alternative_group ?? "g"),
              priority: Number(kw.priority ?? 1),
              instructionClass: String(kw.instruction_class ?? "data") as InstructionClass,
              freshness: String(kw.freshness ?? "live") as FreshnessClass,
              fidelity: String(kw.fidelity ?? "full") as Fidelity,
              representationLoss: String(kw.representation_loss ?? "none") as RepresentationLoss,
              content: String(kw.content ?? ""),
              ...(step.slot !== undefined ? { slot: Number(step.slot) } : {}),
            });
            out.push(`ok slot=${blk.slot}`);
          } else if (op === "direct") {
            const blk = buildBlock(step);
            out.push(`ok slot=${blk.slot}`);
          } else if (op === "assert") {
            const blocks = (step.blocks as Json[]).map((b) => buildBlock(b));
            assertPlacementLaw(blocks);
            out.push("ok");
          }
        } catch (exc) {
          out.push(`error ${errText(exc)}`);
        }
      }
      return out.join("\n") + "\n";
    }
    if (kind === "seedplan") {
      const blocks = ((caseSpec.blocks ?? []) as Json[]).map((b) => buildBlock(b));
      const plan = new SeedPlan({
        system: String(caseSpec.system ?? ""),
        blocks,
        renderBlocks: (selection) => selection.blocks.map((b) => b.content).join(""),
        requestBlock: String(caseSpec.request_block ?? ""),
        nowBlock: String(caseSpec.now_block ?? ""),
      });
      const mode = caseSpec.capacity_mode as string | undefined;
      const fixed = plan.fixedUserChars(1);
      let capacity: number | null = null;
      if (mode === "fixed") capacity = fixed;
      else if (mode === "fixed_minus_1") capacity = fixed - 1;
      else if (mode && mode.startsWith("fixed_plus_block_")) {
        capacity = fixed + Array.from(blocks[Number(mode.split("_").at(-1))].content).length;
      }
      try {
        return plan.project(capacity)[1].content;
      } catch (exc) {
        return pyJson({ error: errText(exc) });
      }
    }
    throw new Error(`unknown case kind ${kind}`);
  } catch (exc) {
    return pyJson({ error: errText(exc) });
  }
}
