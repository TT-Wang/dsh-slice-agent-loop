/**
 * SeedPlan port (context.py) + the make_build_slice assembly essentials (seed.py):
 * the byte-stable system prefix passes through untouched; the user string is the
 * <context> envelope + the one exact CURRENT REQUEST + the NOW footer.
 */
import { ContextUnfitError, ValueError } from "./internal/errors.js";
import { pylen } from "./internal/pytext.js";
import type { ContextBlock, ContextSelection } from "./types.js";
import { ElasticityController } from "./types.js";
import { pyStrip } from "./internal/pytext.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * A list-compatible seed plus its graded, re-renderable context plan.
 * Mirrors context.SeedPlan: system + blocks + render_blocks + request_block +
 * now_block; project() emits [system, user] messages.
 */
export class SeedPlan {
  readonly system: string;
  readonly blocks: readonly ContextBlock[];
  readonly renderBlocks: (selection: ContextSelection) => string;
  readonly requestBlock: string;
  readonly nowBlock: string;
  readonly controller: ElasticityController;
  lastSelection: ContextSelection | null = null;
  lastRequestCopies = 1;

  constructor(init: {
    system: string;
    blocks: Iterable<ContextBlock>;
    renderBlocks: (selection: ContextSelection) => string;
    requestBlock: string;
    nowBlock: string;
    controller?: ElasticityController;
  }) {
    this.system = String(init.system);
    this.blocks = [...init.blocks];
    this.renderBlocks = init.renderBlocks;
    this.requestBlock = String(init.requestBlock);
    this.nowBlock = String(init.nowBlock);
    this.controller = init.controller ?? new ElasticityController();
  }

  /** Physical envelope cost for the one exact recency request presentation. */
  fixedUserChars(copies = 1): number {
    if (copies !== 1 && copies !== 2) {
      throw new ValueError("request copies must be one or two");
    }
    const primacy = copies === 2 ? this.requestBlock : "";
    return pylen(primacy + "<context>\n" + "\n</context>\n\n" + this.requestBlock + this.nowBlock);
  }

  project(capacityChars: number | null = null): [ChatMessage, ChatMessage] {
    if (capacityChars !== null && capacityChars < 0) {
      throw new ValueError("capacity_chars must be non-negative or None");
    }
    let bodyCapacity: number | null = null;
    const copies: number = 1;
    if (capacityChars !== null) {
      const fixed = this.fixedUserChars(copies);
      if (fixed > capacityChars) {
        throw new ContextUnfitError(
          fixed,
          capacityChars,
          pyStrip(this.requestBlock) ? ["current_request"] : ["request_envelope"],
        );
      }
      bodyCapacity = capacityChars - fixed;
    }
    const selection = this.controller.select(this.blocks, { capacityChars: bodyCapacity });
    this.lastSelection = selection;
    this.lastRequestCopies = copies;
    const body = this.renderBlocks(selection);
    const primacy = copies === 2 ? this.requestBlock : "";
    const userText = `${primacy}<context>\n${body}\n</context>\n\n${this.requestBlock}${this.nowBlock}`;
    return [
      { role: "system", content: this.system },
      { role: "user", content: userText },
    ];
  }

  /** Capacity that forces at least one fidelity step below the current selection. */
  nextTighterCapacity(): number | null {
    if (this.lastSelection === null) {
      this.project();
    }
    const used = this.lastSelection?.usedChars ?? 0;
    return used > 0 ? this.fixedUserChars(1) + used - 1 : null;
  }
}
