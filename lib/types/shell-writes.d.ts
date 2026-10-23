/**
 * Files a shell command may write, spelled as the command spells them.
 *
 * Best effort for the working-set policy (src/working-set.ts), never a
 * sandbox or an execution model: nothing is expanded or run. A recognised write
 * marks the file as being worked on and keeps that step raw beside the file's
 * kept view, so the raw view never silently predates a change the model made.
 * A write this does not recognise (a program that opens files by itself, a
 * glob, a variable) carries the same risk as any recorded read; the host's
 * edit guard and the KERNEL rule cover it.
 *
 * Recognised: output redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, `>& file`),
 * `tee`, in-place `sed -i` / `perl -i`, `cp` / `install` / `ln` destinations,
 * `mv`, `rm`, `unlink`, `touch`, `truncate`, `shred` operands, `git checkout` /
 * `git restore` paths, `sh|bash|zsh -c` and here-document shell bodies
 * (recursively), and interpreter scripts (`python -c`, `node -e`, a here-document
 * body, a here-string) that call a write API: every path-like string literal of
 * such a script counts. Here-document bodies are never read as shell words.
 */
/**
 * Paths `command` may write, in first-mention order without duplicates, as
 * written (relative, `$PWD/…` or absolute); `/dev/*` targets are dropped. The
 * caller resolves them against paths the session already knows.
 */
export declare function shellWriteTargets(command: string, depth?: number): string[];
