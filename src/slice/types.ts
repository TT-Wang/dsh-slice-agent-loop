/**
 * context.py port — canonical context planning and elasticity primitives.
 * Selection works in characters (Python len == code points) exactly like the
 * source; token estimation belongs to the model runner.
 */
import { ContextUnfitError, ValueError } from "./internal/errors.js";
import { zoneOf } from "./internal/placement.js";
import { cmpStrings, pylen, pyDedup, pyRepr, pySortStrings } from "./internal/pytext.js";

export enum InstructionClass {
  SYSTEM = "system",
  USER = "user",
  TASK_STATE = "task_state",
  DATA = "data",
}

export enum FreshnessClass {
  LIVE = "live",
  REVISION_BOUND = "revision_bound",
  DERIVED = "derived",
  HISTORICAL = "historical",
}

export enum EpistemicRole {
  DIRECTIVE = "directive",
  OBSERVATION = "observation",
  CLAIM = "claim",
  PROCEDURE = "procedure",
  CONTROL_STATE = "control_state",
  LOCATOR = "locator",
}

export enum ResourceKind {
  WORKSPACE_FILE = "workspace_file",
  ARTIFACT = "artifact",
  HISTORY = "history",
  SUBAGENT = "subagent",
  ROSTER = "roster",
  SKILL = "skill",
  INTERNAL_CONTEXT = "internal_context",
}

const VIRTUAL_MOUNTS: ReadonlyMap<string, ResourceKind> = new Map([
  ["artifacts", ResourceKind.ARTIFACT],
  ["history", ResourceKind.HISTORY],
  ["subagents", ResourceKind.SUBAGENT],
  ["roster", ResourceKind.ROSTER],
  ["@sliceagent", ResourceKind.INTERNAL_CONTEXT],
]);

export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly handle: string;
}

export function resourceRefVirtual(ref: ResourceRef): boolean {
  return ref.kind !== ResourceKind.WORKSPACE_FILE;
}

export interface SourceRef {
  readonly kind: string;
  readonly handle: string;
  readonly revision: string;
}

export function makeSourceRef(kind: string, handle: string, revision = ""): SourceRef {
  if (!kind || !handle) {
    throw new ValueError("source reference kind and handle must be non-empty");
  }
  return { kind, handle, revision };
}

/** Classify a model-visible handle without touching the filesystem. */
export function reservedResourceRef(path: string): ResourceRef {
  let normalized = String(path ?? "").trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  const mount = normalized ? normalized.split("/", 2)[0] : "";
  return { kind: VIRTUAL_MOUNTS.get(mount) ?? ResourceKind.WORKSPACE_FILE, handle: normalized || "." };
}

export enum Fidelity {
  FULL = "full",
  EXCERPT = "excerpt",
  DIGEST = "digest",
  LOCATOR = "locator",
}

export enum RepresentationLoss {
  NONE = "none",
  SELECTION = "selection",
  SUMMARY = "summary",
  POINTER_ONLY = "pointer_only",
}

export enum PressureLevel {
  ROOMY = "roomy",
  ELEVATED = "elevated",
  TIGHT = "tight",
  CRITICAL = "critical",
  UNFIT = "unfit",
}

const FIDELITY_RANK: ReadonlyMap<Fidelity, number> = new Map([
  [Fidelity.FULL, 4],
  [Fidelity.EXCERPT, 3],
  [Fidelity.DIGEST, 2],
  [Fidelity.LOCATOR, 1],
]);

export interface ContextBlockInit {
  blockId: string;
  itemId: string;
  alternativeGroup: string;
  priority: number;
  instructionClass: InstructionClass;
  freshness: FreshnessClass;
  fidelity: Fidelity;
  representationLoss: RepresentationLoss;
  content: string;
  handles?: readonly string[];
  mandatory?: boolean;
  reobservable?: boolean;
  order?: number;
  /** TAIL by default (placement law); only context_block() may rely on the derived zone. */
  slot?: number;
  epistemicRole?: EpistemicRole;
  scope?: readonly string[];
  sourceRefs?: readonly SourceRef[];
  resourceRefs?: readonly ResourceRef[];
}

