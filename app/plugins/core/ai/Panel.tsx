import PluginHeader, { BaseTab, usePluginHeaderHeight } from "@/components/PluginHeader";
import Loading from "@/components/Loading";
import { LinearGradient } from "expo-linear-gradient";
import { Codex, OpenCode } from "@lobehub/icons-rn";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useSessionRegistryActions } from "@/contexts/SessionRegistry";
import { useTheme } from "@/contexts/ThemeContext";
import { useConnection } from "@/contexts/ConnectionContext";
import { useEditorConfig } from "@/contexts/EditorContext";
import { useAI } from "@/hooks/useAI";
import type { AIEvent, AISession, AIMessage, AIPart, AIAgent, AIProvider, AIPermission, AIQuestion, AIFileAttachment, ModelRef, PermissionResponse, AiBackend, CodexPromptOptions, AIConfigDefaults } from "./types";
import Markdown from "./Markdown";
import ToolCall from "./ToolCall";
import FileChange from "./FileChange";
import {
  Sparkle, Sparkles, Check, X, Plus,
  Hammer, Map as MapIcon, Square, AlertTriangle, Key,
  EllipsisVertical, ChevronDown, Mic, LoaderCircle, SquaresSubtract,
} from "lucide-react-native";
import { Canvas, Circle } from "@shopify/react-native-skia";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView, TouchableOpacity } from "react-native-gesture-handler";
import { FlashList } from "@shopify/flash-list";
import Animated, {
  Easing,
  ZoomIn,
  ZoomOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import Svg, { Path } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MenuView } from "@react-native-menu/menu";
import { useDrawerStatus } from "@react-navigation/drawer";
import { innerApi } from "../../innerApi";
import { PluginPanelProps } from "../../types";
const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");
const AI_DETAILED_VIEW_STORAGE_KEY = "ai-detailed-view-enabled";
const AI_SESSION_CONFIG_STORAGE_KEY = "ai-session-configs";
const TRANSCRIBE_ENDPOINT = "https://internal-api.lunel.dev/api/transcribe";
const VOICE_WAVE_BAR_COUNT = Math.round(42 * (SCREEN_WIDTH / 390));
const VOICE_WAVE_IDLE_LEVEL = 0.08;
const VOICE_WAVE_DOT_SIZE = 2.5;
const VOICE_WAVE_MAX_EXTRA_HEIGHT = 34;
const AI_READING_LINE_HEIGHT = 1.45;
const AI_READING_LETTER_SPACING = 0.12;

// Session tab interface
interface AITab extends BaseTab {
  sessionId?: string;
  backend: "opencode" | "codex";
  updatedAt?: number;
}

const DEFAULT_OPENCODE_AGENTS: { id: string; name: string; description?: string; icon?: React.ComponentType<any> }[] = [
  { id: "build", name: "Build", description: "Direct code execution and modifications", icon: Hammer },
  { id: "plan", name: "Plan", description: "Analyze codebase and create architectural plans", icon: MapIcon },
];

type ComposerSheet = "configure" | "backend-preferences" | null;

type SessionConfigRecord = {
  agent?: string;
  model?: string;
  variant?: string;
  codexReasoningEffort?: NonNullable<CodexPromptOptions["reasoningEffort"]>;
  codexSpeed?: NonNullable<CodexPromptOptions["speed"]>;
};

type MessagesListHandle = {
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
  scrollToEnd: (params?: { animated?: boolean }) => void;
};

function sessionConfigKey(backend: AiBackend, sessionId: string): string {
  return `${backend}:${sessionId}`;
}

function toModelOptionId(model?: ModelRef | null): string {
  if (!model?.providerID || !model.modelID) return "";
  return `${model.providerID}:${model.modelID}`;
}

function normalizeAgentId(agent: AIAgent): string {
  const fromId = typeof (agent as any).id === "string" ? String((agent as any).id).trim() : "";
  if (fromId) return fromId;
  const fromMode = typeof agent.mode === "string" ? agent.mode.trim() : "";
  if (fromMode) return fromMode;
  const fromName = typeof agent.name === "string" ? agent.name.trim().toLowerCase() : "";
  return fromName;
}

function shouldShowAgentInPicker(agent: AIAgent): boolean {
  const id = normalizeAgentId(agent).toLowerCase();
  const mode = typeof agent.mode === "string" ? agent.mode.trim().toLowerCase() : "";
  if (!id) return false;
  if (mode === "subagent") return false;
  if (["compaction", "summary", "title"].includes(id)) return false;
  if (id.startsWith("ui5-") || id.startsWith("cap-")) return false;
  return true;
}

function toDisplayAgentName(agent: AIAgent, fallbackId: string): string {
  const explicitName = typeof agent.name === "string" ? agent.name.trim() : "";
  if (explicitName) return explicitName;
  return fallbackId.charAt(0).toUpperCase() + fallbackId.slice(1);
}

function getOpenCodeVariantOptions(modelOptionId: string, configDefaults?: AIConfigDefaults): Array<{ id: string; name: string }> {
  const [providerID = "", modelID = ""] = modelOptionId.split(":");
  const providerKey = providerID.toLowerCase();
  const modelKey = modelID.toLowerCase();
  const preferred = typeof configDefaults?.variant === "string" ? configDefaults.variant : "";

  let ids: string[] = [];
  if (providerKey.includes("anthropic")) {
    ids = ["high", "max"];
  } else if (
    providerKey.includes("openai")
    || providerKey.includes("github")
    || modelKey.startsWith("gpt-5")
    || modelKey.includes("codex")
  ) {
    ids = ["none", "minimal", "low", "medium", "high", "xhigh"];
  } else if (preferred) {
    ids = [preferred];
  }

  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  return uniqueIds.map((id) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
  }));
}

function AISkeleton({ colors, paddingTop = 0 }: { colors: any; paddingTop?: number }) {
  const opacity = useSharedValue(0.35);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.9, { duration: 750, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 14, paddingTop: paddingTop + 20, gap: 10, alignItems: "flex-end" }}>
      <Animated.View style={[{ height: 26, width: "70%", borderRadius: 8, backgroundColor: colors.bg.raised}, animStyle]} />
      <Animated.View style={[{ height: 26, width: "45%", borderRadius: 8, backgroundColor: colors.bg.raised}, animStyle]} />
      <Animated.View style={[{ height: 26, width: "52%", borderRadius: 8, backgroundColor: colors.bg.raised}, animStyle]} />
    </View>
  );
}

function formatBackendSessionTitle(backend: AiBackend, title?: string) {
  const label = backend === "codex" ? "Codex" : "OpenCode";
  if (title && !isGenericSessionTitle(title)) return title;
  return label;
}

function isGenericSessionTitle(title?: string): boolean {
  const normalized = (title || "").trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized === "conversation" || normalized === "new conversation") return true;
  if (/^session[\s_-]*\d*$/.test(normalized)) return true;
  if (/^(new\s+)?chat[\s_-]*\d*$/.test(normalized)) return true;
  if (/^untitled[\s_-]*\d*$/.test(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  return false;
}

function resolveSessionTitle(backend: AiBackend, sessionId: string, title?: string, fallbackTitle?: string): string {
  const explicit = (title || "").trim();
  if (explicit && !isGenericSessionTitle(explicit)) {
    return explicit;
  }

  const fallback = (fallbackTitle || "").trim();
  if (fallback && !isGenericSessionTitle(fallback)) {
    return fallback;
  }

  return `${formatBackendSessionTitle(backend)} • ${sessionId.slice(0, 6)}`;
}

function sortTabsByUpdatedAt(tabs: AITab[]): AITab[] {
  return [...tabs].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
}

function mergeSessionTabs(existingTabs: AITab[], incomingSessions: AISession[]): AITab[] {
  const byKey = new Map<string, AITab>();

    for (const tab of existingTabs) {
      byKey.set(`${tab.backend}:${tab.sessionId ?? tab.id}`, tab);
    }

    for (let i = 0; i < incomingSessions.length; i += 1) {
      const session = incomingSessions[i];
      const backend = session.backend ?? "opencode";
      const key = `${backend}:${session.id}`;
      const existing = byKey.get(key);
      const nextTitle = resolveSessionTitle(backend, session.id, session.title, existing?.title);
      const nextUpdatedAt = session.time?.updated;

    byKey.set(key, {
      id: existing?.id ?? session.id,
      sessionId: session.id,
      backend,
      title: nextTitle,
      updatedAt: typeof nextUpdatedAt === "number" ? nextUpdatedAt : existing?.updatedAt,
    });
  }

  return sortTabsByUpdatedAt(Array.from(byKey.values()));
}

function sameMessagesShape(a: AIMessage[] | undefined, b: AIMessage[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.id !== right.id) return false;
    if ((left.parts?.length || 0) !== (right.parts?.length || 0)) return false;
  }
  return true;
}

function inferImageMime(uri: string, providedMime?: string | null): string {
  if (providedMime && providedMime.trim().length > 0) {
    return providedMime;
  }
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}

// ============================================================================
// Custom SVG icons
// ============================================================================

function PaperclipIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="m15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3L18 10a3 3 0 0 0-6-6l-6.5 6.5a4.5 4.5 0 0 0 9 9L21 13" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}


function TrashIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h16m-10 4v6m4-6v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SendIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14m6-8l-6-6m-6 6l6-6" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function BrainIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M17.5 16a3.5 3.5 0 0 0 0-7H17" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0M6.5 16a3.5 3.5 0 0 1 0-7H7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function InlineChevronIcon({ size = 14, color = "currentColor", expanded = false }: { size?: number; color?: string; expanded?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={expanded ? { transform: [{ rotate: "90deg" }] } : undefined}>
      <Path d="m9 6l6 6l-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ArrowDownIcon({ size = 20, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m19 12-7 7-7-7" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}


// ============================================================================
// Helpers
// ============================================================================

function formatTokens(n?: number): string {
  if (n == null || n === 0) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function formatCost(n?: number): string {
  if (n == null || n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(2)}`;
}

function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function mergeStreamingText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;

  if (incoming.startsWith(previous)) {
    return incoming;
  }
  if (previous.startsWith(incoming)) {
    return previous;
  }

  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === incoming.slice(0, overlap)) {
      return previous + incoming.slice(overlap);
    }
  }

  return previous + incoming;
}

function findStreamingPartIndex(parts: AIPart[], incoming: AIPart): number {
  const incomingType = incoming.type;

  if (incomingType === "text" || incomingType === "reasoning") {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = parts[i];
      if (candidate.type === incomingType && !(candidate as any).id) {
        return i;
      }
    }
    return -1;
  }

  if (incomingType === "tool" || incomingType === "tool-call" || incomingType === "tool-result" || incomingType === "file-change") {
    const incomingName = String(incoming.name || incoming.toolName || "");
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = parts[i];
      if (candidate.type !== incomingType) continue;
      if ((candidate as any).id) continue;
      const candidateName = String(candidate.name || candidate.toolName || "");
      if (candidateName === incomingName) {
        return i;
      }
    }
  }

  return -1;
}

function mergePartUpdate(previous: AIPart, incoming: AIPart, options?: { replaceText?: boolean }): AIPart {
  if ((incoming.type === "text" || incoming.type === "reasoning")
      && typeof previous.text === "string"
      && typeof incoming.text === "string") {
    return {
      ...previous,
      ...incoming,
      text: options?.replaceText ? incoming.text : mergeStreamingText(previous.text, incoming.text),
    };
  }

  return {
    ...previous,
    ...incoming,
  };
}

function readMetadataString(
  metadata: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function getPermissionFields(permission: AIPermission): Array<{ label: string; value: string }> {
  const metadata = permission.metadata && typeof permission.metadata === "object"
    ? permission.metadata
    : {};

  const reason = readMetadataString(metadata, ["reason", "title", "message"]);
  const command = readMetadataString(metadata, [
    "command",
    "cmd",
    "raw_command",
    "rawCommand",
    "invocation",
  ]);
  const cwd = readMetadataString(metadata, ["cwd", "workingDirectory", "working_directory"]);

  const fields: Array<{ label: string; value: string }> = [];
  if (reason && reason !== permission.title) {
    fields.push({ label: "Reason", value: reason });
  }
  if (command) {
    fields.push({ label: "Command", value: command });
  }
  if (cwd) {
    fields.push({ label: "Directory", value: cwd });
  }
  return fields;
}

// ============================================================================
// Message Parts
// ============================================================================

function TextPartView({ part, isUser }: { part: AIPart; isUser: boolean }) {
  const text = (part.text as string) || "";
  if (!text) return null;

  if (isUser) {
    // User messages: plain text (no markdown), styled for accent bg
    return <UserText text={text} />;
  }
  // Assistant messages: full markdown rendering
  return <Markdown>{text}</Markdown>;
}

function FilePartView({ part }: { part: AIPart }) {
  const { colors, radius, fonts } = useTheme();
  const mime = typeof part.mime === "string" ? part.mime : "";
  const url = typeof part.url === "string" ? part.url : "";
  const filename = typeof part.filename === "string" ? part.filename : "Attachment";
  const isImage = mime.startsWith("image/") && url.length > 0;

  if (isImage) {
    return (
      <View style={{ marginTop: 4 }}>
        <Image
          source={{ uri: url }}
          style={{
            width: 180,
            height: 180,
            borderRadius: radius.lg,
            backgroundColor: colors.bg.raised,
          }}
          resizeMode="cover"
        />
      </View>
    );
  }

  return (
    <View
      style={{
        marginTop: 4,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: radius.lg,
        backgroundColor: colors.bg.raised,
      }}
    >
      <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.medium }}>
        {filename}
      </Text>
    </View>
  );
}

function UserText({ text }: { text: string }) {
  const { colors, fonts } = useTheme();
  const { config } = useEditorConfig();
  const fontSize = config.aiFontSize;
  const lineHeight = Math.round(fontSize * AI_READING_LINE_HEIGHT);
  return (
    <Text
      style={{
        color: colors.fg.default,
        fontSize,
        fontFamily: fonts.sans.regular,
        lineHeight,
        letterSpacing: AI_READING_LETTER_SPACING,
      }}
      selectable
    >
      {text}
    </Text>
  );
}

function ReasoningPartView({ part }: { part: AIPart }) {
  const { colors, fonts, radius } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const text = (part.text as string) || (typeof part.reasoning === "string" ? part.reasoning : "");

  return (
    <View style={styles.reasoningContainer}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={styles.reasoningHeader}
        activeOpacity={0.7}
      >
        <BrainIcon size={14} color={colors.fg.muted} />
        <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.medium }}>
          Thinking
        </Text>
        <InlineChevronIcon size={14} color={colors.fg.muted} expanded={expanded} />
      </TouchableOpacity>
      {expanded && text ? (
        <View style={[styles.reasoningBody, { borderColor: colors.bg.raised, backgroundColor: colors.bg.raised, borderRadius: radius.sm }]}>
          <Markdown compact>{text}</Markdown>
        </View>
      ) : null}
    </View>
  );
}

function StepStartView({ part }: { part: AIPart }) {
  const { colors, fonts } = useTheme();
  const title = (part.title as string) || "";

  return (
    <View style={styles.stepContainer}>
      <View style={styles.stepContent}>
        {title ? (
          <Text style={{ color: colors.fg.subtle, fontSize: 11, fontFamily: fonts.mono.regular }}>
            {title}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function StepFinishView({ part, showDetailedView }: { part: AIPart; showDetailedView: boolean }) {
  const { colors, fonts, radius } = useTheme();
  if (!showDetailedView) return null;
  const tokens = part.tokens;
  const cost = part.cost as number | undefined;

  if (!tokens && !cost) return null;

  const chips: { label: string; value: string }[] = [];
  if (tokens?.input) chips.push({ label: "In", value: formatTokens(tokens.input) });
  if (tokens?.output) chips.push({ label: "Out", value: formatTokens(tokens.output) });
  if (tokens?.reasoning) chips.push({ label: "Think", value: formatTokens(tokens.reasoning) });
  if (tokens?.cache?.read) chips.push({ label: "Cache", value: formatTokens(tokens.cache.read) });
  if (cost) chips.push({ label: "Cost", value: formatCost(cost) });

  if (chips.length === 0) return null;

  return (
    <View style={styles.tokenRow}>
      {chips.map((chip, i) => (
        <View key={i} style={[styles.tokenChip, { backgroundColor: colors.bg.raised, borderRadius: radius.sm }]}>
          <Text style={{ color: colors.fg.subtle, fontSize: 9, fontFamily: fonts.mono.regular }}>
            {chip.label}
          </Text>
          <Text style={{ color: colors.fg.muted, fontSize: 10, fontFamily: fonts.mono.medium }}>
            {chip.value}
          </Text>
        </View>
      ))}
    </View>
  );
}


function PulsingDots({ color }: { color: string }) {
  const opacity = useSharedValue(0.08);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.85, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.08, { duration: 1000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []);

  const s = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const dot = { width: 4, height: 4, borderRadius: 2, backgroundColor: color, marginHorizontal: 1.5 };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, marginRight: 4 }}>
      <Animated.View style={[dot, s]} />
      <Animated.View style={[dot, s]} />
      <Animated.View style={[dot, s]} />
    </View>
  );
}

function ErrorMessageView({ text }: { text: string }) {
  const { colors, fonts, radius } = useTheme();
  return (
    <View style={[styles.errorMessage, { backgroundColor: '#ef444420', borderRadius: radius.sm, borderLeftColor: '#ef4444' }]}>
      <AlertTriangle size={13} color={'#ef4444'} strokeWidth={2} />
      <Text style={{ color: '#ef4444', fontSize: 12, fontFamily: fonts.mono.regular, flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

function ThinkingIndicatorView({ label = "Thinking..." }: { label?: string }) {
  const { fonts } = useTheme();

  return (
    <View style={styles.thinkingMessage}>
      <SnakeDotsLoader />
      <Text style={[styles.thinkingText, { color: "#9a9a9a", fontFamily: fonts.sans.medium }]}>
        {label}
      </Text>
    </View>
  );
}

const SNAKE_PATH_ORDER = [2, 1, 0, 3, 6, 7, 8, 5, 4, 1] as const;
const GRID_POSITIONS = [
  [0, 0], [1, 0], [2, 0],
  [0, 1], [1, 1], [2, 1],
  [0, 2], [1, 2], [2, 2],
] as const;

function SnakeDotsLoader({
  radius = 1.6,
  spacing = 3.8,
  padding = 0.9,
}: {
  radius?: number;
  spacing?: number;
  padding?: number;
}) {
  const [step, setStep] = useState(0);
  const canvasSize = radius * 6 + spacing * 2 + padding * 2;
  const stepSize = radius * 2 + spacing;
  const totalSteps = SNAKE_PATH_ORDER.length;

  useEffect(() => {
    const id = setInterval(() => {
      setStep((current) => (current + 1) % totalSteps);
    }, 130);
    return () => clearInterval(id);
  }, [totalSteps]);

  const getDistanceFromHead = (dotIndex: number) => {
    const pathIndex = SNAKE_PATH_ORDER.indexOf(dotIndex as (typeof SNAKE_PATH_ORDER)[number]);
    if (pathIndex < 0) return totalSteps;
    return (step - pathIndex + totalSteps) % totalSteps;
  };

  const getDotOpacity = (dotIndex: number) => {
    const distance = getDistanceFromHead(dotIndex);
    if (distance === 0) return 1;
    if (distance === 1) return 0.74;
    if (distance === 2) return 0.5;
    if (distance === 3) return 0.34;
    return 0.22;
  };

  const getDotColor = (dotIndex: number) => {
    const distance = getDistanceFromHead(dotIndex);
    return distance === 0 ? "#ececec" : "#a8a8a8";
  };

  return (
    <Canvas style={{ width: canvasSize, height: canvasSize }}>
      {GRID_POSITIONS.map(([x, y], index) => {
        const distance = getDistanceFromHead(index);
        const cx = padding + radius + x * stepSize;
        const cy = padding + radius + y * stepSize;

        return (
          <React.Fragment key={index}>
            <Circle
              cx={cx}
              cy={cy}
              r={radius}
              color={getDotColor(index)}
              opacity={getDotOpacity(index)}
            />
          </React.Fragment>
        );
      })}
    </Canvas>
  );
}

function deriveActivityLabelFromPart(part: AIPart): string | null {
  if (part.type === "reasoning") return "Thinking...";
  if (part.type !== "tool" && part.type !== "tool-call" && part.type !== "tool-result") return null;

  const inputRaw = typeof part.input === "string"
    ? part.input
    : (part.input && typeof part.input === "object")
      ? JSON.stringify(part.input)
      : "";
  const outputRaw = typeof part.output === "string"
    ? part.output
    : "";
  const raw = `${String(part.toolName || "")} ${String(part.name || "")} ${inputRaw} ${outputRaw}`.toLowerCase();
  if (!raw) return "Working...";

  if (
    raw.includes("search")
    || raw.includes("grep")
    || raw.includes("ripgrep")
    || raw.includes("glob")
    || raw.includes("find")
    || raw.includes("scan")
    || raw.includes("list_files")
    || raw.includes("listfiles")
    || raw.includes("ls ")
    || raw.includes("ls\n")
    || raw.includes("tree")
    || raw.includes("read")
    || raw.includes("cat ")
    || raw.includes("cat\n")
    || raw.includes("open file")
    || raw.includes("open_file")
    || raw.includes("view file")
  ) {
    return "Searching codebase...";
  }

  if (
    raw.includes("edit")
    || raw.includes("write")
    || raw.includes("patch")
    || raw.includes("file-change")
    || raw.includes("filechange")
    || raw.includes("diff")
  ) {
    return "Working...";
  }

  if (raw.includes("command") || raw.includes("exec")) {
    return "Working...";
  }

  return "Working...";
}

type MessageDisplayItem =
  | { kind: "part"; key: string; part: AIPart }
  | { kind: "command-group"; key: string; parts: AIPart[] };

function isGroupablePart(part: AIPart): boolean {
  return part.type !== "text" && part.type !== "file";
}

function buildToolGroupLabel(parts: AIPart[]): string {
  let thinkingCount = 0;
  let toolCount = 0;
  for (const p of parts) {
    if (p.type === "reasoning") thinkingCount += 1;
    else if (p.type === "tool" || p.type === "tool-call" || p.type === "tool-result" || p.type === "file-change") toolCount += 1;
  }
  if (thinkingCount > 0 && toolCount > 0) return `Thinking · ${toolCount} tool${toolCount !== 1 ? "s" : ""}`;
  if (thinkingCount > 0) return "Thinking";
  if (toolCount > 0) return `${toolCount} tool${toolCount !== 1 ? "s" : ""}`;
  return `${parts.length} step${parts.length !== 1 ? "s" : ""}`;
}

function buildMessageDisplayItems(parts: AIPart[]): MessageDisplayItem[] {
  const items: MessageDisplayItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (isGroupablePart(part)) {
      const runStart = i;
      while (i < parts.length && isGroupablePart(parts[i])) i += 1;
      const runParts = parts.slice(runStart, i);
      if (runParts.length > 1) {
        items.push({
          kind: "command-group",
          key: `tool-group-${String((runParts[0] as any).id || runStart)}`,
          parts: runParts,
        });
      } else {
        items.push({
          kind: "part",
          key: String((runParts[0] as any).id || `part-${runStart}`),
          part: runParts[0],
        });
      }
    } else {
      items.push({
        kind: "part",
        key: String((part as any).id || `part-${i}`),
        part,
      });
      i += 1;
    }
  }
  return items;
}

// ============================================================================
// Message Bubble
// ============================================================================

function MessageBubble({
  message,
  colors,
  fonts,
  radius,
  showDetailedView,
  pendingPermission,
  onPermissionReply,
}: {
  message: AIMessage;
  colors: any;
  fonts: any;
  radius: any;
  showDetailedView: boolean;
  pendingPermission?: AIPermission | null;
  onPermissionReply?: (response: PermissionResponse) => void;
}) {
  const isUser = message.role === "user";
  const parts = message.parts || [];
  const displayItems = useMemo(() => buildMessageDisplayItems(parts), [parts]);

  const handleCopy = async () => {
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => (p.text as string) || "")
      .join("\n");
    if (text) await Clipboard.setStringAsync(text);
  };

  if (isUser) {
    const localStatus = typeof message.metadata?.localStatus === "string" ? message.metadata.localStatus : undefined;
    const isSending = localStatus === "sending" || (localStatus == null && message.id.startsWith("opt-"));
    return (
      <View style={{ alignSelf: "flex-end", alignItems: "flex-end", marginVertical: 7 }}>
        <TouchableOpacity
          onLongPress={handleCopy}
          activeOpacity={0.8}
          style={[
            styles.userBubble,
            {
              backgroundColor: colors.bg.raised,
              borderRadius: 10,
            },
          ]}
        >
          {parts.map((part, i) => (
            <View key={i} style={i > 0 ? getMessagePartSpacingStyle(parts[i - 1], part, styles) : undefined}>
              <MessagePartView
                part={part}
                isUser={true}
                colors={colors}
                fonts={fonts}
                radius={radius}
                showDetailedView={showDetailedView}
              />
            </View>
          ))}
        </TouchableOpacity>
        {isSending ? (
          <PulsingDots color={colors.fg.subtle} />
        ) : null}
      </View>
    );
  }

  // Assistant: full-width, no bubble bg
  return (
    <TouchableOpacity
      onLongPress={handleCopy}
      activeOpacity={1}
      style={styles.assistantMessage}
    >
      {displayItems.map((item, i) => (
        <View
          key={item.key}
          style={i > 0 ? getDisplayItemSpacingStyle(displayItems[i - 1], item, styles) : undefined}
        >
          {item.kind === "command-group" ? (
            <CommandPartsDropdown
              commandParts={item.parts}
              colors={colors}
              fonts={fonts}
              radius={radius}
              showDetailedView={showDetailedView}
              pendingPermission={pendingPermission}
              onPermissionReply={onPermissionReply}
            />
          ) : (
            <MessagePartView
              part={item.part}
              isUser={false}
              colors={colors}
              fonts={fonts}
              radius={radius}
              showDetailedView={showDetailedView}
              pendingPermission={pendingPermission}
              onPermissionReply={onPermissionReply}
            />
          )}
        </View>
      ))}
    </TouchableOpacity>
  );
}

function getMessagePartSpacingStyle(previous: AIPart | undefined, current: AIPart, styles: any) {
  if (!previous) return undefined;

  const previousHasTextOutput = partHasTextOutput(previous);
  const currentHasTextOutput = partHasTextOutput(current);

  if (previousHasTextOutput || currentHasTextOutput) {
    return styles.messagePartSpacingLoose;
  }

  return styles.messagePartSpacingTight;
}

function partHasTextOutput(part: AIPart) {
  if (part.type === "text" || part.type === "reasoning") return true;
  if ((part.type === "tool" || part.type === "tool-call" || part.type === "tool-result" || part.type === "file-change") && typeof part.output === "string") {
    return part.output.trim().length > 0;
  }
  return false;
}

function getDisplayItemSpacingStyle(previous: MessageDisplayItem, current: MessageDisplayItem, styles: any) {
  if (previous.kind === "command-group" && current.kind === "command-group") {
    return styles.messagePartSpacingGroups;
  }

  const previousHasTextOutput = itemHasTextOutput(previous);
  const currentHasTextOutput = itemHasTextOutput(current);

  if (previousHasTextOutput || currentHasTextOutput) {
    return styles.messagePartSpacingLoose;
  }

  return styles.messagePartSpacingTight;
}

function itemHasTextOutput(item: MessageDisplayItem) {
  if (item.kind === "command-group") return false;
  return partHasTextOutput(item.part);
}

function CommandPartsDropdown({
  commandParts,
  colors,
  fonts,
  radius,
  showDetailedView,
  pendingPermission,
  onPermissionReply,
}: {
  commandParts: AIPart[];
  colors: any;
  fonts: any;
  radius: any;
  showDetailedView: boolean;
  pendingPermission?: AIPermission | null;
  onPermissionReply?: (response: PermissionResponse) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = buildToolGroupLabel(commandParts);

  return (
    <View style={styles.commandGroupContainer}>
      <TouchableOpacity
        onPress={() => setExpanded((value) => !value)}
        activeOpacity={0.7}
        style={[styles.commandGroupHeader, { backgroundColor: colors.bg.raised, borderRadius: 8 }]}
      >
        <View style={styles.commandGroupHeaderLeft}>
          <SquaresSubtract size={13} color={colors.fg.muted} strokeWidth={2} />
          <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.mono.regular }}>
            {label}
          </Text>
        </View>
        <InlineChevronIcon size={14} color={colors.fg.muted} expanded={expanded} />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.commandGroupBody}>
          {commandParts.map((part, index) => (
            <View key={String((part as any).id || `command-part-${index}`)}>
              <MessagePartView
                part={part}
                isUser={false}
                colors={colors}
                fonts={fonts}
                radius={radius}
                showDetailedView={showDetailedView}
                pendingPermission={pendingPermission}
                onPermissionReply={onPermissionReply}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MessagePartView({
  part,
  isUser,
  colors,
  fonts,
  radius,
  showDetailedView,
  pendingPermission,
  onPermissionReply,
}: {
  part: AIPart;
  isUser: boolean;
  colors: any;
  fonts: any;
  radius: any;
  showDetailedView: boolean;
  pendingPermission?: AIPermission | null;
  onPermissionReply?: (response: PermissionResponse) => void;
}) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} isUser={isUser} />;
    case "file":
      return <FilePartView part={part} />;
    case "tool":
    case "tool-call":
    case "tool-result":
      return (
        <ToolCall
          part={part}
          colors={colors}
          fonts={fonts}
          radius={radius}
          permission={pendingPermission}
          onPermissionReply={onPermissionReply}
        />
      );
    case "file-change":
      return (
        <FileChange
          part={part}
          colors={colors}
          fonts={fonts}
          radius={radius}
        />
      );
    case "reasoning":
      return <ReasoningPartView part={part} />;
    case "step-start":
      return <StepStartView part={part} />;
    case "step-finish":
      return <StepFinishView part={part} showDetailedView={showDetailedView} />;
    default:
      return null;
  }
}

// ============================================================================
// Permission Sheet
// ============================================================================

function PermissionSheet({
  visible,
  permission,
  colors,
  radius,
  fonts,
  onReply,
}: {
  visible: boolean;
  permission: AIPermission;
  colors: any;
  radius: any;
  fonts: any;
  onReply: (response: PermissionResponse) => void;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(SCREEN_HEIGHT);
  const fields = getPermissionFields(permission);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = SCREEN_HEIGHT;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdropOpacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(
        SCREEN_HEIGHT,
        {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (finished) runOnJS(hideModal)();
        }
      );
    }
  }, [visible, backdropOpacity, sheetTranslateY, hideModal]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible) return null;

  return (
    <Modal transparent animationType="none" visible onRequestClose={() => {}}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <Animated.View style={[styles.sheetBackdrop, backdropAnimatedStyle]} pointerEvents="none" />
          <Animated.View
            style={[
              styles.sheetContainer,
              {
                backgroundColor: colors.bg.raised,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                minHeight: 320,
                maxHeight: SCREEN_HEIGHT * 0.62,
              },
              sheetAnimatedStyle,
            ]}
          >
            <View style={styles.sheetHeader}>
              <Text style={{ color: colors.fg.default, fontSize: 20, fontFamily: fonts.sans.semibold, flex: 1 }}>
                Permission Request
              </Text>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}
              keyboardDismissMode="on-drag"
            >
              <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold }}>
                {permission.title || permission.type}
              </Text>

              {fields.length > 0 ? (
                <View style={{ gap: 10 }}>
                  {fields.map((field) => (
                    <View key={field.label} style={{ gap: 4 }}>
                      <Text style={{ color: colors.fg.subtle, fontSize: 14, fontFamily: fonts.sans.medium }}>
                        {field.label}
                      </Text>
                      <Text
                        style={{
                          color: colors.fg.default,
                          fontSize: 14,
                          fontFamily: field.label === "Command" || field.label === "Directory"
                            ? fonts.mono.regular
                            : fonts.sans.regular,
                        }}
                      >
                        {field.value}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={{ gap: 8, paddingTop: 2 }}>
                <TouchableOpacity
                  onPress={() => onReply("once")}
                  style={[styles.permissionSheetPrimaryButton, { backgroundColor: colors.accent.default, borderRadius: radius.xl }]}
                  activeOpacity={0.75}
                >
                  <Text style={{ color: '#ffffff', fontSize: 14, fontFamily: fonts.sans.semibold }}>Allow Once</Text>
                </TouchableOpacity>
                <View style={{ gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => onReply("always")}
                    style={[styles.permissionSheetSecondaryButton, { backgroundColor: colors.bg.base, borderRadius: radius.xl, borderColor: colors.border.secondary }]}
                    activeOpacity={0.75}
                  >
                    <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold }}>Always Allow</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onReply("reject")}
                    style={[styles.permissionSheetSecondaryButton, { backgroundColor: colors.bg.base, borderRadius: radius.xl, borderColor: colors.border.secondary }]}
                    activeOpacity={0.75}
                  >
                    <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold }}>Deny</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function QuestionDialog({ questionRequest, colors, radius, fonts, onSubmit, onReject }: {
  questionRequest: AIQuestion;
  colors: any;
  radius: any;
  fonts: any;
  onSubmit: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const firstQuestion = questionRequest.questions[0];
  const options = Array.isArray(firstQuestion?.options) ? firstQuestion.options : [];
  const [selectedIndex, setSelectedIndex] = useState<number | null>(options.length > 0 ? 0 : null);
  const [freeform, setFreeform] = useState("");

  const handleSubmit = () => {
    if (options.length > 0 && selectedIndex != null && options[selectedIndex]?.label) {
      onSubmit([[options[selectedIndex].label]]);
      return;
    }
    const trimmed = freeform.trim();
    if (trimmed.length > 0) {
      onSubmit([[trimmed]]);
    }
  };

  return (
    <Modal transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { backgroundColor: colors.bg.raised, borderRadius: radius.md, borderColor: colors.bg.raised }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Sparkles size={20} color={colors.accent.default} strokeWidth={2} />
            <Text style={{ color: colors.fg.default, fontSize: 15, fontFamily: fonts.sans.semibold }}>Input Needed</Text>
          </View>
          <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold, marginBottom: 6 }}>
            {firstQuestion?.header || "Question"}
          </Text>
          <Text style={{ color: colors.fg.muted, fontSize: 13, fontFamily: fonts.sans.regular, marginBottom: 14 }}>
            {firstQuestion?.question || "The agent needs your input to continue."}
          </Text>
          {options.length > 0 ? (
            <View style={{ gap: 8, marginBottom: 16 }}>
              {options.map((option, index) => {
                const active = selectedIndex === index;
                return (
                  <TouchableOpacity
                    key={`${option.label}:${index}`}
                    onPress={() => setSelectedIndex(index)}
                    style={{
                      borderWidth: 1,
                      borderColor: active ? colors.accent.default : colors.bg.raised,
                      backgroundColor: active ? colors.bg.raised : colors.bg.raised,
                      borderRadius: radius.md,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.semibold }}>
                      {option.label}
                    </Text>
                    {!!option.description && (
                      <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular, marginTop: 4 }}>
                        {option.description}
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <TextInput
              value={freeform}
              onChangeText={setFreeform}
              placeholder="Type your answer"
              placeholderTextColor={colors.fg.muted}
              multiline
              style={{
                color: colors.fg.default,
                backgroundColor: colors.bg.raised,
                borderRadius: radius.md,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 96,
                textAlignVertical: "top",
                marginBottom: 16,
              }}
            />
          )}
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <TouchableOpacity
              onPress={onReject}
              style={[styles.permissionBtn, { backgroundColor: colors.bg.raised, borderRadius: radius.sm }]}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.semibold }}>Dismiss</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              style={[styles.permissionBtn, { backgroundColor: colors.accent.default, borderRadius: radius.sm, opacity: options.length > 0 || freeform.trim().length > 0 ? 1 : 0.5 }]}
              activeOpacity={0.7}
              disabled={options.length === 0 && freeform.trim().length === 0}
            >
              <Text style={{ color: '#ffffff', fontSize: 13, fontFamily: fonts.sans.semibold }}>Submit</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================================
// API Key Setup
// ============================================================================

function ApiKeySetup({ providers, colors, radius, fonts, onSetKey }: {
  providers: AIProvider[];
  colors: any;
  radius: any;
  fonts: any;
  onSetKey: (providerId: string, key: string) => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>(providers[0]?.id || "");
  const [keyInput, setKeyInput] = useState("");

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <Key size={40} color={colors.fg.muted} strokeWidth={1.5} />
      <Text style={{ color: colors.fg.default, fontSize: 16, fontFamily: fonts.sans.semibold, marginTop: 16, marginBottom: 8 }}>
        API Key Required
      </Text>
      <Text style={{ color: colors.fg.muted, fontSize: 13, fontFamily: fonts.sans.regular, textAlign: "center", marginBottom: 24 }}>
        Configure an API key for your AI provider to get started.
      </Text>

      {providers.map((p) => (
        <TouchableOpacity
          key={p.id}
          onPress={() => setSelectedProvider(p.id)}
          style={{
            flexDirection: "row", alignItems: "center", gap: 8,
            padding: 12, marginBottom: 8, width: "100%",
            backgroundColor: selectedProvider === p.id ? colors.bg.raised : colors.bg.raised,
            borderRadius: radius.sm, borderWidth: 1, borderColor: colors.bg.raised,
          }}
          activeOpacity={0.7}
        >
          <View style={{
            width: 16, height: 16, borderRadius: 8,
            borderWidth: 2, borderColor: selectedProvider === p.id ? colors.accent.default : colors.fg.muted,
            backgroundColor: selectedProvider === p.id ? colors.accent.default : "transparent",
          }} />
          <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.regular }}>{p.name || p.id}</Text>
        </TouchableOpacity>
      ))}

      <TextInput
        style={{
          width: "100%", padding: 12, marginTop: 8,
          backgroundColor: colors.bg.raised, borderRadius: radius.sm,
          color: colors.fg.default, fontSize: 13, fontFamily: fonts.mono.regular,
        }}
        placeholder="Paste API key here..."
        placeholderTextColor={colors.fg.subtle}
        value={keyInput}
        onChangeText={setKeyInput}
        secureTextEntry
        autoCapitalize="none"
      />

      <TouchableOpacity
        onPress={() => {
          if (selectedProvider && keyInput.trim()) {
            onSetKey(selectedProvider, keyInput.trim());
            setKeyInput("");
          }
        }}
        style={{
          marginTop: 16, paddingHorizontal: 24, paddingVertical: 12,
          backgroundColor: keyInput.trim() ? colors.accent.default : colors.bg.raised,
          borderRadius: radius.md,
        }}
        disabled={!keyInput.trim()}
        activeOpacity={0.7}
      >
        <Text style={{ color: keyInput.trim() ? '#ffffff' : colors.fg.subtle, fontSize: 14, fontFamily: fonts.sans.semibold }}>
          Save Key
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================================================
// Backend Picker Sheet
// ============================================================================

function BackendPickerDialog({
  visible,
  onPick,
  onClose,
  colors,
  radius,
  fonts,
}: {
  visible: boolean;
  onPick: (backend: "opencode" | "codex") => void;
  onClose: () => void;
  colors: any;
  radius: any;
  fonts: any;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(SCREEN_HEIGHT);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = SCREEN_HEIGHT;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdropOpacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(
        SCREEN_HEIGHT,
        {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (finished) runOnJS(hideModal)();
        }
      );
    }
  }, [visible, backdropOpacity, sheetTranslateY, hideModal]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible) return null;

  const options: Array<{
    backend?: "opencode" | "codex";
    label: string;
    description: string;
    disabled?: boolean;
  }> = [
    { backend: "codex", label: "Codex", description: "OpenAI Codex CLI" },
    { backend: "opencode", label: "OpenCode", description: "The open source AI coding agent" },
    { label: "Claude Code", description: "Coming soon", disabled: true },
  ];
  const text = {
    header: "New Session",
  };

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <Animated.View style={[styles.sheetBackdrop, backdropAnimatedStyle]} pointerEvents="box-none">
            <Pressable style={{ flex: 1 }} onPress={onClose} />
          </Animated.View>
          <Animated.View
            style={[
              styles.sheetContainer,
              {
                backgroundColor: colors.bg.raised,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                height: "36%",
              },
              sheetAnimatedStyle,
            ]}
          >
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.fg.default, fontSize: 18, fontFamily: fonts.sans.semibold }}>
                  {text.header}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onClose();
                }}
                activeOpacity={0.7}
                style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}
              >
                <X size={18} color={colors.fg.default} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flex: 1, marginBottom: 20 }} contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 18, gap: 6 }} keyboardDismissMode="on-drag">
              {options.map(({ backend, label, description, disabled }) => (
                <TouchableOpacity
                  key={backend ?? label}
                  onPress={() => {
                    if (!disabled && backend) onPick(backend);
                  }}
                  activeOpacity={0.75}
                  disabled={disabled}
                  style={[styles.backendOption, {
                    backgroundColor: disabled ? colors.bg.base : colors.bg.raised,
                    borderRadius: 10,
                    opacity: disabled ? 0.55 : 1,
                  }]}
                >
                  <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.medium }}>
                    {label}
                  </Text>
                  <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular, marginTop: 1 }}>
                    {description}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ============================================================================
// Bottom Sheet Picker
// ============================================================================

function ConfigureSheet({
  visible,
  backend,
  modeOptions,
  selectedModeId,
  onSelectMode,
  modelOptions,
  selectedModelId,
  onSelectModel,
  showDetailedView,
  onToggleDetailedView,
  onClose,
  colors,
  radius,
  fonts,
}: {
  visible: boolean;
  backend: AiBackend;
  modeOptions: { id: string; name: string; description?: string; icon?: React.ComponentType<any> }[];
  selectedModeId: string;
  onSelectMode: (id: string) => void;
  modelOptions: { id: string; name: string }[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  showDetailedView: boolean;
  onToggleDetailedView: (value: boolean) => void;
  onClose: () => void;
  colors: any;
  radius: any;
  fonts: any;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(SCREEN_HEIGHT);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = SCREEN_HEIGHT;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdropOpacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(
        SCREEN_HEIGHT,
        {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (finished) runOnJS(hideModal)();
        }
      );
    }
  }, [visible, backdropOpacity, sheetTranslateY, hideModal]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible) return null;

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[styles.sheetBackdrop, backdropAnimatedStyle]} pointerEvents="box-none">
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <Animated.View
            style={[
              styles.sheetContainer,
              {
                backgroundColor: colors.bg.raised,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                minHeight: 320,
                maxHeight: SCREEN_HEIGHT * 0.7,
              },
              sheetAnimatedStyle,
            ]}
        >
          <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border.secondary }} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={{ flex: 1, color: colors.fg.default, fontSize: 17, fontFamily: fonts.sans.semibold, letterSpacing: -0.3 }}>Configure</Text>
            <TouchableOpacity
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }}
              activeOpacity={0.7}
              style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}
            >
              <X size={16} color={colors.fg.muted} strokeWidth={2.5} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1, marginBottom: 20 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }}
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            {backend === "opencode" && modeOptions.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Agent Mode
                </Text>
                {modeOptions.map((option) => {
                  const selected = option.id === selectedModeId;
                  const Icon = option.icon || Sparkles;
                  return (
                    <TouchableOpacity
                      key={option.id}
                      style={{
                        borderWidth: 1,
                        borderColor: selected ? colors.accent.default : colors.border.secondary,
                        backgroundColor: selected ? colors.bg.raised : colors.bg.base,
                        borderRadius: 12,
                        padding: 14,
                        gap: 4,
                      }}
                      onPress={() => onSelectMode(option.id)}
                      activeOpacity={0.7}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Icon size={16} color={selected ? colors.accent.default : colors.fg.muted} />
                        <Text
                          numberOfLines={1}
                          style={{
                            flex: 1,
                            color: selected ? colors.accent.default : colors.fg.default,
                            fontSize: 14,
                            fontFamily: fonts.sans.semibold,
                          }}
                        >
                          {option.name}
                        </Text>
                        {selected && <Check size={16} color={colors.accent.default} />}
                      </View>
                      {option.description ? (
                        <Text style={{ color: colors.fg.muted, fontSize: 13, fontFamily: fonts.sans.regular, marginTop: 4, lineHeight: 18 }}>
                          {option.description}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Model
              </Text>
              {modelOptions.length > 0 ? modelOptions.map((option) => {
                const selected = option.id === selectedModelId;
                return (
                  <TouchableOpacity
                    key={option.id}
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? colors.accent.default : colors.border.secondary,
                      backgroundColor: selected ? colors.bg.raised : colors.bg.base,
                      borderRadius: 12,
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                    onPress={() => onSelectModel(option.id)}
                    activeOpacity={0.7}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        color: selected ? colors.accent.default : colors.fg.default,
                        fontSize: 14,
                        fontFamily: fonts.sans.semibold,
                      }}
                    >
                      {option.name}
                    </Text>
                    {selected && <Check size={16} color={colors.accent.default} />}
                  </TouchableOpacity>
                );
              }) : (
                <Text style={{ color: colors.fg.subtle, fontSize: 13, fontFamily: fonts.sans.regular, paddingHorizontal: 2 }}>
                  No models available
                </Text>
              )}
            </View>
          </ScrollView>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function BackendPreferencesSheet({
  visible,
  backend,
  selectedReasoningEffort,
  selectedSpeed,
  availableReasoningOptions,
  onSelectReasoningEffort,
  onSelectSpeed,
  opencodeVariantOptions,
  selectedVariant,
  onSelectVariant,
  showDetailedView,
  onToggleDetailedView,
  onClose,
  colors,
  radius,
  fonts,
}: {
  visible: boolean;
  backend: AiBackend;
  selectedReasoningEffort: NonNullable<CodexPromptOptions["reasoningEffort"]>;
  selectedSpeed: NonNullable<CodexPromptOptions["speed"]>;
  availableReasoningOptions: Array<NonNullable<CodexPromptOptions["reasoningEffort"]>>;
  onSelectReasoningEffort: (value: NonNullable<CodexPromptOptions["reasoningEffort"]>) => void;
  onSelectSpeed: (value: NonNullable<CodexPromptOptions["speed"]>) => void;
  opencodeVariantOptions: Array<{id: string; name: string}>;
  selectedVariant: string;
  onSelectVariant: (value: string) => void;
  showDetailedView: boolean;
  onToggleDetailedView: (value: boolean) => void;
  onClose: () => void;
  colors: any;
  radius: any;
  fonts: any;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(SCREEN_HEIGHT);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = SCREEN_HEIGHT;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdropOpacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(
        SCREEN_HEIGHT,
        {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (finished) runOnJS(hideModal)();
        }
      );
    }
  }, [visible, backdropOpacity, sheetTranslateY, hideModal]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible) return null;

  const allReasoningOptions: Array<{ id: NonNullable<CodexPromptOptions["reasoningEffort"]>; label: string; description: string }> = [
    { id: "low", label: "Low", description: "Fastest responses with lighter reasoning." },
    { id: "medium", label: "Medium", description: "Balanced speed and reasoning depth." },
    { id: "high", label: "High", description: "More deliberate, deeper reasoning." },
    { id: "xhigh", label: "XHigh", description: "Maximum reasoning depth for supported models." },
  ];
  const reasoningOptions = allReasoningOptions.filter((option) => availableReasoningOptions.some((value) => value === option.id));
  const speedOptions: Array<{ id: NonNullable<CodexPromptOptions["speed"]>; label: string; description: string }> = [
    { id: "fast", label: "Fast", description: "Prioritize lower latency." },
    { id: "balanced", label: "Balanced", description: "Balance speed and quality." },
    { id: "quality", label: "Quality", description: "Prioritize best output quality." },
  ];

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <Animated.View style={[styles.sheetBackdrop, backdropAnimatedStyle]} pointerEvents="box-none">
            <Pressable style={{ flex: 1 }} onPress={onClose} />
          </Animated.View>
          <Animated.View
            style={[
              styles.sheetContainer,
              {
                backgroundColor: colors.bg.raised,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                height: "52%",
              },
              sheetAnimatedStyle,
            ]}
          >
            <View style={styles.sheetHeader}>
              <Text style={{ flex: 1, color: colors.fg.default, fontSize: 18, fontFamily: fonts.sans.semibold }}>{backend === 'opencode' ? 'OpenCode Preferences' : 'Codex Preferences'}</Text>
              <TouchableOpacity
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onClose();
                }}
                activeOpacity={0.7}
                style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}
              >
                <X size={18} color={colors.fg.default} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ flex: 1, marginBottom: 20 }}
              contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 18, gap: 12 }}
              keyboardDismissMode="on-drag"
            >
              {backend === "opencode" ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2 }}>
                    Reasoning Variant
                  </Text>
                  {opencodeVariantOptions.map((option) => {
                    const selected = option.id === selectedVariant;
                    return (
                      <TouchableOpacity
                        key={option.id}
                        style={[
                          styles.sheetRow,
                          {
                            backgroundColor: selected ? colors.bg.base : colors.bg.raised,
                            borderRadius: 10,
                          },
                        ]}
                        onPress={() => onSelectVariant(option.id)}
                        activeOpacity={0.7}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.medium }}>
                            {option.name}
                          </Text>
                        </View>
                        {selected && <Check size={16} color={colors.accent.default} />}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <>
                  <View style={{ gap: 6 }}>
                    <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2 }}>
                      Reasoning
                    </Text>
                    {reasoningOptions.map((option) => {
                      const selected = option.id === selectedReasoningEffort;
                      return (
                        <TouchableOpacity
                          key={option.id}
                          style={[
                            styles.sheetRow,
                            {
                              backgroundColor: selected ? colors.bg.base : colors.bg.raised,
                              borderRadius: 10,
                            },
                          ]}
                          onPress={() => onSelectReasoningEffort(option.id)}
                          activeOpacity={0.7}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.medium }}>
                              {option.label}
                            </Text>
                            <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.sans.regular, marginTop: 2 }}>
                              {option.description}
                            </Text>
                          </View>
                          {selected && <Check size={16} color={colors.accent.default} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={{ gap: 6 }}>
                    <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2 }}>
                      Speed
                    </Text>
                    {speedOptions.map((option) => {
                      const selected = option.id === selectedSpeed;
                      return (
                        <TouchableOpacity
                          key={option.id}
                          style={[
                            styles.sheetRow,
                            {
                              backgroundColor: selected ? colors.bg.base : colors.bg.raised,
                              borderRadius: 10,
                            },
                          ]}
                          onPress={() => onSelectSpeed(option.id)}
                          activeOpacity={0.7}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.medium }}>
                              {option.label}
                            </Text>
                            <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.sans.regular, marginTop: 2 }}>
                              {option.description}
                            </Text>
                          </View>
                          {selected && <Check size={16} color={colors.accent.default} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}

              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.semibold, paddingHorizontal: 2 }}>
                  Reasoning Visibility
                </Text>
                <TouchableOpacity
                  style={[
                    styles.sheetRow,
                    {
                      backgroundColor: showDetailedView ? colors.bg.base : colors.bg.raised,
                      borderRadius: 10,
                    },
                  ]}
                  onPress={() => onToggleDetailedView(!showDetailedView)}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.medium }}>
                      Detailed View
                    </Text>
                    <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.sans.regular, marginTop: 2 }}>
                      {showDetailedView ? "Thinking details visible." : "Thinking details hidden."}
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>

            </ScrollView>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const AnimatedAITab = memo(
  ({
    tab,
    isActiveTab,
    isLast,
    showDivider,
    targetWidth,
    onPress,
    onClose,
    isNew,
    showIcon = true,
    colors,
    radius,
  }: {
    tab: AITab;
    isActiveTab: boolean;
    isLast: boolean;
    showDivider: boolean;
    targetWidth: number;
    onPress: () => void;
    onClose: () => void;
    isNew: boolean;
    showIcon?: boolean;
    colors: any;
    radius: any;
  }) => {
    const { fonts } = useTheme();
    const width = useSharedValue(isNew ? 0 : targetWidth);
    const opacity = useSharedValue(isNew ? 0 : 1);

    useEffect(() => {
      width.value = withSpring(targetWidth, { damping: 20, stiffness: 220, mass: 0.8 });
      opacity.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.cubic) });
    }, [targetWidth, width, opacity]);

    const animatedStyle = useAnimatedStyle(() => ({
      width: width.value,
      opacity: opacity.value,
    }));

    return (
      <Animated.View style={[animatedStyle, { overflow: "hidden", height: "100%" }]}>
        <TouchableOpacity
          onPress={onPress}
          activeOpacity={0.8}
          style={{
            height: "100%",
            paddingLeft: 12,
            paddingRight: 8,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: isActiveTab ? colors.bg.base : "transparent",
            borderRightWidth: isLast ? 0 : 0.5,
            borderRightColor: colors.bg.raised,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 6 }}>
            {showIcon ? (
              <Sparkles
                size={14}
                color={isActiveTab ? colors.fg.default : colors.fg.muted}
                strokeWidth={2}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                fontSize: 13,
                fontFamily: isActiveTab ? fonts.sans.semibold : fonts.sans.regular,
                color: isActiveTab ? colors.fg.default : colors.fg.muted,
                flex: 1,
              }}
            >
              {tab.title}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={13} color={isActiveTab ? colors.fg.default : colors.fg.muted} strokeWidth={2} />
          </TouchableOpacity>
        </TouchableOpacity>
      </Animated.View>
    );
  }
);

// ============================================================================
// Main AI Panel
// ============================================================================

export default function AIPanel({ instanceId, isActive, bottomBarHeight }: PluginPanelProps) {
  const { colors, radius, fonts } = useTheme();
  const { settings } = useAppSettings();
  const headerHeight = usePluginHeaderHeight();
  const { status, sessionState } = useConnection();
  const { register, unregister } = useSessionRegistryActions();
  const drawerStatus = useDrawerStatus();
  const isDrawerOpen = drawerStatus === "open";

  // Session state
  const [sessionTabs, setSessionTabs] = useState<AITab[]>([]);
  const [draftTabs, setDraftTabs] = useState<AITab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<string, AIMessage[]>>({});

  // Config state
  const [agentsByBackend, setAgentsByBackend] = useState<Record<AiBackend, { id: string; name: string; icon?: React.ComponentType<any> }[]>>({
    opencode: DEFAULT_OPENCODE_AGENTS,
    codex: [],
  });
  const [modelOptionsByBackend, setModelOptionsByBackend] = useState<Record<AiBackend, { id: string; name: string }[]>>({
    opencode: [],
    codex: [],
  });
  const [selectedAgentByBackend, setSelectedAgentByBackend] = useState<Record<AiBackend, string>>({
    opencode: "build",
    codex: "",
  });
  const [selectedModelByBackend, setSelectedModelByBackend] = useState<Record<AiBackend, string>>({
    opencode: "",
    codex: "",
  });
  const [selectedVariantByBackend, setSelectedVariantByBackend] = useState<Record<AiBackend, string>>({
    opencode: "",
    codex: "",
  });
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<NonNullable<CodexPromptOptions["reasoningEffort"]>>("medium");
  const [codexSpeed, setCodexSpeed] = useState<NonNullable<CodexPromptOptions["speed"]>>("balanced");
  const [providersByBackend, setProvidersByBackend] = useState<Record<AiBackend, AIProvider[]>>({
    opencode: [],
    codex: [],
  });
  const [configDefaultsByBackend, setConfigDefaultsByBackend] = useState<Record<AiBackend, AIConfigDefaults>>({
    opencode: {},
    codex: {},
  });
  const [sessionConfigs, setSessionConfigs] = useState<Record<string, SessionConfigRecord>>({});

  // UI state
  const [inputText, setInputText] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [pendingImage, setPendingImage] = useState<(AIFileAttachment & { previewUri?: string }) | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<AIPermission | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AIQuestion | null>(null);
  const [activeSheet, setActiveSheet] = useState<ComposerSheet>(null);
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
  const [inputHeight, setInputHeight] = useState(52);
  const [composerHeight, setComposerHeight] = useState(104);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isVoiceBusy, setIsVoiceBusy] = useState(false);
  const voiceBusySpinSV = useSharedValue(0);
  const voiceBusySpinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${voiceBusySpinSV.value}deg` }],
  }));
  useEffect(() => {
    if (isVoiceBusy) {
      voiceBusySpinSV.value = 0;
      voiceBusySpinSV.value = withRepeat(
        withTiming(360, { duration: 900, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      voiceBusySpinSV.value = 0;
    }
  }, [isVoiceBusy, voiceBusySpinSV]);
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const [voiceWave, setVoiceWave] = useState<number[]>(
    () => Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => VOICE_WAVE_IDLE_LEVEL)
  );
  const [needsApiKeyByBackend, setNeedsApiKeyByBackend] = useState<Record<AiBackend, boolean>>({
    opencode: false,
    codex: false,
  });
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitialSessionsLoading, setIsInitialSessionsLoading] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [errorMessages, setErrorMessages] = useState<Record<string, string[]>>({});
  const [showDetailedView, setShowDetailedView] = useState(false);
  const [sessionActivityLabels, setSessionActivityLabels] = useState<Record<string, string>>({});
  const inputHeightSV = useSharedValue(52);
  const voiceLayerOpacitySV = useSharedValue(0);
  const { height: keyboardHeightSV } = useReanimatedKeyboardAnimation();

  // Refs
  const inputRef = useRef<TextInput>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const latestVoiceLevelRef = useRef(VOICE_WAVE_IDLE_LEVEL);
  const voiceWaveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesListRef = useRef<MessagesListHandle | null>(null);
  const isNearBottomRef = useRef(true);
  const autoFollowRef = useRef(true);
  const userDraggingMessagesRef = useRef(false);
  const prevStreamingRef = useRef(false);
  const contentHeightRef = useRef(0);
  const listViewportHeightRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollCorrectionFrameRef = useRef<number | null>(null);
  const refreshSessionMessagesRef = useRef<(sessionId: string, backend: AiBackend, force?: boolean) => Promise<void>>(
    async () => {}
  );
  const codexFinalSyncInFlightRef = useRef<Set<string>>(new Set());
  const sessionCreationPromiseRef = useRef<Promise<AISession> | null>(null);
  const clearScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollCorrectionFrameRef.current != null) {
      cancelAnimationFrame(scrollCorrectionFrameRef.current);
      scrollCorrectionFrameRef.current = null;
    }
  }, []);
  const getBottomScrollOffset = useCallback(() => {
    const viewportHeight = listViewportHeightRef.current;
    return Math.max(0, contentHeightRef.current - viewportHeight);
  }, []);
  const scrollToLatest = useCallback((animated: boolean, correctAfterScroll = false) => {
    clearScheduledScroll();
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const offset = getBottomScrollOffset();
      messagesListRef.current?.scrollToOffset({ offset, animated });
      if (!correctAfterScroll) return;
      // Correct any late list re-measure without kicking off a second animation.
      scrollCorrectionFrameRef.current = requestAnimationFrame(() => {
        scrollCorrectionFrameRef.current = null;
        messagesListRef.current?.scrollToOffset({ offset: getBottomScrollOffset(), animated: false });
      });
    });
  }, [clearScheduledScroll, getBottomScrollOffset]);
  const tabs = useMemo(() => sortTabsByUpdatedAt([...sessionTabs, ...draftTabs]), [sessionTabs, draftTabs]);
  const activeSessionId = useMemo(() => {
    return tabs.find((t) => t.id === activeTabId)?.sessionId || null;
  }, [tabs, activeTabId]);
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeBackend: AiBackend = activeTab?.backend ?? "opencode";
  const agents = agentsByBackend[activeBackend] || [];
  const modelOptions = modelOptionsByBackend[activeBackend] || [];
  const selectedAgent = selectedAgentByBackend[activeBackend] || "";
  const selectedModel = selectedModelByBackend[activeBackend] || "";
  const selectedVariant = selectedVariantByBackend[activeBackend] || "";
  const providers = providersByBackend[activeBackend] || [];
  const configDefaults = configDefaultsByBackend[activeBackend] || {};
  const needsApiKey = needsApiKeyByBackend[activeBackend] || false;
  const isActiveSessionLoading = !!activeSessionId && loadingSessionId === activeSessionId && !messagesMap[activeSessionId];
  const opencodeVariantOptions = useMemo(() => getOpenCodeVariantOptions(selectedModel, configDefaultsByBackend.opencode), [selectedModel, configDefaultsByBackend.opencode]);
  const codexReasoningOptions = useMemo<Array<NonNullable<CodexPromptOptions["reasoningEffort"]>>>(() => {
    const selectedProvider = selectedModel.split(":")[0] || "codex";
    const provider = providersByBackend.codex.find((entry) => entry.id === selectedProvider);
    const model = provider?.models?.[selectedModel.split(":")[1] || ""];
    const options = model?.capabilities?.reasoningEfforts;
    if (Array.isArray(options) && options.length > 0) {
      return options.filter((value): value is NonNullable<CodexPromptOptions["reasoningEffort"]> => (
        value === "low" || value === "medium" || value === "high" || value === "xhigh"
      ));
    }
    return ["low", "medium", "high", "xhigh"];
  }, [providersByBackend.codex, selectedModel]);

  // AI hook with event handling
  const ai = useAI({
    onEvent: useCallback((event: AIEvent) => {
      const props = event.properties || {};

      switch (event.type) {
        case "message.updated": {
          // OpenCode: properties = { info: { sessionID, id, role, time, error, ... } }
          const info = (props.info || props) as Record<string, unknown>;
          const sessId = (info.sessionID as string) || (info.sessionId as string);
          const msgId = info.id as string;
          const role = (info.role as string) === "user" ? "user" : "assistant";
          const timeInfo = info.time as Record<string, unknown> | undefined;
          const created = typeof timeInfo?.created === "number" ? timeInfo.created : undefined;
          const updated = typeof timeInfo?.updated === "number" ? timeInfo.updated : undefined;
          const messageTime = created != null || updated != null
            ? {
                created: created ?? (updated as number),
                updated: updated ?? (created as number),
              }
            : undefined;
          if (sessId && msgId) {
            setMessagesMap((prev) => {
              let existing = prev[sessId] || [];
              // When a real user message arrives, remove the optimistic placeholder
              if (role === "user") {
                existing = existing.filter((m) => !m.id.startsWith("opt-"));
              }
              const idx = existing.findIndex((m) => m.id === msgId);
              if (idx >= 0) {
                // Update metadata but preserve parts (parts come via message.part.updated)
                const updated = [...existing];
                updated[idx] = {
                  ...updated[idx],
                  role: role as "user" | "assistant",
                  time: messageTime ?? updated[idx].time,
                };
                return { ...prev, [sessId]: updated };
              }
              // New message shell — parts will arrive via message.part.updated
              return {
                ...prev,
                [sessId]: [...existing, { id: msgId, role: role as "user" | "assistant", parts: [], time: messageTime }],
              };
            });
          }
          break;
        }
        case "message.part.updated": {
          // OpenCode: properties = { part: { id, sessionID, messageID, type, text, ... }, message?: { sessionID, id, ... } }
          const part = props.part as (AIPart & { id?: string; sessionID?: string; messageID?: string }) | undefined;
          const msgInfo = props.message as Record<string, unknown> | undefined;
          const sessId = (part?.sessionID as string) || (msgInfo?.sessionID as string) || (props.sessionID as string);
          const msgId = (part?.messageID as string) || (msgInfo?.id as string) || (props.messageID as string);
          const partId = part?.id as string | undefined;
          const shouldReplaceStreamingText = event.backend === "codex" && !!partId;
          if (sessId && msgId && part != null) {
            const nextActivityLabel = deriveActivityLabelFromPart(part);
            if (nextActivityLabel) {
              setSessionActivityLabels((prev) => ({ ...prev, [sessId]: nextActivityLabel }));
            }
            setMessagesMap((prev) => {
              const existing = prev[sessId] || [];
              const msgIdx = existing.findIndex((m) => m.id === msgId);
              if (msgIdx >= 0) {
                const updated = [...existing];
                const msg = { ...updated[msgIdx], parts: [...(updated[msgIdx].parts || [])] };
                // Match by part id when available. Some streaming backends send
                // partial updates without stable ids; in that case merge by type
                // so we don't render noisy chunk-by-chunk duplicates.
                const existingPartIdx = partId
                  ? msg.parts.findIndex((p) => (p as any).id === partId)
                  : findStreamingPartIndex(msg.parts, part);
                if (existingPartIdx >= 0) {
                  msg.parts[existingPartIdx] = mergePartUpdate(msg.parts[existingPartIdx], part, {
                    replaceText: shouldReplaceStreamingText,
                  });
                } else {
                  msg.parts.push(part);
                }
                updated[msgIdx] = msg;
                return { ...prev, [sessId]: updated };
              }
              // Message doesn't exist yet — create shell with this part
              const role = (msgInfo?.role as string) === "user" ? "user" : "assistant";
              return {
                ...prev,
                [sessId]: [...existing, { id: msgId, role: role as "user" | "assistant", parts: [part] }],
              };
            });
          }
          break;
        }
        case "session.updated": {
          const info = (props.info || props) as Record<string, unknown>;
          const backend = (event.backend ?? "opencode") as AiBackend;
          const sessId = info.id as string;
          const title = info.title as string;
          const updatedAt = (info.time as Record<string, unknown> | undefined)?.updated as number | undefined;
          if (sessId) {
            setSessionTabs((prev) => {
              const existingIndex = prev.findIndex((t) => t.sessionId === sessId && t.backend === backend);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  title: resolveSessionTitle(backend, sessId, title, updated[existingIndex].title),
                  updatedAt: typeof updatedAt === "number" ? updatedAt : updated[existingIndex].updatedAt,
                };
                updated.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
                return updated;
              }

              return mergeSessionTabs(prev, [{
                id: sessId,
                title: resolveSessionTitle(backend, sessId, title),
                backend,
                time: {
                  created: Date.now(),
                  updated: typeof updatedAt === "number" ? updatedAt : Date.now(),
                },
              }]);
            });
          }
          break;
        }
        case "session.status": {
          // OpenCode: properties = { sessionID, status: { type: "idle" | "busy" | "retry" } }
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const statusObj = props.status as Record<string, unknown> | string | undefined;
          const statusType = typeof statusObj === "object" ? (statusObj?.type as string) : (statusObj as string);
          const normalized = (statusType || "").toLowerCase();
          const streaming = normalized === "busy" || normalized === "running" || normalized === "working";
          setIsStreaming(streaming);
          if (streaming && sessId) setStreamingSessionId(sessId);
          if (!streaming) setStreamingSessionId(null);
          if (sessId && streaming) {
            setSessionActivityLabels((prev) => {
              const current = prev[sessId];
              if (
                current === "Searching codebase..."
                || current === "Waiting for approval..."
                || current === "Waiting for input..."
              ) {
                return prev;
              }
              return {
                ...prev,
                [sessId]: "Thinking...",
              };
            });
          }
          break;
        }
        case "session.idle": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const backend = (event.backend ?? "opencode") as AiBackend;
          setIsStreaming(false);
          if (sessId) {
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Done" }));
            // Codex streams partial deltas; after completion force a canonical
            // re-read so final rendering is clean and fully normalized.
            if (backend === "codex" && !codexFinalSyncInFlightRef.current.has(sessId)) {
              codexFinalSyncInFlightRef.current.add(sessId);
              void refreshSessionMessagesRef.current(sessId, "codex", true).finally(() => {
                codexFinalSyncInFlightRef.current.delete(sessId);
              });
            }
          }
          break;
        }
        case "permission.updated": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Waiting for approval..." }));
          }
          setPendingPermission(props as unknown as AIPermission);
          break;
        }
        case "permission.replied": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Working..." }));
          }
          setPendingPermission(null);
          break;
        }
        case "question.asked": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Waiting for input..." }));
          }
          setPendingQuestion(props as unknown as AIQuestion);
          break;
        }
        case "question.replied":
        case "question.rejected": {
          setPendingQuestion(null);
          break;
        }
        case "session.error":
        case "prompt_error": {
          const rawErr = props.error;
          const errMsg = typeof rawErr === 'string' ? rawErr : (rawErr && typeof rawErr === 'object' ? ((rawErr as any).message || (rawErr as any).name || JSON.stringify(rawErr)) : null) || "An error occurred";
          setIsStreaming(false);
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Error" }));
            setErrorMessages((prev) => ({
              ...prev,
              [sessId]: [...(prev[sessId] || []), errMsg],
            }));
          } else {
            Alert.alert("AI Error", errMsg);
          }
          break;
        }
      }
    }, []),
  });

  // Initialize on connection
  useEffect(() => {
    if (status !== "connected" || isInitialized) return;

    const init = async () => {
      setIsInitialized(true);
      setIsInitialSessionsLoading(true);
      try {
        void Promise.allSettled((["opencode", "codex"] as AiBackend[]).map(async (backend) => {
          try {
            const agentsList = await ai.getAgents(backend);
            if (Array.isArray(agentsList) && agentsList.length > 0) {
              const mapped = (agentsList as AIAgent[])
                .filter((agent) => shouldShowAgentInPicker(agent))
                .map((a) => {
                  const raw = normalizeAgentId(a);
                  let icon = Sparkles;
                  if (raw === "build") icon = Hammer;
                  if (raw === "plan") icon = MapIcon;
                  return {
                    id: raw,
                    name: toDisplayAgentName(a, raw),
                    description: a.description || undefined,
                    icon,
                  };
                });
              const uniqueAgents = new Map<string, any>();
              mapped.forEach(a => { if (!uniqueAgents.has(a.id)) uniqueAgents.set(a.id, a); });
              const deduplicatedMapped = Array.from(uniqueAgents.values());

              const resolvedAgents = backend === "opencode" && deduplicatedMapped.length === 0
                ? DEFAULT_OPENCODE_AGENTS
                : deduplicatedMapped;
              setAgentsByBackend((prev) => ({ ...prev, [backend]: resolvedAgents }));
              setSelectedAgentByBackend((prev) => {
                const current = prev[backend];
                const validCurrent = current && resolvedAgents.some((a) => a.id === current);
                return {
                  ...prev,
                  [backend]: validCurrent ? current : resolvedAgents[0]?.id || "",
                };
              });
            } else if (backend === "codex") {
              setAgentsByBackend((prev) => ({ ...prev, codex: [] }));
              setSelectedAgentByBackend((prev) => ({ ...prev, codex: "" }));
            }
          } catch {
            if (backend === "codex") {
              setAgentsByBackend((prev) => ({ ...prev, codex: [] }));
              setSelectedAgentByBackend((prev) => ({ ...prev, codex: "" }));
            }
          }

          try {
            const cmds = await ai.getCommands(backend);
            if (Array.isArray(cmds) && cmds.length > 0) {
              const mapped = cmds.map((c) => ({
                cmd: c.id.startsWith("/") ? c.id : `/${c.id}`,
                desc: c.description || c.name || c.id,
              }));
              setDynamicCommands((prev) => {
                const existing = new Set(prev.map((p) => p.cmd));
                const merged = [...prev];
                for (const m of mapped) {
                  if (!existing.has(m.cmd)) {
                    merged.push(m);
                    existing.add(m.cmd);
                  }
                }
                return merged;
              });
            }
          } catch {
            // slash commands are non-critical
          }

          try {
            const result = await ai.getProviders(backend);
            const providersList = result.providers;
            const defaults = result.defaults || {};
            const configDefaults = result.configDefaults || {};
            if (Array.isArray(providersList)) {
              setConfigDefaultsByBackend((prev) => ({ ...prev, [backend]: configDefaults }));
              setProvidersByBackend((prev) => ({ ...prev, [backend]: providersList as AIProvider[] }));
              const models: { id: string; name: string }[] = [];
              let hasConfiguredKey = false;
              let defaultModelId = "";
              const configDefaultModelId = toModelOptionId(configDefaults.model);

              for (const p of providersList as AIProvider[]) {
                if ((p as any).key || (p as any).source === "env") {
                  hasConfiguredKey = true;
                }
                if (p.models) {
                  const defaultForProvider = defaults[p.id];
                  for (const [modelId, model] of Object.entries(p.models)) {
                    const optionId = `${p.id}:${modelId}`;
                    models.push({
                      id: optionId,
                      name: (model as any).name || modelId,
                    });
                    if (configDefaultModelId && optionId === configDefaultModelId) {
                      defaultModelId = optionId;
                    }
                    if (defaultForProvider && modelId === defaultForProvider && ((p as any).key || (p as any).source === "env")) {
                      defaultModelId = optionId;
                    }
                  }
                }
              }

              setModelOptionsByBackend((prev) => ({ ...prev, [backend]: models }));
              setSelectedModelByBackend((prev) => ({
                ...prev,
                [backend]: models.length > 0 ? (defaultModelId || models[0].id) : "",
              }));
              if (backend === "opencode") {
                setSelectedAgentByBackend((prev) => ({
                  ...prev,
                  opencode: prev.opencode || configDefaults.agent || "build",
                }));
                setSelectedVariantByBackend((prev) => ({
                  ...prev,
                  opencode: prev.opencode || configDefaults.variant || "",
                }));
              }
              if (backend === "codex") {
                setCodexReasoningEffort((current) => configDefaults.codexReasoningEffort || current);
                setCodexSpeed((current) => configDefaults.codexSpeed || current);
              }
              setNeedsApiKeyByBackend((prev) => ({
                ...prev,
                [backend]: !hasConfiguredKey && models.length === 0,
              }));
            }
          } catch {
            setProvidersByBackend((prev) => ({ ...prev, [backend]: [] }));
            setModelOptionsByBackend((prev) => ({ ...prev, [backend]: [] }));
            setSelectedModelByBackend((prev) => ({ ...prev, [backend]: "" }));
            setNeedsApiKeyByBackend((prev) => ({ ...prev, [backend]: false }));
          }
        }));

        // Fetch existing sessions from all backends
        try {
          const sessions = await ai.listSessions();
          if (Array.isArray(sessions) && sessions.length > 0) {
            const sessionTabs = mergeSessionTabs([], sessions as AISession[]);
            setSessionTabs(sessionTabs);
            const latestTab = sessionTabs[sessionTabs.length - 1];
            setActiveTabId(latestTab.id);

            try {
              setLoadingSessionId(latestTab.sessionId!);
              const msgs = await ai.getMessages(latestTab.sessionId!, latestTab.backend);
              if (Array.isArray(msgs)) {
                setMessagesMap((prev) => ({ ...prev, [latestTab.sessionId!]: msgs as AIMessage[] }));
              }
            } catch {
              // ok
            } finally {
              setLoadingSessionId((prev) => (prev === latestTab.sessionId ? null : prev));
            }
          }
        } catch {
          // No existing sessions
        } finally {
          setIsInitialSessionsLoading(false);
        }
      } catch (err) {
        console.error("AI init error:", err);
        setIsInitialSessionsLoading(false);
      }
    };

    init();
  }, [status, isInitialized, ai]);

  // Reset on disconnect
  useEffect(() => {
    if (status === "disconnected" || sessionState === "ended" || sessionState === "expired") {
      setIsInitialized(false);
      setIsInitialSessionsLoading(false);
      setLoadingSessionId(null);
    }
  }, [status, sessionState]);

  const refreshSessionMessages = useCallback(async (sessionId: string, backend: AiBackend, force = false) => {
    try {
      setLoadingSessionId(sessionId);
      const msgs = await ai.getMessages(sessionId, backend);
      if (!Array.isArray(msgs)) return;
      setMessagesMap((prev) => {
        const next = msgs as AIMessage[];
        if (!force && sameMessagesShape(prev[sessionId], next)) {
          return prev;
        }
        return { ...prev, [sessionId]: next };
      });
    } catch {
      // best effort refresh
    } finally {
      setLoadingSessionId((prev) => (prev === sessionId ? null : prev));
    }
  }, [ai]);

  useEffect(() => {
    if (status !== "connected" || !isInitialized || !isActive || drawerStatus !== "open") return;

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const sessions = await ai.listSessions();
        if (cancelled || !Array.isArray(sessions)) return;
        setSessionTabs((prev) => mergeSessionTabs(prev, sessions as AISession[]));
      } catch {
        // best effort refresh
      }
    };

    void refreshSessions();
    return () => {
      cancelled = true;
    };
  }, [status, isInitialized, isActive, drawerStatus, ai]);

  useEffect(() => {
    if (!isDrawerOpen) return;
    // Keep sidebar as the active keyboard target while drawer is visible.
    inputRef.current?.blur();
  }, [isDrawerOpen]);

  useEffect(() => {
    if (status !== "connected" || !isInitialized || !isActive || activeBackend !== "opencode" || !activeSessionId) return;
    void refreshSessionMessages(activeSessionId, activeBackend, false);
  }, [status, isInitialized, isActive, activeBackend, activeSessionId, refreshSessionMessages]);

  useEffect(() => {
    if (status !== "connected" || !isInitialized || !isActive) return;

    let cancelled = false;
    const refreshOpenCodeActiveSession = async () => {
      if (cancelled || isStreaming || activeBackend !== "opencode" || !activeSessionId) {
        return;
      }
      await refreshSessionMessages(activeSessionId, activeBackend, false);
    };

    const interval = setInterval(refreshOpenCodeActiveSession, 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, isInitialized, isActive, isStreaming, activeBackend, activeSessionId, refreshSessionMessages]);

  useEffect(() => {
    const loadDetailedViewPreference = async () => {
      try {
        const stored = await AsyncStorage.getItem(AI_DETAILED_VIEW_STORAGE_KEY);
        if (stored != null) {
          setShowDetailedView(stored === "true");
        }
      } catch {
        // Keep default value on storage read errors.
      }
    };
    loadDetailedViewPreference();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(AI_DETAILED_VIEW_STORAGE_KEY, showDetailedView ? "true" : "false").catch(() => {
      // Ignore persistence failures.
    });
  }, [showDetailedView]);

  useEffect(() => {
    const loadSessionConfigs = async () => {
      try {
        const raw = await AsyncStorage.getItem(AI_SESSION_CONFIG_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, SessionConfigRecord>;
        if (parsed && typeof parsed === 'object') {
          setSessionConfigs(parsed);
        }
      } catch {
        // ignore malformed persisted session config
      }
    };
    void loadSessionConfigs();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(AI_SESSION_CONFIG_STORAGE_KEY, JSON.stringify(sessionConfigs)).catch(() => {
      // Ignore persistence failures.
    });
  }, [sessionConfigs]);

  useEffect(() => {
    if (!activeSessionId) return;
    const key = sessionConfigKey(activeBackend, activeSessionId);
    const storedConfig = sessionConfigs[key];

    if (activeBackend === 'opencode') {
      const availableAgents = agentsByBackend.opencode;
      const fallbackAgent = configDefaultsByBackend.opencode.agent || availableAgents[0]?.id || 'build';
      const fallbackModel = toModelOptionId(configDefaultsByBackend.opencode.model) || modelOptionsByBackend.opencode[0]?.id || '';
      const fallbackVariant = configDefaultsByBackend.opencode.variant || '';
      const restoredAgent = storedConfig?.agent;
      const validRestoredAgent = restoredAgent && availableAgents.some((a) => a.id === restoredAgent);
      setSelectedAgentByBackend((prev) => ({
        ...prev,
        opencode: validRestoredAgent ? restoredAgent : fallbackAgent,
      }));
      const availableModels = modelOptionsByBackend.opencode;
      const restoredModel = storedConfig?.model;
      const validRestoredModel = restoredModel && (availableModels.length === 0 || availableModels.some((m) => m.id === restoredModel));
      setSelectedModelByBackend((prev) => ({
        ...prev,
        opencode: validRestoredModel ? restoredModel : fallbackModel,
      }));
      setSelectedVariantByBackend((prev) => ({
        ...prev,
        opencode: storedConfig?.variant || fallbackVariant,
      }));
      return;
    }

    const fallbackModel = toModelOptionId(configDefaultsByBackend.codex.model) || modelOptionsByBackend.codex[0]?.id || '';
    setSelectedModelByBackend((prev) => ({
      ...prev,
      codex: storedConfig?.model || fallbackModel,
    }));
    setCodexReasoningEffort(
      storedConfig?.codexReasoningEffort
      || configDefaultsByBackend.codex.codexReasoningEffort
      || 'high'
    );
    setCodexSpeed(
      storedConfig?.codexSpeed
      || configDefaultsByBackend.codex.codexSpeed
      || 'balanced'
    );
  }, [
    activeBackend,
    activeSessionId,
    agentsByBackend.opencode,
    configDefaultsByBackend.codex,
    configDefaultsByBackend.opencode,
    modelOptionsByBackend.codex,
    modelOptionsByBackend.opencode,
    sessionConfigs,
  ]);

  // Scroll to bottom on new messages
  const currentMessages = activeSessionId ? messagesMap[activeSessionId] || [] : [];
  const currentErrors = activeSessionId ? errorMessages[activeSessionId] || [] : [];
const selectedModelNameFull = modelOptions.find((m) => m.id === selectedModel)?.name
    || (activeBackend === "codex" ? "Auto" : "Select model");
  const selectedModelName = selectedModelNameFull.length > 12 ? selectedModelNameFull.slice(0, 12) + "…" : selectedModelNameFull;
  const prefsLabel = activeBackend === "codex"
    ? `${codexReasoningEffort[0].toUpperCase()}${codexReasoningEffort.slice(1)} · ${codexSpeed[0].toUpperCase()}${codexSpeed.slice(1)}`
    : (selectedVariant ? `${selectedVariant.charAt(0).toUpperCase()}${selectedVariant.slice(1)}` : "Default");

  const selectedAgentNameFull = activeBackend === "codex" && agents.length === 0
    ? ""
    : ((agents.find((a) => a.id === selectedAgent)?.name || selectedAgent) as string);
  const combinedConfigLabel = activeBackend === "opencode" && selectedAgentNameFull
    ? [selectedAgentNameFull, selectedModelName].filter(Boolean).join(" · ")
    : selectedModelName;
  const [dynamicCommands, setDynamicCommands] = useState<{ cmd: string; desc: string }[]>([]);
  const defaultSlashCommands = activeBackend === "codex"
    ? [{ cmd: "/abort", desc: "Stop the current task" }]
    : [
        { cmd: "/undo", desc: "Undo last prompt" },
        { cmd: "/redo", desc: "Redo undone prompt" },
        { cmd: "/abort", desc: "Abort current task" },
        { cmd: "/init", desc: "Initialize AGENTS.md" },
        { cmd: "/compact", desc: "Compact session context" },
        { cmd: "/share", desc: "Share session link" },
      ];
  const slashCommands = dynamicCommands.length > 0 ? dynamicCommands : defaultSlashCommands;
  useEffect(() => {
    isNearBottomRef.current = true;
    autoFollowRef.current = isStreaming;
    setShowScrollToBottom(false);
  }, [activeSessionId, isStreaming]);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;

    if (!settings.brainrotAiChatIntegration) {
      prevStreamingRef.current = isStreaming;
      return;
    }

    if (!wasStreaming && isStreaming) {
      innerApi.showBrainrot();
    } else if (wasStreaming && !isStreaming) {
      innerApi.showAIChat();
    }

    prevStreamingRef.current = isStreaming;
  }, [isStreaming, settings.brainrotAiChatIntegration]);

  const inputWrapperAnimatedStyle = useAnimatedStyle(() => ({
    minHeight: inputHeightSV.value,
  }));
  const voiceLayerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: voiceLayerOpacitySV.value,
  }));
  const rootAnimatedStyle = useAnimatedStyle(() => ({
    marginBottom: isDrawerOpen ? 0 : Math.max(0, -keyboardHeightSV.value - bottomBarHeight),
  }));

  const dismissKeyboard = useCallback(() => Keyboard.dismiss(), []);

  const swipeDownGesture = Gesture.Pan()
    .activeOffsetY(10)
    .onEnd((e) => {
      if (e.translationY > 20 && e.velocityY > 0) {
        runOnJS(dismissKeyboard)();
      }
    });

  // Tab management
  const getTabWidth = useCallback(() => 120, []);

  const createNewTab = () => {
    setBackendPickerVisible(true);
  };

  const createNewTabWithBackend = async (backend: "opencode" | "codex") => {
    setBackendPickerVisible(false);
    const draftId = Date.now().toString();
    const fallbackTitle = backend === "codex" ? "New Codex Session" : "New OpenCode Session";
    const draftTab: AITab = {
      id: draftId,
      title: fallbackTitle,
      backend,
      updatedAt: Date.now(),
    };
    setDraftTabs((prev) => [...prev, draftTab]);
    setMessagesMap((prev) => ({ ...prev, [draftId]: [] }));
    setActiveTabId(draftId);
    setInputText("");
  };

  const closeTab = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);

    // Optimistic update — remove immediately
    setSessionTabs((prev) => prev.filter((t) => t.id !== tabId));
    setDraftTabs((prev) => prev.filter((t) => t.id !== tabId));
    if (tab?.sessionId) {
      setMessagesMap((prev) => {
        const next = { ...prev };
        delete next[tab.sessionId!];
        return next;
      });
      setErrorMessages((prev) => {
        const next = { ...prev };
        delete next[tab.sessionId!];
        return next;
      });
    }
    const newTabs = tabs.filter((t) => t.id !== tabId);
    if (activeTabId === tabId && newTabs.length > 0) {
      const index = tabs.findIndex((t) => t.id === tabId);
      const newActiveTab = newTabs[Math.max(0, index - 1)];
      setActiveTabId(newActiveTab.id);
    } else if (newTabs.length === 0) {
      setActiveTabId(null);
    }

    // Fire-and-forget delete — rollback on failure
    if (tab?.sessionId) {
      void (async () => {
        try {
          const deleted = await ai.deleteSession(tab.sessionId!, tab.backend);
          if (!deleted) {
            setSessionTabs((prev) => [...prev, tab]);
            Alert.alert("Unable to Delete", "The session could not be deleted.");
          }
        } catch (err) {
          setSessionTabs((prev) => [...prev, tab]);
          const message = err instanceof Error ? err.message : "The session could not be deleted.";
          Alert.alert("Unable to Delete", message);
        }
      })();
    }
  };

  const handleTabPress = useCallback(async (tabId: string) => {
    setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && !messagesMap[tab.sessionId]) {
      try {
        setLoadingSessionId(tab.sessionId);
        const msgs = await ai.getMessages(tab.sessionId, tab.backend);
        if (Array.isArray(msgs)) {
          setMessagesMap((prev) => ({ ...prev, [tab.sessionId!]: msgs as AIMessage[] }));
        }
      } catch {
        // ok
      } finally {
        setLoadingSessionId((prev) => (prev === tab.sessionId ? null : prev));
      }
    }
  }, [tabs, messagesMap, ai]);

  useEffect(() => {
    refreshSessionMessagesRef.current = refreshSessionMessages;
  }, [refreshSessionMessages]);

  // Get selected model ref
  const getModelRef = useCallback((): ModelRef | undefined => {
    if (!selectedModel || !selectedModel.includes(":")) return undefined;
    const [providerID, modelID] = selectedModel.split(":");
    return activeBackend === 'opencode' && selectedVariant
      ? { providerID, modelID, variant: selectedVariant }
      : { providerID, modelID };
  }, [activeBackend, selectedModel, selectedVariant]);

  const getCodexPromptOptions = useCallback((): CodexPromptOptions | undefined => {
    if (activeBackend !== "codex") return undefined;
    return {
      reasoningEffort: codexReasoningEffort,
      speed: codexSpeed,
    };
  }, [activeBackend, codexReasoningEffort, codexSpeed]);

  // Permission reply
  const handlePermissionReply = async (response: PermissionResponse) => {
    if (!pendingPermission || !activeSessionId) return;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    try {
      await ai.replyPermission(activeSessionId, pendingPermission.id, response, activeTab?.backend ?? "opencode");
    } catch (err) {
      console.error("Permission reply error:", err);
    }
    setPendingPermission(null);
  };

  const handleQuestionReply = async (answers: string[][]) => {
    if (!pendingQuestion || !activeSessionId) return;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    try {
      await ai.replyQuestion(activeSessionId, pendingQuestion.id, answers, activeTab?.backend ?? "opencode");
    } catch (err) {
      console.error("Question reply error:", err);
    }
    setPendingQuestion(null);
  };

  const handleQuestionReject = async () => {
    if (!pendingQuestion || !activeSessionId) return;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    try {
      await ai.rejectQuestion(activeSessionId, pendingQuestion.id, activeTab?.backend ?? "opencode");
    } catch (err) {
      console.error("Question reject error:", err);
    }
    setPendingQuestion(null);
  };

  const updateEqualizer = useCallback((metering?: number) => {
    const normalized = typeof metering === "number"
      ? Math.max(0, Math.min(1, (metering + 40) / 40))
      : VOICE_WAVE_IDLE_LEVEL;
    // Apply noise gate — suppress low-level background noise
    const gated = normalized < 0.25 ? 0 : normalized;
    latestVoiceLevelRef.current = Math.max(
      VOICE_WAVE_IDLE_LEVEL,
      Math.min(1, gated * (0.9 + Math.random() * 0.2))
    );
  }, []);

  const resetEqualizer = useCallback(() => {
    latestVoiceLevelRef.current = VOICE_WAVE_IDLE_LEVEL;
    setVoiceWave(Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => VOICE_WAVE_IDLE_LEVEL));
  }, []);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    const recording = recordingRef.current;
    if (!recording) return null;
    recordingRef.current = null;
    if (voiceWaveIntervalRef.current) {
      clearInterval(voiceWaveIntervalRef.current);
      voiceWaveIntervalRef.current = null;
    }
    try {
      await recording.stopAndUnloadAsync();
    } catch {
      // noop
    }
    recording.setOnRecordingStatusUpdate(null);
    const uri = recording.getURI();
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    } catch {
      // noop
    }
    resetEqualizer();
    setVoiceDurationMs(0);
    return uri;
  }, [resetEqualizer]);

  const handlePickImage = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photos Permission", "Photo library permission is required to upload images.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        base64: false,
        allowsMultipleSelection: false,
        presentationStyle: Platform.OS === "ios" ? ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN : undefined,
        preferredAssetRepresentationMode: Platform.OS === "ios"
          ? ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible
          : undefined,
        shouldDownloadFromNetwork: Platform.OS === "ios",
      });

      if (result.canceled || !result.assets?.[0]) {
        return;
      }

      const asset = result.assets[0];
      const mime = inferImageMime(asset.uri, asset.mimeType);
      const filename = asset.fileName || asset.uri.split("/").pop() || "image";
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });

      setPendingImage({
        type: "file",
        mime,
        filename,
        url: `data:${mime};base64,${base64}`,
        previewUri: asset.uri,
      } as AIFileAttachment & { previewUri?: string });
    } catch (err) {
      console.error("Image pick error:", err);
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === "android") {
      void ImagePicker.getPendingResultAsync().then(async (result) => {
        if (result && "canceled" in result && !result.canceled && result.assets?.[0]) {
          try {
            const asset = result.assets[0];
            const mime = inferImageMime(asset.uri, asset.mimeType);
            const filename = asset.fileName || asset.uri.split("/").pop() || "image";
            const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
            setPendingImage({
              type: "file",
              mime,
              filename,
              url: `data:${mime};base64,${base64}`,
              previewUri: asset.uri,
            } as AIFileAttachment & { previewUri?: string });
          } catch (error) {
            console.error("Pending image recovery error:", error);
          }
        }
      });
    }
  }, []);

  // Send message / handle slash commands
  const sendMessage = async (rawText?: string) => {
    const text = (rawText ?? inputText).trim();
    if (!text && !pendingImage) return;

    if (rawText == null) {
      setInputText("");
      animateInputHeight(52);
      Keyboard.dismiss();
    }

    // Get or create session
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const activeBackend: "opencode" | "codex" = activeTab?.backend ?? "opencode";
    const selectedAgentForBackend = activeBackend === "opencode" ? selectedAgent : undefined;
    let sessId = activeSessionId;

    if (!sessId) {
      if (sessionCreationPromiseRef.current) {
        try {
          const session = await sessionCreationPromiseRef.current;
          sessId = session.id;
        } catch {
          Alert.alert("Error", "Previous session creation failed.");
          return;
        }
      } else {
        const createPromise = (async () => {
          const firstMessageText = text ? text : "Image upload";
          const title = firstMessageText.length > 30 ? firstMessageText.slice(0, 30) + "..." : firstMessageText;
          const session = await ai.createSession(title, activeBackend);
          
          setDraftTabs((prev) => prev.filter((t) => t.id !== activeTabId));
          setMessagesMap((prev) => {
            const next = { ...prev };
            if (activeTabId) delete next[activeTabId];
            return { ...next, [session.id]: [] };
          });
          setSessionTabs((prev) => mergeSessionTabs(prev, [{ ...session, backend: activeBackend } as AISession]));
          setActiveTabId(session.id);
          return session;
        })();
        
        sessionCreationPromiseRef.current = createPromise;
        try {
          const session = await createPromise;
          sessId = session.id;
        } catch (err) {
          Alert.alert("Error", "Failed to create AI session");
          return;
        } finally {
          sessionCreationPromiseRef.current = null;
        }
      }
    }

    // Handle slash commands
    if (text.startsWith("/") && !pendingImage) {
      const cmd = text.slice(1).split(" ")[0].toLowerCase();
      try {
        switch (cmd) {
          case "undo": {
            if (activeBackend === "codex") {
              throw new Error("Codex undo is not supported in Lunel yet");
            }
            const msgs = messagesMap[sessId] || [];
            const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
            if (lastUserMsg) await ai.revert(sessId, lastUserMsg.id, activeBackend);
            break;
          }
          case "redo":
            if (activeBackend === "codex") {
              throw new Error("Codex redo is not supported in Lunel yet");
            }
            await ai.unrevert(sessId, activeBackend);
            break;
          case "abort":
            await ai.abort(sessId, activeBackend);
            setIsStreaming(false);
            break;
          case "init":
            if (activeBackend === "codex") {
              throw new Error("Codex init is not supported in Lunel yet");
            }
            await ai.runCommand(sessId, "init", activeBackend);
            break;
          default:
            await ai.sendPrompt(
              sessId,
              text,
              getModelRef(),
              selectedAgentForBackend,
              activeBackend,
              undefined,
              getCodexPromptOptions(),
            );
            setSessionConfigs((prev) => ({
              ...prev,
              [sessionConfigKey(activeBackend, sessId)]: {
                ...(prev[sessionConfigKey(activeBackend, sessId)] || {}),
                agent: selectedAgentForBackend,
                model: selectedModel,
                variant: activeBackend === 'opencode' ? selectedVariant : undefined,
                codexReasoningEffort,
                codexSpeed,
              },
            }));
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Thinking..." }));
            setIsStreaming(true);
            setStreamingSessionId(sessId);
        }
      } catch (err) {
        Alert.alert("Error", (err as Error).message);
      }
      return;
    }

    // Regular prompt
    try {
      const optimisticMessageId = `opt-${Date.now()}`;
      const optimisticCreatedAt = Date.now();
      const optimisticParts: AIPart[] = [];
      if (pendingImage) {
        optimisticParts.push({
          type: "file",
          mime: pendingImage.mime,
          filename: pendingImage.filename,
          url: pendingImage.url,
        });
      }
      if (text) {
        optimisticParts.push({ type: "text", text } as AIPart);
      }
      const optimisticMsg: AIMessage = {
        id: optimisticMessageId,
        role: "user",
        parts: optimisticParts,
        metadata: {
          localStatus: "sending",
          clientCreatedAt: optimisticCreatedAt,
        },
        time: {
          created: optimisticCreatedAt,
          updated: optimisticCreatedAt,
        },
      };
      autoFollowRef.current = true;
      isNearBottomRef.current = true;
      setShowScrollToBottom(false);
      setMessagesMap((prev) => ({
        ...prev,
        [sessId!]: [...(prev[sessId!] || []), optimisticMsg],
      }));
      scrollToLatest(true, true);

      await ai.sendPrompt(
        sessId,
        text,
        getModelRef(),
        selectedAgentForBackend,
        activeBackend,
        pendingImage ? [{ type: "file", mime: pendingImage.mime, filename: pendingImage.filename, url: pendingImage.url }] : undefined,
        getCodexPromptOptions(),
      );
      setSessionConfigs((prev) => ({
        ...prev,
        [sessionConfigKey(activeBackend, sessId!)]: {
          ...(prev[sessionConfigKey(activeBackend, sessId!)] || {}),
          agent: selectedAgentForBackend,
          model: selectedModel,
          variant: activeBackend === 'opencode' ? selectedVariant : undefined,
          codexReasoningEffort,
          codexSpeed,
        },
      }));
      setMessagesMap((prev) => {
        const sessionMessages = prev[sessId!] || [];
        const idx = sessionMessages.findIndex((m) => m.id === optimisticMessageId);
        if (idx < 0) return prev;
        const updated = [...sessionMessages];
        const existing = updated[idx];
        const committedAt = existing.time?.created ?? existing.time?.updated ?? optimisticCreatedAt;
        updated[idx] = {
          ...existing,
          metadata: {
            ...(existing.metadata || {}),
            localStatus: "sent",
            clientCreatedAt: committedAt,
          },
          time: existing.time ?? { created: committedAt, updated: committedAt },
        };
        return { ...prev, [sessId!]: updated };
      });
      setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Thinking..." }));
      setIsStreaming(true);
      setStreamingSessionId(sessId);
      setPendingImage(null);
    } catch (err) {
      if (sessId) {
        setMessagesMap((prev) => ({
          ...prev,
          [sessId!]: (prev[sessId!] || []).filter((msg) => !msg.id.startsWith("opt-")),
        }));
      }
      Alert.alert("Error", (err as Error).message);
    }
  };

  const animateInputHeight = useCallback((nextHeight: number) => {
    if (Math.abs(nextHeight - inputHeight) <= 1) return;
    setInputHeight(nextHeight);
    inputHeightSV.value = withTiming(nextHeight, {
      easing: Easing.out(Easing.cubic),
    });
  }, [inputHeight, inputHeightSV]);

  const handleInputChange = useCallback((text: string) => {
    setInputText(text);
    // Keep composer height stable when input is fully cleared.
    if (text.length === 0) {
      animateInputHeight(52);
    }
  }, [animateInputHeight]);

  const enterVoiceMode = useCallback(async () => {
    if (isVoiceBusy) return;
    if (voiceWaveIntervalRef.current) {
      clearInterval(voiceWaveIntervalRef.current);
      voiceWaveIntervalRef.current = null;
    }
    resetEqualizer();
    setInputText("");
    animateInputHeight(52);
    setActiveSheet(null);
    Keyboard.dismiss();
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Microphone Permission", "Microphone permission is required for voice input. Voice is sent to our servers for transcription only — we don't store or log it.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const recording = new Audio.Recording();
      recording.setProgressUpdateInterval(100);
      recording.setOnRecordingStatusUpdate((status) => {
        if (!status.isRecording) {
          latestVoiceLevelRef.current = VOICE_WAVE_IDLE_LEVEL;
          return;
        }
        setVoiceDurationMs(status.durationMillis ?? 0);
        updateEqualizer(typeof status.metering === "number" ? status.metering : undefined);
      });
      await recording.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      } as Audio.RecordingOptions);
      await recording.startAsync();
      recordingRef.current = recording;
      setVoiceDurationMs(0);
      setIsVoiceMode(true);
    } catch (err) {
      console.error("Voice recording start error:", err);
      Alert.alert("Voice Input", "Failed to start recording.");
      resetEqualizer();
    }
  }, [animateInputHeight, isVoiceBusy, resetEqualizer, updateEqualizer]);

  const cancelVoiceMode = useCallback(async () => {
    setIsVoiceMode(false);
    await stopRecording();
  }, [stopRecording]);

  const sendVoiceMode = useCallback(async () => {
    if (isVoiceBusy) return;
    setIsVoiceBusy(true);
    try {
      const uri = await stopRecording();
      if (!uri) {
        Alert.alert("Voice Input", "No audio recording found.");
        return;
      }
      const audioBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const res = await fetch(TRANSCRIBE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: audioBase64 }),
      });
      if (!res.ok) {
        throw new Error(`Transcription failed (${res.status})`);
      }
      const data = (await res.json()) as { text?: string };
      const transcribed = (data.text || "").trim();
      if (!transcribed) {
        Alert.alert("Voice Input", "No speech detected.");
        return;
      }
      setInputText(transcribed);
    } catch (err) {
      console.error("Voice transcription error:", err);
      Alert.alert("Voice Input", (err as Error).message || "Failed to transcribe audio.");
    } finally {
      setIsVoiceMode(false);
      setIsVoiceBusy(false);
    }
  }, [isVoiceBusy, setInputText, stopRecording]);

  useEffect(() => {
    if (isVoiceMode) {
      resetEqualizer();
      if (voiceWaveIntervalRef.current) {
        clearInterval(voiceWaveIntervalRef.current);
      }
      voiceWaveIntervalRef.current = setInterval(() => {
        const next = latestVoiceLevelRef.current;
        setVoiceWave((prev) => {
          const shifted = prev.slice(1);
          shifted.push(next);
          return shifted;
        });
      }, 100);
    } else if (voiceWaveIntervalRef.current) {
      clearInterval(voiceWaveIntervalRef.current);
      voiceWaveIntervalRef.current = null;
    }
  }, [isVoiceMode, resetEqualizer]);

  useEffect(() => {
    voiceLayerOpacitySV.value = withTiming(isVoiceMode ? 1 : 0, {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
  }, [isVoiceMode, voiceLayerOpacitySV]);

  useEffect(() => {
    return () => {
      clearScheduledScroll();
      if (voiceWaveIntervalRef.current) {
        clearInterval(voiceWaveIntervalRef.current);
        voiceWaveIntervalRef.current = null;
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, [clearScheduledScroll]);

  // Stop streaming
  const handleStop = async () => {
    if (activeSessionId) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      try {
        await ai.abort(activeSessionId, activeTab?.backend ?? "opencode");
      } catch {}
      setIsStreaming(false);
    }
  };

  // API key handler
  const handleSetApiKey = async (providerId: string, key: string) => {
    try {
      await ai.setAuth(providerId, key, activeBackend);
      setNeedsApiKeyByBackend((prev) => ({ ...prev, [activeBackend]: false }));
      setIsInitialized(false);
    } catch (err) {
      Alert.alert("Error", (err as Error).message);
    }
  };

  // Build flat list data: messages + errors
  const activeSessionActivityLabel = activeSessionId
    ? (sessionActivityLabels[activeSessionId] || "Thinking...")
    : "Thinking...";

  const listData = useMemo(() => {
    const items: Array<
      | { type: "message"; data: AIMessage }
      | { type: "error"; data: string; id: string }
      | { type: "thinking"; id: string; label: string }
    > = [];
    for (const msg of currentMessages) {
      items.push({ type: "message", data: msg });
    }
    const shouldShowThinking = isStreaming && streamingSessionId === activeSessionId;
    if (shouldShowThinking) {
      items.push({ type: "thinking", id: "thinking-indicator", label: activeSessionActivityLabel });
    }
    for (let i = 0; i < currentErrors.length; i++) {
      items.push({ type: "error", data: currentErrors[i], id: `err-${i}` });
    }
    return items;
  }, [currentMessages, currentErrors, isStreaming, streamingSessionId, activeSessionId, activeSessionActivityLabel]);

  // Tab renderer
  const renderAITab = useCallback(
    (
      tab: AITab,
      isActiveTab: boolean,
      isLast: boolean,
      showDivider: boolean,
      targetWidth: number,
      onPress: () => void,
      onClose: () => void,
      isNew: boolean
    ) => (
      <AnimatedAITab
        tab={tab}
        isActiveTab={isActiveTab}
        isLast={isLast}
        showDivider={showDivider}
        targetWidth={targetWidth}
        onPress={onPress}
        onClose={onClose}
        isNew={isNew}
        showIcon={false}
        colors={colors}
        radius={radius}
      />
    ),
    [colors, radius]
  );

  // Render list item
  const renderListItem = useCallback(({ item }: { item: any }) => {
    if (item.type === "error") {
      return <ErrorMessageView text={item.data} />;
    }
    if (item.type === "thinking") {
      return <ThinkingIndicatorView label={item.label} />;
    }
    return (
      <MessageBubble
        message={item.data}
        colors={colors}
        fonts={fonts}
        radius={radius}
        showDetailedView={showDetailedView}
        pendingPermission={pendingPermission}
        onPermissionReply={handlePermissionReply}
      />
    );
  }, [colors, fonts, radius, showDetailedView, pendingPermission, handlePermissionReply]);

  const handleDetailedViewAction = useCallback((value?: boolean) => {
    setShowDetailedView((prev) => (typeof value === "boolean" ? value : !prev));
  }, []);

  const handleDeleteActiveSession = useCallback(() => {
    if (!activeTab) return;
    Alert.alert(
      "Delete session?",
      `Delete "${activeTab.title}" permanently?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => { void closeTab(activeTab.id); } },
      ],
    );
  }, [activeTab, closeTab]);

  const hasContent = listData.length > 0;
  const messagesBottomInset = 16;

  useEffect(() => {
    if (!hasContent) return;
    if (!isNearBottomRef.current) return;
    scrollToLatest(false);
  }, [messagesBottomInset, hasContent, scrollToLatest]);

  useEffect(() => {
    // Include backend on each session item so DrawerContent can group them
    const sessionItems = tabs.map((t) => ({ id: t.id, title: t.title, backend: t.backend }));
    register('ai', {
      sessions: sessionItems,
      activeSessionId: activeTabId,
      loading: status === 'connected' && (!isInitialized || isInitialSessionsLoading),
      onSessionPress: handleTabPress,
      onSessionClose: closeTab,
      onCreateSession: createNewTab,
    });
  }, [tabs, activeTabId, status, isInitialized, isInitialSessionsLoading, register, handleTabPress, closeTab, createNewTab]);

  useEffect(() => () => unregister('ai'), [unregister]);

  return (
    <Animated.View
      style={[
        {
          flex: 1,
          backgroundColor: colors.bg.base,
        },
        rootAnimatedStyle,
      ]}
    >
      {/* Permission Sheet */}
      {pendingPermission && (
        <PermissionSheet
          visible={!!pendingPermission}
          permission={pendingPermission}
          colors={colors}
          radius={radius}
          fonts={fonts}
          onReply={handlePermissionReply}
        />
      )}

      {pendingQuestion && (
        <QuestionDialog
          questionRequest={pendingQuestion}
          colors={colors}
          radius={radius}
          fonts={fonts}
          onSubmit={handleQuestionReply}
          onReject={handleQuestionReject}
        />
      )}

      {/* Backend Picker */}
      <BackendPickerDialog
        visible={backendPickerVisible}
        onPick={createNewTabWithBackend}
        onClose={() => setBackendPickerVisible(false)}
        colors={colors}
        radius={radius}
        fonts={fonts}
      />

      {/* Header */}
      <PluginHeader
        title={activeTab ? formatBackendSessionTitle(activeTab.backend, activeTab.title) : "AI"}
        colors={colors}
        showBottomBorder={tabs.length > 0}
        rightAccessory={(
          <View style={styles.headerMenuWrapper}>
            <MenuView
              shouldOpenOnLongPress={false}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "toggle-detailed-view") {
                  handleDetailedViewAction();
                  return;
                }
                if (nativeEvent.event === "delete-session") {
                  handleDeleteActiveSession();
                }
              }}
              actions={[
                {
                  id: "toggle-detailed-view",
                  title: "Toggle detailed view",
                  state: showDetailedView ? "on" : "off",
                },
                ...(activeTab ? [{
                  id: "delete-session",
                  title: "Delete session",
                  attributes: {
                    destructive: true,
                  } as const,
                }] : []),
              ]}
            >
              <TouchableOpacity style={styles.headerMenuButton} activeOpacity={0.7}>
                <EllipsisVertical size={22} color={colors.fg.muted} strokeWidth={2} />
              </TouchableOpacity>
            </MenuView>
          </View>
        )}
      />

      {/* Content */}
      <View style={{ flex: 1, position: "relative" }}>
        {/* API Key Setup */}
        {needsApiKey && providers.length > 0 ? (
          <ApiKeySetup
            providers={providers}
            colors={colors}
            radius={radius}
            fonts={fonts}
            onSetKey={handleSetApiKey}
          />
        ) : status === "connected" && !isInitialized ? (
          <Loading color={colors.fg.muted} />
        ) : isInitialSessionsLoading && tabs.length === 0 ? (
          <Loading color={colors.fg.muted} />
        ) : tabs.length === 0 ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 20,
              paddingTop: headerHeight,
            }}
          >
            <View style={{ alignItems: "center", gap: 8 }}>
              <Sparkle size={48} color={colors.fg.muted} strokeWidth={1.5} />
              <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                No AI sessions open
              </Text>
            </View>
            <TouchableOpacity
              onPress={createNewTab}
              style={{
                alignItems: "center",
                backgroundColor: colors.bg.raised,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 10,
              }}
            >
              <Text
                style={{
                  color: colors.fg.default,
                  fontSize: 14,
                  fontFamily: fonts.sans.medium,
                }}
              >
                New Session
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            {/* Messages or Welcome Screen */}
            <View style={{ flex: 1 }}>
            {isActiveSessionLoading ? (
              <AISkeleton colors={colors} paddingTop={headerHeight} />
            ) : hasContent ? (
              <FlashList<(typeof listData)[number]>
                ref={(instance) => {
                  messagesListRef.current = instance;
                }}
                data={listData}
                keyExtractor={(item: (typeof listData)[number]) => item.type === "message" ? item.data.id : item.id}
                renderItem={renderListItem}
                style={{ flex: 1 }}
                indicatorStyle="default"
                onLayout={(e) => {
                  listViewportHeightRef.current = e.nativeEvent.layout.height;
                }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingTop: headerHeight + 18,
                  paddingBottom: messagesBottomInset,
                }}
                onContentSizeChange={(_, contentHeight) => {
                  contentHeightRef.current = contentHeight;
                  const grew = contentHeight > lastContentHeightRef.current;
                  if (grew && isStreaming && isNearBottomRef.current) {
                    scrollToLatest(false);
                  }
                  lastContentHeightRef.current = contentHeight;
                }}
                onScrollBeginDrag={() => {
                  userDraggingMessagesRef.current = true;
                }}
                onScrollEndDrag={() => {
                  userDraggingMessagesRef.current = false;
                }}
                onMomentumScrollEnd={() => {
                  userDraggingMessagesRef.current = false;
                }}
                onScroll={(e) => {
                  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                  const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
                  const nearBottom = distanceFromBottom <= 24;
                  if (!nearBottom && isStreaming && userDraggingMessagesRef.current) {
                    autoFollowRef.current = false;
                  }
                  if (nearBottom) {
                    autoFollowRef.current = true;
                  }
                  isNearBottomRef.current = nearBottom;
                  setShowScrollToBottom(!nearBottom);
                }}
                scrollEventThrottle={100}
                keyboardDismissMode="on-drag"
                ListFooterComponent={null}
              />
            ) : (
              <Pressable style={{ flex: 1, paddingTop: headerHeight }} onPress={() => { inputRef.current?.blur(); Keyboard.dismiss(); }}>
                <View style={styles.logoContainer}>
                  <View style={[styles.logoWrapper, { marginBottom: activeBackend === "codex" ? 8 : 0 }]}>
                    {activeBackend === "codex"
                      ? <Codex size={64} color={colors.fg.default} />
                      : <OpenCode size={68} color={colors.fg.default} />}
                  </View>
                  <Text style={{ color: colors.fg.muted, fontSize: 17, fontFamily: "PublicSans_500Medium", textAlign: "center", marginTop: 14, paddingHorizontal: 24 }}>
                    What's the plan today? I'm in.
                  </Text>
                </View>
              </Pressable>
            )}
            </View>


            {inputText.startsWith("/") && !pendingImage ? (
              <Animated.View
                entering={ZoomIn.duration(150)}
                style={{
                  position: "absolute",
                  bottom: composerHeight + 12,
                  left: 10,
                  right: 10,
                  backgroundColor: colors.bg.raised,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: colors.border.secondary,
                  paddingVertical: 6,
                  paddingHorizontal: 6,
                  zIndex: 10,
                  maxHeight: 260,
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.12,
                  shadowRadius: 12,
                  elevation: 8,
                }}
              >
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {slashCommands.filter(c => c.cmd.startsWith(inputText.toLowerCase())).map((c, i) => (
                  <TouchableOpacity
                    key={c.cmd}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: i === 0 ? colors.bg.base : "transparent",
                      borderRadius: 10,
                      gap: 10,
                    }}
                    onPress={() => {
                      setInputText(c.cmd + " ");
                      inputRef.current?.focus();
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={{ color: colors.accent.default, fontFamily: fonts.mono.regular, fontSize: 13, minWidth: 64 }}>
                      {c.cmd}
                    </Text>
                    <Text numberOfLines={1} style={{ color: colors.fg.muted, fontFamily: fonts.sans.regular, fontSize: 12, flex: 1 }}>
                      {c.desc}
                    </Text>
                  </TouchableOpacity>
                ))}
                </ScrollView>
              </Animated.View>
            ) : null}

            {/* Composer */}
            <LinearGradient
              colors={[colors.bg.base + "1a", colors.bg.base + "ff"]}
              style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: composerHeight + 24 }}
              pointerEvents="none"
            />
            <GestureDetector gesture={swipeDownGesture}>
            <Animated.View
              pointerEvents={isVoiceMode ? "none" : "auto"}
              style={[
                styles.inputContainer,
                inputWrapperAnimatedStyle,
                {
                  backgroundColor: colors.bg.raised,
                  borderColor: colors.border.main,
                  borderRadius: 12,
                  borderCurve: 'continuous',
                  opacity: isVoiceMode ? 0 : 1,
                },
              ]}
              onLayout={(e) => {
                const { height } = e.nativeEvent.layout;
                setComposerHeight(height);
              }}
            >
              <TextInput
                ref={inputRef}
                style={[
                  styles.input,
                  {
                    color: colors.fg.default,
                    fontFamily: fonts.sans.regular,
                  },
                ]}
                placeholder="Ask anything..."
                placeholderTextColor={colors.fg.subtle}
                value={inputText}
                editable={!isVoiceMode}
                pointerEvents={isVoiceMode ? "none" : "auto"}
                onChangeText={handleInputChange}
                multiline
                scrollEnabled={inputHeight >= 160}
                onContentSizeChange={(e) => animateInputHeight(e.nativeEvent.contentSize.height)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onSubmitEditing={() => {
                  sendMessage().catch((err) => {
                    console.error("Send message error:", err);
                  });
                }}
                blurOnSubmit={false}
              />

              {pendingImage ? (
                <Animated.View
                  entering={ZoomIn.duration(200)}
                  style={{
                    marginTop: 10,
                    marginBottom: 2,
                    alignSelf: "flex-start",
                    borderRadius: 12,
                    overflow: "hidden",
                    borderWidth: 1,
                    borderColor: colors.border.secondary,
                  }}
                >
                  <View style={{ position: "relative" }}>
                    <Image
                      source={{ uri: pendingImage.previewUri || pendingImage.url }}
                      style={{ width: 80, height: 80, borderRadius: 11, backgroundColor: colors.bg.base }}
                      resizeMode="cover"
                    />
                    <TouchableOpacity
                      onPress={() => setPendingImage(null)}
                      activeOpacity={0.7}
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: colors.bg.base,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <X size={14} color={colors.fg.default} strokeWidth={2.2} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        sendMessage().catch((err) => {
                          console.error("Send image error:", err);
                        });
                      }}
                      activeOpacity={0.7}
                      style={{
                        position: "absolute",
                        right: 6,
                        bottom: 6,
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: colors.accent.default,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Check size={14} color={'#ffffff'} strokeWidth={2.4} />
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              ) : null}

              <View style={styles.composerBottomBar}>
                <View pointerEvents={isVoiceMode ? "none" : "auto"} style={styles.composerRow}>
                  <TouchableOpacity
                    style={[styles.actionButton, { borderRadius: 9999 }]}
                    onPress={handlePickImage}
                    activeOpacity={0.7}
                    disabled={isVoiceBusy}
                  >
                    <Plus size={18} color={colors.fg.default} strokeWidth={1.7} />
                  </TouchableOpacity>

                  <View style={{ flex: 1 }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ flexGrow: 0 }}>
                      <TouchableOpacity
                        style={[styles.modelButton, { borderColor: colors.border.secondary, maxWidth: 260 }]}
                        onPress={() => setActiveSheet("configure")}
                        activeOpacity={0.7}
                        disabled={activeBackend !== "codex" && agents.length === 0 && modelOptions.length === 0}
                      >
                        <Text
                          numberOfLines={1}
                          style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                        >
                          {combinedConfigLabel}
                        </Text>
                        <ChevronDown size={13} color={colors.fg.subtle} />
                      </TouchableOpacity>

                      {activeBackend === "codex" || activeBackend === "opencode" ? (
                        <TouchableOpacity
                          style={[styles.modelButton, { borderColor: colors.border.secondary, maxWidth: 220 }]}
                          onPress={() => setActiveSheet("backend-preferences")}
                          activeOpacity={0.7}
                        >
                          <Text
                            numberOfLines={1}
                            style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                          >
                            {prefsLabel}
                          </Text>
                          <ChevronDown size={13} color={colors.fg.subtle} />
                        </TouchableOpacity>
                      ) : null}
                    </ScrollView>
                  </View>

                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={enterVoiceMode}
                    disabled={isVoiceBusy}
                    activeOpacity={0.7}
                  >
                    <Mic size={18} color={colors.fg.default} strokeWidth={1.5} />
                  </TouchableOpacity>

                  <View style={{ width: 2 }} />

                  {isStreaming ? (
                    <TouchableOpacity
                      style={[styles.sendButton, { backgroundColor: "transparent", borderColor: colors.border.main }]}
                      onPress={handleStop}
                      activeOpacity={0.7}
                    >
                      <Square size={18} color={'#ef4444'} strokeWidth={2.5} fill={'#ef4444'} />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.sendButton, {
                        backgroundColor: (inputText.trim() || pendingImage) ? colors.accent.default : "transparent",
                        borderColor: colors.border.main,
                      }]}
                      onPress={() => {
                        sendMessage().catch((err) => {
                          console.error("Send message error:", err);
                        });
                      }}
                      disabled={!inputText.trim() && !pendingImage}
                      activeOpacity={0.7}
                    >
                      <SendIcon size={18} color={(inputText.trim() || pendingImage) ? '#ffffff' : colors.fg.subtle} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

            </Animated.View>
            </GestureDetector>

            {showScrollToBottom && hasContent ? (
              <Animated.View
                entering={ZoomIn.duration(180)}
                exiting={ZoomOut.duration(140)}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: isVoiceMode ? 68 : composerHeight + 18,
                  alignItems: "center",
                  zIndex: 100,
                }}
              >
                <Pressable
                  onPress={() => {
                    isNearBottomRef.current = true;
                    setShowScrollToBottom(false);
                    messagesListRef.current?.scrollToEnd({ animated: true });
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  pointerEvents="box-only"
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                    borderRadius: 8,
                    backgroundColor: colors.bg.raised,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.border.secondary,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <ArrowDownIcon size={16} color={colors.fg.muted} />
                  <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular }}>To the bottom</Text>
                </Pressable>
              </Animated.View>
            ) : null}

            {/* Voice Capsule */}
            {isVoiceMode && (
              <View
                style={{
                  backgroundColor: colors.bg.raised,
                  borderRadius: 10,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.fg.disabled,
                  paddingHorizontal: 6,
                  paddingVertical: 4,
                  marginHorizontal: 8,
                  marginBottom: 8,
                  flexDirection: "row",
                  alignItems: "center",
                  minHeight: 44,
                }}
              >
                {/* Cancel */}
                <TouchableOpacity
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.bg.base,
                  }}
                  onPress={cancelVoiceMode}
                  disabled={isVoiceBusy}
                  activeOpacity={0.7}
                >
                  <X size={16} color={colors.fg.default} />
                </TouchableOpacity>

                {/* Waveform */}
                <View
                  style={{
                    flex: 1,
                    height: 32,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingHorizontal: 6,
                    gap: 2,
                  }}
                >
                  {voiceWave.map((level, idx) => {
                    const activeLevel = Math.max(0, (level - VOICE_WAVE_IDLE_LEVEL) / (1 - VOICE_WAVE_IDLE_LEVEL));
                    const barHeight = VOICE_WAVE_DOT_SIZE + activeLevel * VOICE_WAVE_MAX_EXTRA_HEIGHT;
                    return (
                      <View
                        key={`voice-wave-${idx}`}
                        style={{
                          width: VOICE_WAVE_DOT_SIZE,
                          height: barHeight,
                          borderRadius: 9999,
                          backgroundColor: colors.fg.default,
                        }}
                      />
                    );
                  })}
                </View>

                {/* Timer */}
                <Text style={{ color: colors.fg.muted, fontFamily: fonts.mono.medium, fontSize: 13, marginRight: 10, marginLeft: 2 }}>
                  {formatVoiceDuration(voiceDurationMs)}
                </Text>

                {/* Send */}
                <TouchableOpacity
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.accent.default,
                    borderWidth: 0.5,
                    borderColor: colors.border.secondary,
                  }}
                  onPress={sendVoiceMode}
                  disabled={isVoiceBusy}
                  activeOpacity={0.7}
                >
                  {isVoiceBusy ? (
                    <Animated.View style={voiceBusySpinStyle}>
                      <LoaderCircle size={18} color={'#ffffff'} strokeWidth={2} />
                    </Animated.View>
                  ) : (
                    <Check size={18} color={'#ffffff'} strokeWidth={2.5} />
                  )}
                </TouchableOpacity>
              </View>
            )}

            <ConfigureSheet
              visible={activeSheet === "configure"}
              backend={activeBackend}
              modeOptions={agents.filter((a) => shouldShowAgentInPicker(a as unknown as AIAgent)).map((a) => ({ id: a.id, name: a.name, description: (a as any).description, icon: a.icon }))}
              selectedModeId={selectedAgent}
              onSelectMode={(id) => {
                setSelectedAgentByBackend((prev) => ({ ...prev, [activeBackend]: id }));
              }}
              modelOptions={modelOptions}
              selectedModelId={selectedModel}
              onSelectModel={(id) => {
                setSelectedModelByBackend((prev) => ({ ...prev, [activeBackend]: id }));
              }}
              showDetailedView={showDetailedView}
              onToggleDetailedView={handleDetailedViewAction}
              onClose={() => setActiveSheet(null)}
              colors={colors}
              radius={radius}
              fonts={fonts}
            />

            <BackendPreferencesSheet
              visible={activeSheet === "backend-preferences"}
              backend={activeBackend}
              selectedReasoningEffort={codexReasoningEffort}
              selectedSpeed={codexSpeed}
              availableReasoningOptions={codexReasoningOptions}
              onSelectReasoningEffort={(value) => setCodexReasoningEffort(value)}
              onSelectSpeed={(value) => setCodexSpeed(value)}
              opencodeVariantOptions={opencodeVariantOptions}
              selectedVariant={selectedVariant}
              onSelectVariant={(id) => setSelectedVariantByBackend((prev) => ({ ...prev, [activeBackend]: id }))}
              showDetailedView={showDetailedView}
              onToggleDetailedView={handleDetailedViewAction}
              onClose={() => setActiveSheet(null)}
              colors={colors}
              radius={radius}
              fonts={fonts}
            />
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Backend picker dialog
  backendDialogOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  backendDialogCard: {
    width: "100%",
    maxWidth: 340,
    padding: 20,
  },
  backendDialogTitle: {
    fontSize: 18,
    marginBottom: 4,
  },
  backendDialogSubtitle: {
    fontSize: 13,
    marginBottom: 4,
  },
  backendOption: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },

  // Tab styles
  tab: {
    height: 33,
    marginTop: 1,
    marginBottom: 12,
    paddingLeft: 8,
    paddingRight: 6,
    borderWidth: 0.7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  divider: {
    position: "absolute",
    right: -2,
    width: 1,
    height: 20,
    top: 7,
  },
  tabTitle: {
    fontSize: 13,
    flex: 1,
  },
  closeButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },

  // Logo
  logoContainer: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: "30%",
  },
  logoWrapper: {
    position: "relative",
  },
  logo: {
    width: 320,
    height: 80,
  },
  headerMenuWrapper: {
    position: "relative",
    marginLeft: 2,
  },
  headerMenuButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  promptButtonsContainer: {
    marginTop: 24,
    width: 320,
    gap: 8,
  },
  promptButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
  },
  promptButtonText: {
    fontSize: 11,
  },

  // Message styles
  userBubble: {
    maxWidth: "85%",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  assistantMessage: {
    alignSelf: "stretch",
    marginVertical: 7,
    paddingVertical: 4,
  },
  messagePartSpacingLoose: {
    marginTop: 10,
  },
  messagePartSpacingTight: {
    marginTop: 0,
  },
  messagePartSpacingGroups: {
    marginTop: 0,
  },
  commandGroupContainer: {
  },
  commandGroupHeader: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  commandGroupHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  commandGroupBody: {
    marginTop: 4,
    gap: 4,
  },

  // Reasoning
  reasoningContainer: {
    marginVertical: 0,
  },
  reasoningHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
    paddingVertical: 4,
    gap: 6,
  },
  reasoningBody: {
    padding: 10,
    borderWidth: 1,
    marginTop: 6,
  },

  // Step
  stepContainer: {
    marginVertical: 0,
  },
  stepContent: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  // Token chips
  tokenRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginVertical: 6,
  },
  tokenChip: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
  },

  // Error message
  errorMessage: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    marginVertical: 4,
    borderLeftWidth: 3,
  },
  thinkingMessage: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 2,
    paddingVertical: 4,
    marginVertical: 7,
  },
  thinkingText: {
    fontSize: 13,
    letterSpacing: 0.1,
  },

  composerBottomBar: {
    position: "relative",
    minHeight: 30,
    marginTop: 10,
    paddingLeft: 0,
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  composerStatusText: {
    marginTop: 8,
    marginRight: 2,
    alignSelf: "flex-end",
    fontSize: 11,
  },
  composerRowOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
  },
  modeIndicator: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },
  modelButton: {
    minWidth: 52,
    maxWidth: 220,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  modelText: {
    fontSize: 12,
    flexShrink: 1,
  },

  // Action buttons
  actionButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },

  // Input styles
  inputContainer: {
    marginHorizontal: 8,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingTop: 14,
    paddingBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inputWrapper: {
    alignItems: "stretch",
    paddingHorizontal: 0,
    paddingVertical: 0,
    justifyContent: "center",
    minHeight: 44,
    overflow: "hidden",
    position: "relative",
  },
  composerLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  voiceComposerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 3,
    justifyContent: "center",
  },
  voiceComposerInner: {
    flex: 1,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 8,
  },
  input: {
    fontSize: 14,
    paddingVertical: 6,
    paddingHorizontal: 10,
    maxHeight: 160,
  },
  voicePreview: {
    minHeight: 52,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  equalizerTrack: {
    width: "100%",
    height: 40,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 0.5,
    backgroundColor: "transparent",
    paddingHorizontal: 0,
  },
  equalizerBar: {
    width: VOICE_WAVE_DOT_SIZE,
    height: VOICE_WAVE_DOT_SIZE,
    borderRadius: 9999,
  },
  sendButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  voiceControlButton: {
    width: 34,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
  },
  voicePillRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  voicePillBtn: {
    width: 36,
    height: 36,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  voicePillWave: {
    flex: 1,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    gap: 2,
  },

  // Picker sheet
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheetContainer: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 0,
    height: "55%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 14,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    width: "100%",
    maxWidth: 400,
    padding: 20,
    borderWidth: 1,
  },
  permissionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  permissionSheetPrimaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  permissionSheetSecondaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
