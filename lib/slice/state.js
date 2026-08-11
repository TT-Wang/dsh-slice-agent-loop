import { entryFromOp } from "./tape.js";
import { findingHash, knowledgeHash } from "./tape.js";
/** Key for the (task_id, hash) tuple sets — one helper so writes and lookups can't drift. */
export const hashPairKey = (taskId, hash) => `${taskId} ${hash}`;
const str = (v, fallback = "") => v === null || v === undefined ? fallback : String(v);
const strList = (v) => Array.isArray(v) ? v.map((x) => String(x)) : [];
const span = (v) => Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : null;
function normalizeContract(spec) {
    if (spec === null || spec === undefined)
        return null;
    const c = spec;
    const label = (v) => v === null || v === undefined
        ? null
        : { label: str(v.label), source: str(v.source) };
    return {
        grounding: str(c.grounding, "none"),
        sourceNeeds: strList(c.source_needs),
        evidenceQuery: c.evidence_query
            ? {
                source: str(c.evidence_query.source, "unknown"),
                family: str(c.evidence_query.family, "all"),
                predicate: str(c.evidence_query.predicate, "operations"),
                scope: str(c.evidence_query.scope, "task"),
            }
            : null,
        qualityEvidenceQuery: c.quality_evidence_query
            ? {
                scope: str(c.quality_evidence_query.scope, "task"),
                purpose: str(c.quality_evidence_query.purpose, "assess"),
                prospectiveRequested: Boolean(c.quality_evidence_query.prospective_requested ?? false),
            }
            : null,
        delegationRequirement: c.delegation_requirement
            ? {
                agent: str(c.delegation_requirement.agent, "explorer"),
                count: c.delegation_requirement.count === null ||
                    c.delegation_requirement.count === undefined
                    ? null
                    : Number(c.delegation_requirement.count),
                parallel: Boolean(c.delegation_requirement.parallel ?? false),
                targets: strList(c.delegation_requirement.targets),
            }
            : null,
        requestedModes: strList(c.requested_modes),
        actor: label(c.actor),
        target: label(c.target),
        evidenceContinuation: Boolean(c.evidence_continuation ?? false),
        focusRepairs: Array.isArray(c.focus_repairs)
            ? c.focus_repairs.map((r) => {
                const j = r;
                return { field: j.field === undefined ? undefined : str(j.field), replacement: label(j.replacement) };
            })
            : [],
        effectGrants: Array.isArray(c.effect_grants)
            ? c.effect_grants.map((g) => {
                const j = g;
                return {
                    operation: str(j.operation, "effect"),
                    tools: strList(j.tools),
                    target: str(j.target),
                };
            })
            : [],
        authoritySpans: Array.isArray(c.authority_spans)
            ? c.authority_spans.map((x) => span(x))
            : [],
        attributedSpans: Array.isArray(c.attributed_spans)
            ? c.attributed_spans.map((x) => span(x))
            : [],
        referents: Array.isArray(c.referents)
            ? c.referents.map((r) => {
                // Python referents arriving as dicts ONLY support .get("kind")/dict branches;
                // `getattr(ref, "anchor", None)` is None for a dict, so the anchor branch is
                // unreachable for dict referents (production uses typed objects, not dicts).
                const j = { ...r };
                return { ...j, kind: str(j.kind) };
            })
            : [],
        effectAuthority: str(c.effect_authority, "none"),
    };
}
export function normalizeSliceState(spec, topSpec) {
    const intentSpec = (spec.intent ?? null);
    const intent = intentSpec
        ? {
            entries: Array.isArray(intentSpec.entries)
                ? intentSpec.entries.map((e) => {
                    const j = e;
                    return {
                        verbatimClause: str(j.verbatim_clause),
                        status: str(j.status, "active"),
                        authority: str(j.authority, "legacy"),
                        kind: str(j.kind, "constraint"),
                        sourceArtifact: str(j.source_artifact),
                        sourceRange: span(j.source_range),
                    };
                })
                : [],
            currentRequest: str(intentSpec.current_request),
            currentSource: str(intentSpec.current_source),
            turnContract: normalizeContract(intentSpec.turn_contract),
        }
        : null;
    const taskSpec = (spec.task ?? {});
    const contSpec = (spec.continuity ?? {});
    const continuity = {
        tapeFindingHashes: new Set(Array.isArray(contSpec.tape_finding_hashes)
            ? contSpec.tape_finding_hashes.map((p) => hashPairKey(String(p[0]), String(p[1])))
            : []),
        tapeKnowledgeHashes: new Set(Array.isArray(contSpec.tape_knowledge_hashes)
            ? contSpec.tape_knowledge_hashes.map((p) => hashPairKey(String(p[0]), String(p[1])))
            : []),
        tapeTaskId: str(contSpec.tape_task_id),
        lastKnowledgeRender: str(contSpec.last_knowledge_render),
    };
    const aw = spec.active_work;
    const state = {
        intent,
        task: {
            goal: str(taskSpec.goal),
            goalSource: str(taskSpec.goal_source),
            objectiveStatus: str(taskSpec.objective_status, "active"),
            progressSignals: Array.isArray(taskSpec.progress_signals)
                ? taskSpec.progress_signals.map((p) => {
                    const j = p;
                    return { kind: str(j.kind), detail: str(j.detail), count: Number(j.count ?? 1) };
                })
                : [],
            deliverableRequirement: taskSpec.deliverable_requirement === null || taskSpec.deliverable_requirement === undefined
                ? null
                : taskSpec.deliverable_requirement,
        },
        findings: strList(spec.findings),
        findingSource: { ...(spec.finding_source ?? {}) },
        sessionTape: Array.isArray(spec.session_tape)
            ? spec.session_tape
                .map((op) => entryFromOp(op))
                .filter((e) => e !== null)
            : [],
        activeFiles: strList(spec.active_files),
        activeSkills: Array.isArray(spec.active_skills)
            ? spec.active_skills.map((x) => {
                const j = x;
                return { name: str(j.name), body: str(j.body) };
            })
            : [],
        world: { ...(spec.world ?? {}) },
        openReport: str(spec.open_report),
        lastError: str(spec.last_error),
        reconciliationRequired: str(spec.reconciliation_required),
        reconciliationTargets: strList(spec.reconciliation_targets),
        continuity,
        activeWork: aw === null || aw === undefined ? null : { items: Array.isArray(aw.items) ? aw.items : [] },
        conversation: Array.isArray(spec.conversation)
            ? spec.conversation.map((r) => ({ ...r }))
            : [],
    };
    return state;
}
/**
 * Build the renderer ctx from a cases.json-shaped spec. `freeze_findings` /
 * `freeze_knowledge` mirror gen_goldens: the hash registries are computed with
 * the PORTED hash functions, so suppression parity exercises the same chain.
 */
export function normalizeCtx(spec, renderFindingsLine) {
    const s = normalizeSliceState((spec.s ?? {}));
    const taskId = s.continuity.tapeTaskId;
    for (const text of Array.isArray(spec.freeze_findings) ? spec.freeze_findings : []) {
        s.continuity.tapeFindingHashes.add(hashPairKey(taskId, findingHash(renderFindingsLine(String(text), s.findingSource))));
    }
    if (spec.freeze_knowledge) {
        s.continuity.tapeKnowledgeHashes.add(hashPairKey(taskId, knowledgeHash(str(spec.memory))));
    }
    return {
        s,
        artifacts: str(spec.artifacts),
        discovery: str(spec.discovery),
        memory: str(spec.memory),
        threads: str(spec.threads),
        worktree: str(spec.worktree),
        focus: str(spec.focus),
        repoMap: str(spec.repo_map),
        openFilePaths: spec.open_file_paths !== undefined ? strList(spec.open_file_paths) : [...s.activeFiles],
        maxFindings: Number(spec.max_findings ?? 8),
    };
}