export class ContextBlock {
  readonly blockId: string;
  readonly itemId: string;
  readonly alternativeGroup: string;
  readonly priority: number;
  readonly instructionClass: InstructionClass;
  readonly freshness: FreshnessClass;
  readonly fidelity: Fidelity;
  readonly representationLoss: RepresentationLoss;
  readonly content: string;
  readonly handles: readonly string[];
  readonly mandatory: boolean;
  readonly reobservable: boolean;
  readonly order: number;
  readonly slot: number;
  readonly epistemicRole: EpistemicRole;
  readonly scope: readonly string[];
  readonly sourceRefs: readonly SourceRef[];
  readonly resourceRefs: readonly ResourceRef[];

  constructor(init: ContextBlockInit) {
    this.blockId = init.blockId;
    this.itemId = init.itemId;
    this.alternativeGroup = init.alternativeGroup;
    this.priority = init.priority;
    this.instructionClass = init.instructionClass;
    this.freshness = init.freshness;
    this.fidelity = init.fidelity;
    this.representationLoss = init.representationLoss;
    this.content = init.content;
    this.handles = init.handles ?? [];
    this.mandatory = init.mandatory ?? false;
    this.reobservable = init.reobservable ?? false;
    this.order = init.order ?? 0;
    this.slot = init.slot ?? 2;
    this.epistemicRole = init.epistemicRole ?? EpistemicRole.CLAIM;
    this.scope = init.scope ?? [];
    this.sourceRefs = init.sourceRefs ?? [];
    this.resourceRefs = init.resourceRefs ?? [];
    // __post_init__
    if (!this.blockId || !this.itemId || !this.alternativeGroup) {
      throw new ValueError("context block identity fields must be non-empty");
    }
    // FACTORY-BYPASS GUARD: placement is a law, not a field a caller may choose.
    const want = zoneOf(this.itemId);
    if (this.slot <= 1 && this.slot !== want) {
      throw new ValueError(
        `placement law: block ${pyRepr(this.blockId)} (item ${pyRepr(this.itemId)}) declares slot ` +
        `${this.slot} but its item belongs in zone ${want}`,
      );
    }
    if (this.representationLoss !== RepresentationLoss.NONE && !(this.handles.length > 0 || this.reobservable)) {
      throw new ValueError(
        `incomplete context block ${pyRepr(this.blockId)} has no recovery handle or re-observation path`,
      );
    }
    if (this.mandatory && this.representationLoss !== RepresentationLoss.NONE) {
      throw new ValueError("mandatory meaning cannot be represented by a lossy alternative");
    }
    if (this.scope.some((scope) => !String(scope).trim())) {
      throw new ValueError("context block scopes must be non-empty");
    }
  }
}

export class ContextSelection {
  readonly blocks: readonly ContextBlock[];
  readonly pressure: PressureLevel;
  readonly usedChars: number;
  readonly capacityChars: number | null;

  constructor(
    blocks: readonly ContextBlock[],
    pressure: PressureLevel,
    usedChars: number,
    capacityChars: number | null,
  ) {
    this.blocks = blocks;
    this.pressure = pressure;
    this.usedChars = usedChars;
    this.capacityChars = capacityChars;
  }

  bySlot(): Map<number, readonly ContextBlock[]> {
    const slots = new Map<number, ContextBlock[]>();
    for (const block of this.blocks) {
      const items = slots.get(block.slot);
      if (items) items.push(block);
      else slots.set(block.slot, [block]);
    }
    const out = new Map<number, readonly ContextBlock[]>();
    for (const [slot, items] of slots) {
      out.set(slot, sortBlocks(items));
    }
    return out;
  }
}

/** Python sorted(blocks, key=(order, block_id)) — stable, tuple compare. */
export function sortBlocks(blocks: readonly ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((a, b) => (a.order - b.order) || cmpStrings(a.blockId, b.blockId));
}

function pressure(used: number, capacity: number | null): PressureLevel {
  if (capacity === null || capacity <= 0) return PressureLevel.ROOMY;
  const ratio = used / capacity;
  if (ratio <= 0.55) return PressureLevel.ROOMY;
  if (ratio <= 0.75) return PressureLevel.ELEVATED;
  if (ratio <= 0.90) return PressureLevel.TIGHT;
  if (ratio <= 1.0) return PressureLevel.CRITICAL;
  return PressureLevel.UNFIT;
}

/**
 * Select one graded alternative per semantic item under a global capacity.
 * Mirrors ElasticityController.select exactly, including error precedence:
 * duplicate-id and group-shape checks run before the capacity check.
 */
