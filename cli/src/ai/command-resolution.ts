import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

export type CliCommandName = "claude" | "codex";
export type CliCommandSource = "env" | "config" | "windows-global-npm" | "path";
export type CliCommandStatus = "ready" | "missing_binary" | "configured_path_missing" | "not_executable";

export interface CliCommandInspection {
  command: CliCommandName;
  executable: string;
  source: CliCommandSource;
  status: CliCommandStatus;
  available: boolean;
  code: string;
  message: string;
  displayName: string;
  configuredPath?: string;
  configPath?: string;
  envVarName?: string;
  version?: string;
}

type RuntimeConfigRecord = Partial<Record<CliCommandName, { command: string }>>;

function hasPath(targetPath: string | undefined | null): targetPath is string {
  return typeof targetPath === "string" && targetPath.trim().length > 0;
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

function getDisplayName(command: CliCommandName): string {
  return command === "claude" ? "Claude Code" : "Codex";
}

function getEnvVarName(command: CliCommandName): string {
  return command === "claude" ? "LUNEL_CLAUDE_BIN" : "LUNEL_CODEX_BIN";
}

function getCliConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "lunel", "config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "lunel", "config.json");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "lunel", "config.json");
}

function readRuntimeConfigMap(): { configPath: string; runtimes: RuntimeConfigRecord } {
  const configPath = getCliConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      aiRuntimes?: Record<string, unknown>;
      ai?: { runtimes?: Record<string, unknown> };
    };
    const runtimeRoot = (parsed.aiRuntimes ?? parsed.ai?.runtimes ?? {}) as Record<string, unknown>;
    const runtimes: RuntimeConfigRecord = {};
    for (const command of ["claude", "codex"] as const) {
      const entry = runtimeRoot[command];
      if (typeof entry === "string" && entry.trim()) {
        runtimes[command] = { command: entry.trim() };
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { command?: unknown }).command === "string" &&
        (entry as { command: string }).command.trim()
      ) {
        runtimes[command] = { command: (entry as { command: string }).command.trim() };
      }
    }
    return { configPath, runtimes };
  } catch {
    return { configPath, runtimes: {} };
  }
}

function getWindowsGlobalBinDirs(): string[] {
  const appDataCandidates = dedupe([
    process.env.LUNEL_USER_APPDATA,
    process.env.APPDATA,
  ].filter(hasPath));

  const userProfileCandidates = dedupe([
    process.env.LUNEL_USER_PROFILE,
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : undefined,
  ].filter(hasPath));

  const binDirs = dedupe([
    process.env.LUNEL_GLOBAL_NPM_BIN,
    ...appDataCandidates.map((appDataPath) => path.join(appDataPath, "npm")),
    ...userProfileCandidates.map((userProfilePath) => path.join(userProfilePath, "AppData", "Roaming", "npm")),
  ].filter(hasPath));

  return binDirs.filter(pathExists);
}

function probeCommandAvailability(command: CliCommandName, executable: string): { available: boolean; version?: string } {
  const probe = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const error = probe.error as NodeJS.ErrnoException | undefined;
  if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
    return { available: false };
  }

  const text = `${probe.stdout || ""}\n${probe.stderr || ""}`.trim();
  if (probe.status === 0) {
    const version = (probe.stdout || probe.stderr || "").trim();
    return { available: true, version: version || undefined };
  }

  if (
    /not recognized as an internal or external command/i.test(text)
    || /No such file or directory/i.test(text)
    || /command not found/i.test(text)
  ) {
    return { available: false };
  }

  // A runtime that exists but cannot answer --version is still not safe to use.
  return { available: false };
}

