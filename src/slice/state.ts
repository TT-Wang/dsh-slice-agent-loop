/**
 * The renderer context (`ctx`) and Slice state model. Mirrors the attribute
 * surface the Python renderers read via getattr-with-defaults, and the
 * SimpleNamespace construction in tests/golden/gen_goldens.py — both sides
 * build from the same cases.json so the shapes are identical by contract.
 */
import type { TapeEntry } from "./tape.js";
import { entryFromOp, type TapeEntryOp } from "./tape.js";
import { findingHash, knowledgeHash } from "./tape.js";

// ── intent / contract ────────────────────────────────────────────────────────

export interface IntentEntry {
  verbatimClause: string;
  status: string;
  authority: string;
  kind: string;
  sourceArtifact: string;
  sourceRange: readonly [number, number] | null;
}

export interface NamedLabel {
  label: string;
  source?: string;
}

export interface EvidenceQuery {
  source: string;
  family: string;
  predicate: string;
  scope: string;
}

export interface QualityQuery {
  scope: string;
  purpose: string;
  prospectiveRequested: boolean;
}

export interface DelegationRequirement {
  agent: string;
  count: number | null;
  parallel: boolean;
  targets: readonly string[];
}

export interface EffectGrant {
  operation: string;
  tools: readonly string[];
  target: string;
}

export interface ReferentAnchor {
  artifactId: string;
  collection: string;
  ordinal: number;
  excerpt: string;
}

export type Referent = Record<string, unknown> & { kind: string };

export interface TurnContract {
  grounding: string;
  sourceNeeds: readonly string[];
  evidenceQuery: EvidenceQuery | null;
  qualityEvidenceQuery: QualityQuery | null;
  delegationRequirement: DelegationRequirement | null;
  requestedModes: readonly string[];
  actor: NamedLabel | null;
  target: NamedLabel | null;
  evidenceContinuation: boolean;
  focusRepairs: readonly { field?: string; replacement?: NamedLabel | null }[];
  effectGrants: readonly EffectGrant[];
  authoritySpans: readonly (readonly [number, number])[];
  attributedSpans: readonly (readonly [number, number])[];
  referents: readonly Referent[];
  effectAuthority: string;
}

export interface IntentState {
  entries: IntentEntry[];
  currentRequest: string;
  currentSource: string;
  turnContract: TurnContract | null;
}

// ── task / continuity / slice ────────────────────────────────────────────────

export interface ProgressSignal {
  kind: string;
  detail: string;
  count: number;
}

export interface TaskState {
  goal: string;
  goalSource: string;
  objectiveStatus: string;
  progressSignals: ProgressSignal[];
  deliverableRequirement: { kind?: string } | null;
}

export interface ContinuityState {
  tapeFindingHashes: Set<string>;
  tapeKnowledgeHashes: Set<string>;
  tapeTaskId: string;
  lastKnowledgeRender: string;
}

export interface ActiveWorkState {
  items: readonly unknown[];
}

export interface SliceState {
  intent: IntentState | null;
  task: TaskState;
  findings: string[];
  findingSource: Record<string, string>;
  sessionTape: TapeEntry[];
  activeFiles: string[];
  activeSkills: { name: string; body: string }[];
  world: Record<string, unknown>;
  openReport: string;
  lastError: string;
  reconciliationRequired: string;
  reconciliationTargets: readonly string[];
  continuity: ContinuityState;
  activeWork: ActiveWorkState | null;
  conversation: Record<string, unknown>[];
}

export interface SliceCtx {
  s: SliceState;
  artifacts: string;
  discovery: string;
  memory: string;
  threads: string;
  worktree: string;
  focus: string;
  repoMap: string;
  openFilePaths: readonly string[];
  maxFindings: number;
  /** memo slot for _graph_trim_selected (false = graph inactive / trim nothing) */
  _graphNeeds?: false | ReadonlySet<string>;
  graphSourceTexts?: Record<string, string>;
  graphLogicalId?: string;
  graphWorkspaceEpoch?: number | null;
}

// ── JSON normalization (mirrors gen_goldens.build_ctx) ───────────────────────

type Json = Record<string, unknown>;

/** Key for the (task_id, hash) tuple sets — one helper so writes and lookups can't drift. */
export const hashPairKey = (taskId: string, hash: string): string => `${taskId} ${hash}`;