export class ElasticityController {
  select(blocks: Iterable<ContextBlock>, opts: { capacityChars?: number | null } = {}): ContextSelection {
    const capacityChars = opts.capacityChars ?? null;
    const groups = new Map<string, ContextBlock[]>();
    const seenIds = new Set<string>();
    for (const block of blocks) {
      if (seenIds.has(block.blockId)) {
        throw new ValueError(`duplicate context block id ${pyRepr(block.blockId)}`);
      }
      seenIds.add(block.blockId);
      const alternatives = groups.get(block.alternativeGroup);
      if (alternatives) alternatives.push(block);
      else groups.set(block.alternativeGroup, [block]);
    }

    const ranked = new Map<string, ContextBlock[]>();
    const selectedIndex = new Map<string, number>();
    for (const [group, alternatives] of groups) {
      const itemIds = new Set(alternatives.map((b) => b.itemId));
      if (itemIds.size !== 1) {
        throw new ValueError(`alternative group ${pyRepr(group)} spans multiple semantic items`);
      }
      // Python: sorted(alts, key=(fidelity_rank, loss is NONE, len(content)), reverse=True).
      // reverse=True preserves original order among equal keys (stability), so compare
      // descending and leave ties to the stable sort.
      let ordered = [...alternatives].sort((a, b) => {
        const ra = FIDELITY_RANK.get(a.fidelity) ?? 0;
        const rb = FIDELITY_RANK.get(b.fidelity) ?? 0;
        if (ra !== rb) return rb - ra;
        const la = a.representationLoss === RepresentationLoss.NONE ? 1 : 0;
        const lb = b.representationLoss === RepresentationLoss.NONE ? 1 : 0;
        if (la !== lb) return lb - la;
        return pylen(b.content) - pylen(a.content);
      });
      if (ordered.some((b) => b.mandatory)) {
        ordered = ordered.filter((b) => b.representationLoss === RepresentationLoss.NONE);
        if (ordered.length === 0) {
          throw new ValueError(`mandatory group ${pyRepr(group)} has no lossless representation`);
        }
      }
      ranked.set(group, ordered);
      selectedIndex.set(group, 0);
    }

    const chosen = (): ContextBlock[] =>
      [...ranked.keys()].map((g) => (ranked.get(g) as ContextBlock[])[selectedIndex.get(g) as number]);
    const size = (): number => chosen().reduce((acc, b) => acc + pylen(b.content), 0);

    if (capacityChars !== null && capacityChars < 0) {
      throw new ValueError("capacity_chars must be non-negative or None");
    }

    while (capacityChars !== null && size() > capacityChars) {
      const candidates: Array<[number, number, number, string]> = [];
      for (const [group, alternatives] of ranked) {
        const i = selectedIndex.get(group) as number;
        if (i + 1 >= alternatives.length) continue;
        const cur = alternatives[i];
        const nxt = alternatives[i + 1];
        const savings = pylen(cur.content) - pylen(nxt.content);
        if (savings <= 0) continue;
        candidates.push([cur.priority, -savings, cur.order, group]);
      }
      if (candidates.length === 0) {
        const picked = chosen();
        const mandatory = pySortStrings(pyDedup(
          picked.filter((b) => b.mandatory).map((b) => b.itemId),
          (x) => x,
        ));
        throw new ContextUnfitError(size(), capacityChars, mandatory);
      }
      // min(candidates) — tuple compare (priority, -savings, order, group).
      let best = candidates[0];
      for (const cand of candidates) {
        if (cand[0] !== best[0]) { if (cand[0] < best[0]) best = cand; continue; }
        if (cand[1] !== best[1]) { if (cand[1] < best[1]) best = cand; continue; }
        if (cand[2] !== best[2]) { if (cand[2] < best[2]) best = cand; continue; }
        if (cmpStrings(cand[3], best[3]) < 0) best = cand;
      }
      selectedIndex.set(best[3], (selectedIndex.get(best[3]) as number) + 1);
    }

    const picked = sortBlocks(chosen());
    const used = picked.reduce((acc, b) => acc + pylen(b.content), 0);
    return new ContextSelection(picked, pressure(used, capacityChars), used, capacityChars);
  }
}

export { ContextUnfitError } from "./internal/errors.js";
