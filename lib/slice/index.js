/**
 * Public API for the ported SliceAgent bounded-context engine.
 */
export { InstructionClass, FreshnessClass, EpistemicRole, ResourceKind, Fidelity, RepresentationLoss, PressureLevel, ContextBlock, ContextSelection, ElasticityController, ContextUnfitError, reservedResourceRef, resourceRefVirtual, makeSourceRef, } from "./types.js";
export { REGIONS, REGION_ORDER, REGION_META, REGION_ROLES, HEAD_ZONE, TAPE_ZONE, TAIL_ZONE, regionZone, contextBlock, assertPlacementLaw, buildContextBlocks, renderContextSelection, renderRegions, renderCurrentRequest, renderNow, renderFindings, renderSkills, renderWorld, renderIntent, renderCorrections, renderTaskObjective, renderReconciliation, renderProgressSignals, renderTurnContract, unfrozenFindings, knowledgeFrozen, CURRENT_REQUEST_HDR, NOW_FOOTER, } from "./regions.js";
export { TapeEntry, baseEntry, patchEntry, externalEntry, replyEntry, reasoningEntry, findingEntry, knowledgeEntry, digestEntry, renderTapeBase, renderTapePatch, renderTapeExternal, renderTapeReply, unifiedPatch, applyUnified, composeAfter, tapeRender, tapeChars, compactTape, reconcileTapeWithDigests, canonicalText, findingHash, knowledgeHash, TAPE_BUDGET_CHARS, REPLY_CAP_CHARS, REASONING_CAP_CHARS, _h, } from "./tape.js";
export { SeedPlan } from "./buildSlice.js";
export { assembleSlice, renderRegions as compileSlice } from "./compiler.js";
export { normalizeCtx, normalizeSliceState } from "./state.js";
export { entryFromOp } from "./tape.js";
export { wrapUntrusted, redactText } from "./internal/safety.js";
export { normalizeWs, oneLine } from "./internal/textUtils.js";
export { ValueError, PyTypeError } from "./internal/errors.js";