const str = (v: unknown, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : [];

const span = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : null;

function normalizeContract(spec: unknown): TurnContract | null {
  if (spec === null || spec === undefined) return null;
  const c = spec as Json;
  const label = (v: unknown): NamedLabel | null =>
    v === null || v === undefined
      ? null
      : { label: str((v as Json).label), source: str((v as Json).source) };
  return {
    grounding: str(c.grounding, "none"),
    sourceNeeds: strList(c.source_needs),
    evidenceQuery: c.evidence_query
      ? {
          source: str((c.evidence_query as Json).source, "unknown"),
          family: str((c.evidence_query as Json).family, "all"),
          predicate: str((c.evidence_query as Json).predicate, "operations"),
          scope: str((c.evidence_query as Json).scope, "task"),
        }
      : null,
    qualityEvidenceQuery: c.quality_evidence_query
      ? {
          scope: str((c.quality_evidence_query as Json).scope, "task"),
          purpose: str((c.quality_evidence_query as Json).purpose, "assess"),
          prospectiveRequested: Boolean((c.quality_evidence_query as Json).prospective_requested ?? false),
        }
      : null,
    delegationRequirement: c.delegation_requirement
      ? {
          agent: str((c.delegation_requirement as Json).agent, "explorer"),
          count:
            (c.delegation_requirement as Json).count === null ||
            (c.delegation_requirement as Json).count === undefined
              ? null
              : Number((c.delegation_requirement as Json).count),
          parallel: Boolean((c.delegation_requirement as Json).parallel ?? false),
          targets: strList((c.delegation_requirement as Json).targets),
        }
      : null,
    requestedModes: strList(c.requested_modes),
    actor: label(c.actor),
    target: label(c.target),
    evidenceContinuation: Boolean(c.evidence_continuation ?? false),
    focusRepairs: Array.isArray(c.focus_repairs)
      ? c.focus_repairs.map((r) => {
          const j = r as Json;
          return { field: j.field === undefined ? undefined : str(j.field), replacement: label(j.replacement) };
        })
      : [],
    effectGrants: Array.isArray(c.effect_grants)
      ? c.effect_grants.map((g) => {
          const j = g as Json;
          return {
            operation: str(j.operation, "effect"),
            tools: strList(j.tools),
            target: str(j.target),
          };
        })
      : [],
    authoritySpans: Array.isArray(c.authority_spans)
      ? (c.authority_spans as unknown[]).map((x) => span(x) as readonly [number, number])
      : [],
    attributedSpans: Array.isArray(c.attributed_spans)
      ? (c.attributed_spans as unknown[]).map((x) => span(x) as readonly [number, number])
      : [],
    referents: Array.isArray(c.referents)
      ? c.referents.map((r) => {
          // Python referents arriving as dicts ONLY support .get("kind")/dict branches;
          // `getattr(ref, "anchor", None)` is None for a dict, so the anchor branch is
          // unreachable for dict referents (production uses typed objects, not dicts).
          const j = { ...(r as Json) };
          return { ...j, kind: str(j.kind) } as Referent;
        })
      : [],
    effectAuthority: str(c.effect_authority, "none"),
  };
}

export function normalizeSliceState(spec: Json, topSpec?: Json): SliceState {
  const intentSpec = (spec.intent ?? null) as Json | null;
  const intent: IntentState | null = intentSpec
    ? {
        entries: Array.isArray(intentSpec.entries)
          ? intentSpec.entries.map((e) => {
              const j = e as Json;
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
  const taskSpec = (spec.task ?? {}) as Json;
  const contSpec = (spec.continuity ?? {}) as Json;
  const continuity: ContinuityState = {
    tapeFindingHashes: new Set(
      Array.isArray(contSpec.tape_finding_hashes)
        ? contSpec.tape_finding_hashes.map((p) => hashPairKey(String((p as unknown[])[0]), String((p as unknown[])[1])))
        : [],
    ),
    tapeKnowledgeHashes: new Set(
      Array.isArray(contSpec.tape_knowledge_hashes)
        ? contSpec.tape_knowledge_hashes.map((p) => hashPairKey(String((p as unknown[])[0]), String((p as unknown[])[1])))
        : [],
    ),
    tapeTaskId: str(contSpec.tape_task_id),
    lastKnowledgeRender: str(contSpec.last_knowledge_render),
  };
  const aw = spec.active_work as Json | null | undefined;
  const state: SliceState = {
    intent,
    task: {
      goal: str(taskSpec.goal),
      goalSource: str(taskSpec.goal_source),
      objectiveStatus: str(taskSpec.objective_status, "active"),
      progressSignals: Array.isArray(taskSpec.progress_signals)
        ? taskSpec.progress_signals.map((p) => {
            const j = p as Json;
            return { kind: str(j.kind), detail: str(j.detail), count: Number(j.count ?? 1) };
          })
        : [],
      deliverableRequirement:
        taskSpec.deliverable_requirement === null || taskSpec.deliverable_requirement === undefined
          ? null
          : (taskSpec.deliverable_requirement as { kind?: string }),
    },
    findings: strList(spec.findings),
    findingSource: { ...((spec.finding_source ?? {}) as Record<string, string>) },
    sessionTape: Array.isArray(spec.session_tape)
      ? (spec.session_tape as TapeEntryOp[])
          .map((op) => entryFromOp(op))
          .filter((e): e is TapeEntry => e !== null)
      : [],
    activeFiles: strList(spec.active_files),
    activeSkills: Array.isArray(spec.active_skills)
      ? spec.active_skills.map((x) => {
          const j = x as Json;
          return { name: str(j.name), body: str(j.body) };
        })
      : [],
    world: { ...((spec.world ?? {}) as Record<string, unknown>) },
    openReport: str(spec.open_report),
    lastError: str(spec.last_error),
    reconciliationRequired: str(spec.reconciliation_required),
    reconciliationTargets: strList(spec.reconciliation_targets),
    continuity,
    activeWork: aw === null || aw === undefined ? null : { items: Array.isArray(aw.items) ? aw.items : [] },
    conversation: Array.isArray(spec.conversation)
      ? spec.conversation.map((r) => ({ ...(r as Record<string, unknown>) }))
      : [],
  };
  return state;
}

/**
 * Build the renderer ctx from a cases.json-shaped spec. `freeze_findings` /
 * `freeze_knowledge` mirror gen_goldens: the hash registries are computed with
 * the PORTED hash functions, so suppression parity exercises the same chain.
 */
export function normalizeCtx(spec: Json, renderFindingsLine: (text: string, sources: Record<string, string>) => string): SliceCtx {
  const s = normalizeSliceState((spec.s ?? {}) as Json);
  const taskId = s.continuity.tapeTaskId;
  for (const text of Array.isArray(spec.freeze_findings) ? (spec.freeze_findings as string[]) : []) {
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
    openFilePaths:
      spec.open_file_paths !== undefined ? strList(spec.open_file_paths) : [...s.activeFiles],
    maxFindings: Number(spec.max_findings ?? 8),
  };
}
