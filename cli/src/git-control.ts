export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (args: string[]) => Promise<GitCommandResult>;

export function normalizeGitPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0))];
}

export async function restoreGitWorktree(runGit: GitRunner, paths: string[]): Promise<void> {
  // Restore from the index so staged changes remain intact while only
  // discarding unstaged worktree edits.
  let result = await runGit(["restore", "--worktree", "--", ...paths]);
  if (result.code !== 0) {
    // Fallback for older Git versions without `git restore`.
    result = await runGit(["checkout", "--", ...paths]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git restore failed"), { code: "EGIT" });
    }
  }
}

export async function discardGitWorktreeChanges(
  runGit: GitRunner,
  payload: Record<string, unknown>,
): Promise<void> {
  const paths = normalizeGitPaths(payload.paths);
  const all = payload.all === true;

  if (!all && paths.length === 0) {
    throw Object.assign(new Error("paths or all is required"), { code: "EINVAL" });
  }

  await restoreGitWorktree(runGit, all ? ["."] : paths);
}
