export type DeploymentTarget = "hetzner" | "codespaces";

export interface ConnectionProfileConfig {
  managerUrl: string;
  gatewayUrl: string;
}

export interface ConnectionProfilesSettings {
  activeTarget: DeploymentTarget;
  profiles: Record<DeploymentTarget, ConnectionProfileConfig>;
}

export interface ResolvedConnectionProfile extends ConnectionProfileConfig {
  target: DeploymentTarget;
  label: string;
  isConfigured: boolean;
}

export const CONNECTION_TARGET_LABELS: Record<DeploymentTarget, string> = {
  hetzner: "Hetzner",
  codespaces: "GitHub Codespaces",
};

export const DEFAULT_CONNECTION_PROFILES: ConnectionProfilesSettings = {
  activeTarget: "codespaces",
  profiles: {
    hetzner: {
      managerUrl: "",
      gatewayUrl: "",
    },
    codespaces: {
      managerUrl: "",
      gatewayUrl: "",
    },
  },
};

function normalizeHttpsUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";

  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("Use an https:// URL");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function normalizeManagerUrl(input: string): string {
  return normalizeHttpsUrl(input);
}

export function normalizeGatewayUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (lower.startsWith("ws://") || lower.startsWith("http://")) {
    throw new Error("Use a secure gateway URL (wss:// or https://)");
  }

  const asWss = lower.startsWith("https://")
    ? `wss://${raw.slice(8)}`
    : lower.startsWith("wss://")
      ? raw
      : `wss://${raw}`;

  const url = new URL(asWss);
  if (url.protocol !== "wss:") {
    throw new Error("Use a secure gateway URL (wss:// or https://)");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function sanitizeConnectionProfiles(
  value?: Partial<ConnectionProfilesSettings> | null,
): ConnectionProfilesSettings {
  const next: ConnectionProfilesSettings = {
    activeTarget: value?.activeTarget === "hetzner" || value?.activeTarget === "codespaces"
      ? value.activeTarget
      : DEFAULT_CONNECTION_PROFILES.activeTarget,
    profiles: {
      hetzner: {
        managerUrl: "",
        gatewayUrl: "",
      },
      codespaces: {
        managerUrl: "",
        gatewayUrl: "",
      },
    },
  };

  for (const target of Object.keys(next.profiles) as DeploymentTarget[]) {
    const source = value?.profiles?.[target];
    next.profiles[target] = {
      managerUrl: typeof source?.managerUrl === "string" ? source.managerUrl : "",
      gatewayUrl: typeof source?.gatewayUrl === "string" ? source.gatewayUrl : "",
    };
  }

  return next;
}

export function resolveConnectionProfile(
  settings?: Partial<ConnectionProfilesSettings> | null,
): ResolvedConnectionProfile {
  const sanitized = sanitizeConnectionProfiles(settings);
  const target = sanitized.activeTarget;
  const profile = sanitized.profiles[target];

  return {
    target,
    label: CONNECTION_TARGET_LABELS[target],
    managerUrl: profile.managerUrl.trim(),
    gatewayUrl: profile.gatewayUrl.trim(),
    isConfigured: profile.managerUrl.trim().length > 0,
  };
}
