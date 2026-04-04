import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";

function readWindowsEnv(name: string): string | undefined {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

function resolveWindowsCommand(command: string): string | null {
  const pathEntries = /[\\/]/.test(command)
    ? [""]
    : (readWindowsEnv("PATH") || "").split(path.delimiter).filter(Boolean);
  const extensions = path.extname(command)
    ? [""]
    : (readWindowsEnv("PATHEXT") || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean);

  for (const baseDir of pathEntries) {
    const basePath = baseDir ? path.join(baseDir, command) : command;
    const candidates = path.extname(basePath)
      ? [basePath]
      : extensions.map((extension) => `${basePath}${extension}`);

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Keep searching PATH entries until we find a real file.
      }
    }
  }

  return null;
}

function quoteForCmd(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"&()<>^|]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

export function spawnPlatformCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform !== "win32") {
    return spawn(command, args, options);
  }

  const resolvedCommand = resolveWindowsCommand(command);
  if (!resolvedCommand) {
    return spawn(command, args, options);
  }

  const extension = path.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return spawn(resolvedCommand, args, options);
  }

  const comspec = readWindowsEnv("ComSpec") || "C:\\Windows\\System32\\cmd.exe";
  const commandLine = [quoteForCmd(resolvedCommand), ...args.map(quoteForCmd)].join(" ");

  // Windows command shims such as codex.cmd and opencode.cmd still need cmd.exe,
  // but spawning it explicitly avoids Node's DEP0190 shell:true deprecation path.
  return spawn(comspec, ["/d", "/s", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
