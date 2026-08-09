/**
 * Package entry — the slice engine public API lives in ./slice.
 */
export * from "./slice/index.js";
export * from "./lifecycle.js";
export { InboxLedger } from "./inbox-ledger.js";
export type { InboxLedgerActivity } from "./inbox-ledger.js";
