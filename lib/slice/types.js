/**
 * context.py port — canonical context planning and elasticity primitives.
 * Selection works in characters (Python len == code points) exactly like the
 * source; token estimation belongs to the model runner.
 */
import { ContextUnfitError, ValueError } from "./internal/errors.js";
import { zoneOf } from "./internal/placement.js";
import { cmpStrings, pylen, pyDedup, pyRepr, pySortStrings } from "./internal/pytext.js";
export var InstructionClass;
(function (InstructionClass) {
    InstructionClass["SYSTEM"] = "system";
    InstructionClass["USER"] = "user";
    InstructionClass["TASK_STATE"] = "task_state";
    InstructionClass["DATA"] = "data";
})(InstructionClass || (InstructionClass = {}));
export var FreshnessClass;
(function (FreshnessClass) {
    FreshnessClass["LIVE"] = "live";
    FreshnessClass["REVISION_BOUND"] = "revision_bound";
    FreshnessClass["DERIVED"] = "derived";
    FreshnessClass["HISTORICAL"] = "historical";
})(FreshnessClass || (FreshnessClass = {}));
export var EpistemicRole;
(function (EpistemicRole) {
    EpistemicRole["DIRECTIVE"] = "directive";
    EpistemicRole["OBSERVATION"] = "observation";
    EpistemicRole["CLAIM"] = "claim";
    EpistemicRole["PROCEDURE"] = "procedure";
    EpistemicRole["CONTROL_STATE"] = "control_state";
    EpistemicRole["LOCATOR"] = "locator";
})(EpistemicRole || (EpistemicRole = {}));
export var ResourceKind;
(function (ResourceKind) {
    ResourceKind["WORKSPACE_FILE"] = "workspace_file";
    ResourceKind["ARTIFACT"] = "artifact";
    ResourceKind["HISTORY"] = "history";
    ResourceKind["SUBAGENT"] = "subagent";
    ResourceKind["ROSTER"] = "roster";
    ResourceKind["SKILL"] = "skill";
    ResourceKind["INTERNAL_CONTEXT"] = "internal_context";
})(ResourceKind || (ResourceKind = {}));
const VIRTUAL_MOUNTS = new Map([
    ["artifacts", ResourceKind.ARTIFACT],
    ["history", ResourceKind.HISTORY],
    ["subagents", ResourceKind.SUBAGENT],
    ["roster", ResourceKind.ROSTER],
    ["@sliceagent", ResourceKind.INTERNAL_CONTEXT],
]);
export function resourceRefVirtual(ref) {
    return ref.kind !== ResourceKind.WORKSPACE_FILE;
}
export function makeSourceRef(kind, handle, revision = "") {
    if (!kind || !handle) {
        throw new ValueError("source reference kind and handle must be non-empty");
    }
    return { kind, handle, revision };
}
/** Classify a model-visible handle without touching the filesystem. */
export function reservedResourceRef(path) {
    let normalized = String(path ?? "").trim().replace(/\\/g, "/");
    while (normalized.startsWith("./"))
        normalized = normalized.slice(2);
    normalized = normalized.replace(/\/+$/, "");
    const mount = normalized ? normalized.split("/", 2)[0] : "";
    return { kind: VIRTUAL_MOUNTS.get(mount) ?? ResourceKind.WORKSPACE_FILE, handle: normalized || "." };
}
export var Fidelity;
(function (Fidelity) {
    Fidelity["FULL"] = "full";
    Fidelity["EXCERPT"] = "excerpt";
    Fidelity["DIGEST"] = "digest";
    Fidelity["LOCATOR"] = "locator";
})(Fidelity || (Fidelity = {}));
export var RepresentationLoss;
(function (RepresentationLoss) {
    RepresentationLoss["NONE"] = "none";
    RepresentationLoss["SELECTION"] = "selection";
    RepresentationLoss["SUMMARY"] = "summary";
    RepresentationLoss["POINTER_ONLY"] = "pointer_only";
})(RepresentationLoss || (RepresentationLoss = {}));
export var PressureLevel;
(function (PressureLevel) {
    PressureLevel["ROOMY"] = "roomy";
    PressureLevel["ELEVATED"] = "elevated";
    PressureLevel["TIGHT"] = "tight";
    PressureLevel["CRITICAL"] = "critical";
    PressureLevel["UNFIT"] = "unfit";
})(PressureLevel || (PressureLevel = {}));
const FIDELITY_RANK = new Map([
    [Fidelity.FULL, 4],
    [Fidelity.EXCERPT, 3],
    [Fidelity.DIGEST, 2],
    [Fidelity.LOCATOR, 1],
]);
export class ContextBlock {
    blockId;
    itemId;
    alternativeGroup;
    priority;
    instructionClass;
    freshness;
    fidelity;
    representationLoss;
    content;
    handles;
    mandatory;
    reobservable;
    order;
    slot;
    epistemicRole;
    scope;
    sourceRefs;
    resourceRefs;
    constructor(init) {
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
            throw new ValueError(`placement law: block ${pyRepr(this.blockId)} (item ${pyRepr(this.itemId)}) declares slot ` +
                `${this.slot} but its item belongs in zone ${want}`);
        }
        if (this.representationLoss !== RepresentationLoss.NONE && !(this.handles.length > 0 || this.reobservable)) {
            throw new ValueError(`incomplete context block ${pyRepr(this.blockId)} has no recovery handle or re-observation path`);
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
    blocks;
    pressure;
    usedChars;
    capacityChars;
    constructor(blocks, pressure, usedChars, capacityChars) {
        this.blocks = blocks;
        this.pressure = pressure;
        this.usedChars = usedChars;
        this.capacityChars = capacityChars;
    }
    bySlot() {
        const slots = new Map();
        for (const block of this.blocks) {
            const items = slots.get(block.slot);
            if (items)
                items.push(block);
            else
                slots.set(block.slot, [block]);
        }
        const out = new Map();
        for (const [slot, items] of slots) {
            out.set(slot, sortBlocks(items));
        }
        return out;
    }
}
/** Python sorted(blocks, key=(order, block_id)) — stable, tuple compare. */
export function sortBlocks(blocks) {
    return [...blocks].sort((a, b) => (a.order - b.order) || cmpStrings(a.blockId, b.blockId));
}
function pressure(used, capacity) {
    if (capacity === null || capacity <= 0)
        return PressureLevel.ROOMY;
    const ratio = used / capacity;
    if (ratio <= 0.55)
        return PressureLevel.ROOMY;
    if (ratio <= 0.75)
        return PressureLevel.ELEVATED;
    if (ratio <= 0.90)
        return PressureLevel.TIGHT;
    if (ratio <= 1.0)
        return PressureLevel.CRITICAL;
    return PressureLevel.UNFIT;
}
/**
 * Select one graded alternative per semantic item under a global capacity.
 * Mirrors ElasticityController.select exactly, including error precedence:
 * duplicate-id and group-shape checks run before the capacity check.
 */
export class ElasticityController {
    select(blocks, opts = {}) {
        const capacityChars = opts.capacityChars ?? null;
        const groups = new Map();
        const seenIds = new Set();
        for (const block of blocks) {
            if (seenIds.has(block.blockId)) {
                throw new ValueError(`duplicate context block id ${pyRepr(block.blockId)}`);
            }
            seenIds.add(block.blockId);
            const alternatives = groups.get(block.alternativeGroup);
            if (alternatives)
                alternatives.push(block);
            else
                groups.set(block.alternativeGroup, [block]);
        }
        const ranked = new Map();
        const selectedIndex = new Map();
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
                if (ra !== rb)
                    return rb - ra;
                const la = a.representationLoss === RepresentationLoss.NONE ? 1 : 0;
                const lb = b.representationLoss === RepresentationLoss.NONE ? 1 : 0;
                if (la !== lb)
                    return lb - la;
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
        const chosen = () => [...ranked.keys()].map((g) => ranked.get(g)[selectedIndex.get(g)]);
        const size = () => chosen().reduce((acc, b) => acc + pylen(b.content), 0);
        if (capacityChars !== null && capacityChars < 0) {
            throw new ValueError("capacity_chars must be non-negative or None");
        }
        while (capacityChars !== null && size() > capacityChars) {
            const candidates = [];
            for (const [group, alternatives] of ranked) {
                const i = selectedIndex.get(group);
                if (i + 1 >= alternatives.length)
                    continue;
                const cur = alternatives[i];
                const nxt = alternatives[i + 1];
                const savings = pylen(cur.content) - pylen(nxt.content);
                if (savings <= 0)
                    continue;
                candidates.push([cur.priority, -savings, cur.order, group]);
            }
            if (candidates.length === 0) {
                const picked = chosen();
                const mandatory = pySortStrings(pyDedup(picked.filter((b) => b.mandatory).map((b) => b.itemId), (x) => x));
                throw new ContextUnfitError(size(), capacityChars, mandatory);
            }
            // min(candidates) — tuple compare (priority, -savings, order, group).
            let best = candidates[0];
            for (const cand of candidates) {
                if (cand[0] !== best[0]) {
                    if (cand[0] < best[0])
                        best = cand;
                    continue;
                }
                if (cand[1] !== best[1]) {
                    if (cand[1] < best[1])
                        best = cand;
                    continue;
                }
                if (cand[2] !== best[2]) {
                    if (cand[2] < best[2])
                        best = cand;
                    continue;
                }
                if (cmpStrings(cand[3], best[3]) < 0)
                    best = cand;
            }
            selectedIndex.set(best[3], selectedIndex.get(best[3]) + 1);
        }
        const picked = sortBlocks(chosen());
        const used = picked.reduce((acc, b) => acc + pylen(b.content), 0);
        return new ContextSelection(picked, pressure(used, capacityChars), used, capacityChars);
    }
}
export { ContextUnfitError } from "./internal/errors.js";