export function inspectCliCommand(command: CliCommandName): CliCommandInspection {
  const displayName = getDisplayName(command);
  const envVarName = getEnvVarName(command);
  const envOverride = process.env[envVarName];
  if (hasPath(envOverride)) {
    const configuredPath = envOverride.trim();
    if (!pathExists(configuredPath)) {
      return {
        command,
        executable: configuredPath,
        source: "env",
        status: "configured_path_missing",
        available: false,
        code: "EAI_CONFIGURED_PATH_MISSING",
        message: `${displayName} runtime path from ${envVarName} does not exist: ${configuredPath}`,
        displayName,
        configuredPath,
        envVarName,
      };
    }

    const probe = probeCommandAvailability(command, configuredPath);
    if (!probe.available) {
      return {
        command,
        executable: configuredPath,
        source: "env",
        status: "not_executable",
        available: false,
        code: "EAI_BINARY_NOT_EXECUTABLE",
        message: `${displayName} runtime at ${configuredPath} could not be executed.`,
        displayName,
        configuredPath,
        envVarName,
      };
    }

    return {
      command,
      executable: configuredPath,
      source: "env",
      status: "ready",
      available: true,
      code: "OK",
      message: `${displayName} runtime ready via ${envVarName}.`,
      displayName,
      configuredPath,
      envVarName,
      version: probe.version,
    };
  }

  const { configPath, runtimes } = readRuntimeConfigMap();
  const configuredCommand = runtimes[command]?.command;
  if (hasPath(configuredCommand)) {
    const configuredPath = configuredCommand.trim();
    if (!pathExists(configuredPath)) {
      return {
        command,
        executable: configuredPath,
        source: "config",
        status: "configured_path_missing",
        available: false,
        code: "EAI_CONFIGURED_PATH_MISSING",
        message: `${displayName} runtime path configured in ${configPath} does not exist: ${configuredPath}`,
        displayName,
        configuredPath,
        configPath,
      };
    }

    const probe = probeCommandAvailability(command, configuredPath);
    if (!probe.available) {
      return {
        command,
        executable: configuredPath,
        source: "config",
        status: "not_executable",
        available: false,
        code: "EAI_BINARY_NOT_EXECUTABLE",
        message: `${displayName} runtime configured in ${configPath} could not be executed: ${configuredPath}`,
        displayName,
        configuredPath,
        configPath,
      };
    }

    return {
      command,
      executable: configuredPath,
      source: "config",
      status: "ready",
      available: true,
      code: "OK",
      message: `${displayName} runtime ready via ${configPath}.`,
      displayName,
      configuredPath,
      configPath,
      version: probe.version,
    };
  }

  for (const binDir of getWindowsGlobalBinDirs()) {
    for (const suffix of [".cmd", ".exe", ".bat", ".ps1", ""]) {
      const candidate = path.join(binDir, `${command}${suffix}`);
      if (!pathExists(candidate)) continue;
      const probe = probeCommandAvailability(command, candidate);
      if (!probe.available) continue;
      return {
        command,
        executable: candidate,
        source: "windows-global-npm",
        status: "ready",
        available: true,
        code: "OK",
        message: `${displayName} runtime ready via global npm bin.`,
        displayName,
        version: probe.version,
      };
    }
  }

  const probe = probeCommandAvailability(command, command);
  if (probe.available) {
    return {
      command,
      executable: command,
      source: "path",
      status: "ready",
      available: true,
      code: "OK",
      message: `${displayName} runtime ready via PATH.`,
      displayName,
      version: probe.version,
    };
  }

  return {
    command,
    executable: command,
    source: "path",
    status: "missing_binary",
    available: false,
    code: "EAI_MISSING_BINARY",
    message: `${displayName} runtime was not found. Configure ${envVarName} or aiRuntimes.${command}.command in ${configPath}.`,
    displayName,
    configPath,
    envVarName,
  };
}

export function assertCliCommandReady(command: CliCommandName): CliCommandInspection {
  const inspection = inspectCliCommand(command);
  if (inspection.available) {
    return inspection;
  }
  throw Object.assign(new Error(inspection.message), {
    code: inspection.code,
    inspection,
  });
}

export function resolveCliCommand(command: CliCommandName): string {
  return inspectCliCommand(command).executable;
}
