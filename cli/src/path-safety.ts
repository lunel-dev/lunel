import * as fssync from "fs";
import * as path from "path";

function normalizePathForComparison(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createPathSafetyResolver(rootDir: string): {
  rootDir: string;
  resolveSafePath: (requestedPath: string) => string | null;
  assertSafePath: (requestedPath: string) => string;
} {
  const canonicalRoot = (() => {
    try {
      return fssync.realpathSync(rootDir);
    } catch {
      return path.resolve(rootDir);
    }
  })();
  const rootComparison = normalizePathForComparison(canonicalRoot);
  const rootPrefixComparison = `${rootComparison}${path.sep}`;

  function isPathWithinRoot(targetPath: string): boolean {
    const comparisonPath = normalizePathForComparison(targetPath);
    return comparisonPath === rootComparison || comparisonPath.startsWith(rootPrefixComparison);
  }

  function resolveSafePath(requestedPath: string): string | null {
    const lexical = path.resolve(canonicalRoot, requestedPath);
    if (!isPathWithinRoot(lexical)) {
      return null;
    }

    // Walk upward until we find an existing ancestor, then rebuild the final
    // path from that canonical ancestor so symlinked parents cannot escape root.
    let current = lexical;
    const missingSegments: string[] = [];

    while (true) {
      try {
        const canonical = fssync.realpathSync(current);
        if (!isPathWithinRoot(canonical)) {
          return null;
        }

        return missingSegments.length === 0
          ? canonical
          : path.join(canonical, ...missingSegments.reverse());
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code && nodeError.code !== "ENOENT" && nodeError.code !== "ENOTDIR") {
          return null;
        }

        const parent = path.dirname(current);
        if (parent === current || !isPathWithinRoot(parent)) {
          return null;
        }

        missingSegments.push(path.basename(current));
        current = parent;
      }
    }
  }

  function assertSafePath(requestedPath: string): string {
    const safePath = resolveSafePath(requestedPath);
    if (!safePath) {
      const error = new Error("Access denied: path outside root directory");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    }

    return safePath;
  }

  return {
    rootDir: canonicalRoot,
    resolveSafePath,
    assertSafePath,
  };
}
