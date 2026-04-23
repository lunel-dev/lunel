import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createPathSafetyResolver } from "./path-safety.js";
import { discardGitWorktreeChanges, type GitCommandResult, type GitRunner } from "./git-control.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function runGitInRepo(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

test("path safety rejects writes through symlinked parents outside root", () => {
  const rootDir = makeTempDir("lunel-safe-root-");
  const outsideDir = makeTempDir("lunel-safe-outside-");

  try {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outsideDir, path.join(rootDir, "link-out"), symlinkType);

    const safety = createPathSafetyResolver(rootDir);
    assert.equal(safety.resolveSafePath("link-out/escape.txt"), null);

    const safeTarget = safety.assertSafePath("nested/file.txt");
    assert.equal(safeTarget, path.join(rootDir, "nested", "file.txt"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("git discard preserves staged changes and untracked files", async () => {
  const repoDir = makeTempDir("lunel-git-discard-");

  try {
    mkdirSync(repoDir, { recursive: true });
    assert.equal(runGitInRepo(repoDir, ["init"]).code, 0);
    assert.equal(runGitInRepo(repoDir, ["config", "user.name", "codex"]).code, 0);
    assert.equal(runGitInRepo(repoDir, ["config", "user.email", "codex@example.com"]).code, 0);

    writeFileSync(path.join(repoDir, "tracked.txt"), "base\n");
    assert.equal(runGitInRepo(repoDir, ["add", "tracked.txt"]).code, 0);
    assert.equal(runGitInRepo(repoDir, ["commit", "-m", "init"]).code, 0);

    writeFileSync(path.join(repoDir, "tracked.txt"), "staged\n");
    assert.equal(runGitInRepo(repoDir, ["add", "tracked.txt"]).code, 0);
    writeFileSync(path.join(repoDir, "tracked.txt"), "staged-plus-unstaged\n");
    writeFileSync(path.join(repoDir, "untracked.txt"), "scratch\n");

    const gitRunner: GitRunner = async (args) => runGitInRepo(repoDir, args);
    await discardGitWorktreeChanges(gitRunner, { all: true });

    const status = runGitInRepo(repoDir, ["status", "--short"]);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /^M  tracked\.txt$/m);
    assert.match(status.stdout, /^\?\? untracked\.txt$/m);

    const trackedContent = readFileSync(path.join(repoDir, "tracked.txt"), "utf8");
    assert.equal(trackedContent.replace(/\r\n/g, "\n"), "staged\n");

    const cachedDiff = runGitInRepo(repoDir, ["diff", "--cached", "--", "tracked.txt"]);
    assert.equal(cachedDiff.code, 0);
    assert.match(cachedDiff.stdout, /\+staged/);
    assert.doesNotMatch(cachedDiff.stdout, /staged-plus-unstaged/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
