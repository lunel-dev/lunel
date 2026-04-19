import Header, { BaseTab, useHeaderHeight } from "@/components/Header";
import InfoSheet from "@/components/InfoSheet";
import Loading from "@/components/Loading";
import { LinearGradient } from "expo-linear-gradient";
import { Codex, OpenCode, ClaudeCode } from "@lobehub/icons-rn";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useSessionRegistryActions } from "@/contexts/SessionRegistry";
import { useTheme } from "@/contexts/ThemeContext";
import { typography } from "@/constants/themes";
import { useConnection } from "@/contexts/ConnectionContext";
import { useEditorConfig } from "@/contexts/EditorContext";
import { useAI } from "@/hooks/useAI";
import { useApi, FileEntry } from "@/hooks/useApi";
import type { AIEvent, AISession, AIMessage, AIPart, AIAgent, AIProvider, AIPermission, AIQuestion, AIFileAttachment, ModelRef, PermissionResponse, AiBackend, CodexPromptOptions } from "./types";
import Markdown from "./Markdown";
import ToolCall from "./ToolCall";
import FileChange from "./FileChange";
import {
  Sparkle, Sparkles, Check, X, Plus,
  Hammer, Map as MapIcon, Square, AlertTriangle, Key,
  EllipsisVertical, ChevronDown, LoaderCircle, SquaresSubtract, Search, BookOpen, SlidersHorizontal, Mic, PieChart, File,
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
import * as DocumentPicker from "expo-document-picker";
import Feather from "@expo/vector-icons/Feather";
import Fontisto from "@expo/vector-icons/Fontisto";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Foundation from "@expo/vector-icons/Foundation";
import { Audio } from "expo-av";
import Svg, { Path } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MenuView } from "@react-native-menu/menu";
import { useDrawerStatus } from "@react-navigation/drawer";
import { innerApi } from "../../innerApi";
import { PluginPanelProps } from "../../types";
const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");
const AI_DETAILED_VIEW_STORAGE_KEY = "ai-detailed-view-enabled";
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

const DEFAULT_OPENCODE_AGENTS: { id: string; name: string; icon?: React.ComponentType<any> }[] = [
  { id: "build", name: "Build", icon: Hammer },
  { id: "plan", name: "Plan", icon: MapIcon },
];
const DEFAULT_CODEX_AGENTS: { id: string; name: string; icon?: React.ComponentType<any> }[] = [
  { id: "default", name: "Build", icon: Hammer },
  { id: "plan", name: "Plan", icon: MapIcon },
];

type ComposerSheet = "configure" | null;

const BUTTON_LABEL_MAX_CHARS = 12;

function truncateButtonLabel(value: string, maxChars: number = BUTTON_LABEL_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}..`;
}

function formatContextPercent(used: number, total: number): string {
  if (!total) return "0% used";
  return `${Math.round((used / total) * 100)}% used`;
}

function deriveUsageFromMessages(messages: AIMessage[], totalOverride?: number): { used: number; total: number } | undefined {
  let used = 0;
  let total = totalOverride && totalOverride > 0 ? totalOverride : 0;

  for (const message of messages) {
    for (const part of message.parts || []) {
      const tokens = part.tokens;
      if (!tokens) continue;
      used += (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
      const candidateTotal = typeof part.modelContextWindow === "number"
        ? part.modelContextWindow
        : typeof part.contextWindow === "number"
          ? part.contextWindow
          : 0;
      if (candidateTotal > total) total = candidateTotal;
    }
  }

  if (used <= 0 || total <= 0) return undefined;
  return { used, total };
}

function getDropdownHorizontalPosition(
  anchor: { x: number; width: number } | null,
  menuWidth: number,
): { left: number } | { right: number } {
  if (!anchor) return { left: 0 };

  const spaceRight = SCREEN_WIDTH - anchor.x;
  const spaceLeft = anchor.x + anchor.width;
  if (spaceRight >= menuWidth || spaceRight >= spaceLeft) {
    return { left: 0 };
  }
  return { right: 0 };
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
  return backend === "codex" ? "Codex" : "OpenCode";
}

function isBackendUnavailableError(message: string): boolean {
  return (
    /backend\s+"?(opencode|codex)"?\s+is not available/i.test(message)
    || /eunavailable/i.test(message)
    || /no ai backends available/i.test(message)
    || /ai manager not initialized/i.test(message)
  );
}

function showBackendMissingInstallAlert(backend: AiBackend): void {
  const backendLabel = formatBackendSessionTitle(backend);
  Alert.alert(
    `${backendLabel} Not Installed`,
    `Your PC doesn't have ${backendLabel} installed. Either install it manually, or run npx lunel-cli again and press y when it asks to install missing AI runtimes.`,
  );
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
    const nextTitle = (session.title || "").trim() || existing?.title || `Session ${i + 1}`;
    const nextUpdatedAt = session.time?.updated;

    byKey.set(key, {
      id: existing?.id ?? session.id,
      sessionId: session.id,
      backend,
      title: nextTitle,
      // Keep local ordering stable for existing tabs. We only move a tab when
      // the user sends a new prompt from that tab.
      updatedAt: existing?.updatedAt
        ?? (typeof nextUpdatedAt === "number" ? nextUpdatedAt : Date.now()),
    });
  }

  return sortTabsByUpdatedAt(Array.from(byKey.values()));
}

function reconcileSessionTabs(existingTabs: AITab[], incomingSessions: AISession[]): AITab[] {
  const incomingKeys = new Set(
    incomingSessions.map((session) => `${session.backend ?? "opencode"}:${session.id}`),
  );
  const merged = mergeSessionTabs(existingTabs, incomingSessions);
  return merged.filter((tab) => !!tab.sessionId && incomingKeys.has(`${tab.backend}:${tab.sessionId}`));
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

function mergeMessagePartsPreservingRichState(existingParts: AIPart[] = [], incomingParts: AIPart[] = []): AIPart[] {
  if (existingParts.length === 0) return incomingParts;
  if (incomingParts.length === 0) return existingParts;

  const merged = [...existingParts];

  for (const incomingPart of incomingParts) {
    const incomingId = typeof (incomingPart as any).id === "string" ? (incomingPart as any).id : undefined;
    const existingIndex = incomingId
      ? merged.findIndex((part) => (part as any).id === incomingId)
      : findStreamingPartIndex(merged, incomingPart);

    if (existingIndex >= 0) {
      merged[existingIndex] = mergePartUpdate(merged[existingIndex], incomingPart, {
        replaceText: true,
      });
      continue;
    }

    merged.push(incomingPart);
  }

  return merged;
}

function mergeMessagesPreservingRichState(existing: AIMessage[] = [], incoming: AIMessage[] = []): AIMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const mergedById = new Map<string, AIMessage>();
  const orderedIds: string[] = [];

  for (const message of existing) {
    mergedById.set(message.id, message);
    orderedIds.push(message.id);
  }

  for (const message of incoming) {
    const previous = mergedById.get(message.id);
    if (!previous) {
      mergedById.set(message.id, message);
      orderedIds.push(message.id);
      continue;
    }

    mergedById.set(message.id, {
      ...previous,
      ...message,
      parts: mergeMessagePartsPreservingRichState(previous.parts || [], message.parts || []),
      time: message.time ?? previous.time,
    });
  }

  return orderedIds
    .map((id) => mergedById.get(id))
    .filter((message): message is AIMessage => Boolean(message));
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
  if (!isUser && isHiddenAssistantMetaText(text)) return null;

  if (isUser) {
    // User messages: plain text (no markdown), styled for accent bg
    const displayText = text.replace(/<file path="[^"]*">[\s\S]*?<\/file>\n*/g, "").trim();
    return <UserText text={displayText} />;
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
  const text = ((part.text as string) || (typeof part.reasoning === "string" ? part.reasoning : "")).trim();
  if (!text) return null;
  if (isHiddenAssistantMetaText(text)) return null;

  return (
    <View style={styles.reasoningContainer}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={[styles.commandGroupHeader, styles.reasoningHeader, expanded ? { backgroundColor: colors.bg.raised } : null]}
        activeOpacity={0.7}
      >
        <View style={[styles.commandGroupHeaderLeft, styles.reasoningHeaderLeft]}>
          <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <BrainIcon size={15} color={colors.fg.muted} />
          </View>
          <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.regular, flex: 1 }}>
            Thinking
          </Text>
        </View>
      </TouchableOpacity>
      {expanded && text ? (
        <View style={[styles.reasoningBody, { borderColor: colors.bg.raised, backgroundColor: colors.bg.raised, borderRadius: radius.md }]}>
          <Markdown compact>{text}</Markdown>
        </View>
      ) : null}
    </View>
  );
}

function PlanPartView({ part }: { part: AIPart }) {
  const { colors, fonts, radius } = useTheme();
  const text = ((part.text as string) || "").trim();
  if (!text) return null;

  return (
    <View style={styles.reasoningContainer}>
      <View style={[styles.commandGroupHeader, styles.reasoningHeader, { backgroundColor: colors.bg.raised }]}>
        <View style={[styles.commandGroupHeaderLeft, styles.reasoningHeaderLeft]}>
          <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <MapIcon size={15} color={colors.fg.muted} />
          </View>
          <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.regular, flex: 1 }}>
            Plan
          </Text>
        </View>
      </View>
      <View style={[styles.reasoningBody, { borderColor: colors.bg.raised, backgroundColor: colors.bg.raised, borderRadius: radius.md }]}>
        <Markdown compact>{text}</Markdown>
      </View>
    </View>
  );
}

function StepStartView({ part }: { part: AIPart }) {
  const { colors, fonts } = useTheme();
  const title = (part.title as string) || "";

  if (!title) return null;

  return (
    <View style={styles.stepContainer}>
      <View style={styles.stepContent}>
        <Text style={{ color: colors.fg.subtle, fontSize: 11, fontFamily: fonts.mono.regular }}>
          {title}
        </Text>
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
  if (part.type === "plan") return "Planning...";
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
  | { kind: "command-group"; key: string; parts: AIPart[] }
  | { kind: "command-run-group"; key: string; parts: AIPart[] }
  | { kind: "exploration-group"; key: string; parts: AIPart[] };

function getPartToolName(part: AIPart): string {
  return String(part.name || part.toolName || "").trim().toLowerCase();
}

function getToolInputRecord(part: AIPart): Record<string, unknown> {
  return part.input && typeof part.input === "object"
    ? part.input as Record<string, unknown>
    : {};
}

function readToolInputString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function getExplorationKind(part: AIPart): "read" | "search" | null {
  if (part.type !== "tool" && part.type !== "tool-call" && part.type !== "tool-result") return null;
  const toolName = getPartToolName(part);
  if (!toolName) return null;

  if (
    toolName.includes("read")
    || toolName.includes("open_file")
    || toolName.includes("openfile")
    || toolName.includes("view_file")
    || toolName.includes("cat")
  ) {
    return "read";
  }

  if (
    toolName.includes("glob")
    || toolName.includes("search")
    || toolName.includes("grep")
    || toolName.includes("find")
    || toolName.includes("ls")
    || toolName.includes("tree")
    || toolName.includes("list")
  ) {
    return "search";
  }

  return null;
}

function isExplorationPart(part: AIPart): boolean {
  return getExplorationKind(part) !== null;
}

function formatExplorationEntry(part: AIPart): string | null {
  const kind = getExplorationKind(part);
  if (!kind) return null;

  const toolName = getPartToolName(part);
  const input = getToolInputRecord(part);
  const path = readToolInputString(input, ["path", "file_path", "filePath", "dir", "directory", "cwd"]);
  const pattern = readToolInputString(input, ["pattern", "glob", "query", "search", "needle"]);

  if (kind === "read") {
    const label = path || pattern;
    return label ? `Read  ${label}` : "Read";
  }

  if (toolName.includes("glob")) {
    if (path && pattern) return `Glob  ${path} / pattern=${pattern}`;
    if (pattern) return `Glob  pattern=${pattern}`;
    if (path) return `Glob  ${path}`;
    return "Glob";
  }

  if (toolName.includes("grep") || toolName.includes("search") || toolName.includes("find")) {
    if (path && pattern) return `Search  ${path} / pattern=${pattern}`;
    if (pattern) return `Search  pattern=${pattern}`;
    if (path) return `Search  ${path}`;
    return "Search";
  }

  if (toolName.includes("tree") || toolName === "ls" || toolName.includes("list")) {
    return path ? `Browse  ${path}` : "Browse";
  }

  return path || pattern ? `${toolName}  ${path || pattern}` : toolName;
}

function buildExplorationSummary(parts: AIPart[]): string {
  const readEntries = new Set<string>();
  const searchEntries = new Set<string>();
  for (const part of parts) {
    const kind = getExplorationKind(part);
    const line = formatExplorationEntry(part) ?? String((part as any).id || "");
    if (kind === "read") readEntries.add(line);
    else if (kind === "search") searchEntries.add(line);
  }
  const labels: string[] = [];
  if (readEntries.size > 0) labels.push(`${readEntries.size} Read${readEntries.size === 1 ? "" : "s"}`);
  if (searchEntries.size > 0) labels.push(`${searchEntries.size} Search${searchEntries.size === 1 ? "" : "es"}`);
  const eventCount = parts.length;
  return labels.length > 0 ? `${eventCount} Event${eventCount === 1 ? "" : "s"} · ${labels.join(", ")}` : `${eventCount} Event${eventCount === 1 ? "" : "s"} · Explored`;
}

function isGroupablePart(part: AIPart): boolean {
  if (part.type === "reasoning") {
    const text = ((part.text as string) || (typeof part.reasoning === "string" ? part.reasoning : "")).trim();
    if (isHiddenAssistantMetaText(text)) return false;
    return text.length > 0;
  }
  return part.type === "step-start" || part.type === "step-finish";
}

function isCommandToolPart(part: AIPart): boolean {
  if (part.type !== "tool" && part.type !== "tool-call" && part.type !== "tool-result") {
    return false;
  }

  const toolName = getPartToolName(part);
  if (!toolName) return false;

  return toolName === "command"
    || toolName.includes("bash")
    || toolName.includes("shell")
    || toolName.includes("terminal")
    || toolName.includes("exec");
}

function isHiddenMetaPart(part: AIPart): boolean {
  if (part.type === "step-start" || part.type === "step-finish") return true;
  if (part.type === "text") {
    const text = (part.text as string) || "";
    if (!text.trim()) return true;
    return isHiddenAssistantMetaText(text);
  }
  if (part.type === "reasoning") {
    const text = ((part.text as string) || (typeof part.reasoning === "string" ? part.reasoning : "")).trim();
    if (!text) return true;
    return isHiddenAssistantMetaText(text);
  }
  if (part.type === "plan") {
    const text = ((part.text as string) || "").trim();
    return !text;
  }
  return false;
}

function isHiddenAssistantMetaText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "responding"
    || normalized === "responding..."
    || normalized.startsWith("responding to ");
}

function buildToolGroupLabel(parts: AIPart[]): string {
  let thinkingCount = 0;
  let toolCount = 0;
  for (const p of parts) {
    if (p.type === "reasoning") thinkingCount += 1;
    else if (p.type === "tool" || p.type === "tool-call" || p.type === "tool-result" || p.type === "file-change") toolCount += 1;
  }
  const eventCount = parts.length;
  if (thinkingCount > 0 && toolCount > 0) return `${eventCount} Event${eventCount === 1 ? "" : "s"} · Thinking, ${toolCount} Tool${toolCount !== 1 ? "s" : ""}`;
  if (thinkingCount > 0) return `${eventCount} Event${eventCount === 1 ? "" : "s"} · Thinking`;
  if (toolCount > 0) return `${eventCount} Event${eventCount === 1 ? "" : "s"} · ${toolCount} Tool${toolCount !== 1 ? "s" : ""}`;
  return `${eventCount} Event${eventCount === 1 ? "" : "s"}`;
}

function buildCommandGroupLabel(parts: AIPart[]): string {
  const commandCount = parts.filter((part) => isCommandToolPart(part)).length;
  const eventCount = parts.length;
  if (commandCount > 0) {
    return `${eventCount} Event${eventCount === 1 ? "" : "s"} · ${commandCount} Command${commandCount === 1 ? "" : "s"}`;
  }
  return `${eventCount} Event${eventCount === 1 ? "" : "s"}`;
}

function buildMessageDisplayItems(parts: AIPart[]): MessageDisplayItem[] {
  const items: MessageDisplayItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (isHiddenMetaPart(part)) {
      i += 1;
      continue;
    }
    if (isExplorationPart(part)) {
      const runStart = i;
      while (i < parts.length && isExplorationPart(parts[i])) i += 1;
      const runParts = parts.slice(runStart, i);
      items.push({
        kind: "exploration-group",
        key: `exploration-group-${String((runParts[0] as any).id || runStart)}`,
        parts: runParts,
      });
      continue;
    }
    if (isCommandToolPart(part)) {
      const runStart = i;
      while (i < parts.length && isCommandToolPart(parts[i])) i += 1;
      const runParts = parts.slice(runStart, i);
      if (runParts.length > 1) {
        items.push({
          kind: "command-run-group",
          key: `command-run-group-${String((runParts[0] as any).id || runStart)}`,
          parts: runParts,
        });
      } else {
        items.push({
          kind: "part",
          key: String((runParts[0] as any).id || `part-${runStart}`),
          part: runParts[0],
        });
      }
      continue;
    }
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
        const safeParts = parts.filter((part): part is AIPart => !!part && typeof part === "object");
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
          {safeParts.map((part, i) => (
            <View key={i} style={i > 0 ? getMessagePartSpacingStyle(safeParts[i - 1], part, styles) : undefined}>
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
          ) : item.kind === "command-run-group" ? (
            <CommandRunGroup
              commandParts={item.parts}
              colors={colors}
              fonts={fonts}
              radius={radius}
              showDetailedView={showDetailedView}
              pendingPermission={pendingPermission}
              onPermissionReply={onPermissionReply}
            />
          ) : item.kind === "exploration-group" ? (
            <ExplorationGroup
              parts={item.parts}
              colors={colors}
              fonts={fonts}
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

function getMessagePartSpacingStyle(previous: AIPart | undefined, current: AIPart | undefined, styles: any) {
  if (!previous || !current) return undefined;

  const previousHasTextOutput = partHasTextOutput(previous);
  const currentHasTextOutput = partHasTextOutput(current);

  if (previousHasTextOutput || currentHasTextOutput) {
    return styles.messagePartSpacingLoose;
  }

  return styles.messagePartSpacingTight;
}

function partHasTextOutput(part: AIPart | undefined | null) {
  if (!part || typeof part !== "object") return false;
  if (part.type === "text" || part.type === "reasoning") return true;
  if ((part.type === "tool" || part.type === "tool-call" || part.type === "tool-result" || part.type === "file-change") && typeof part.output === "string") {
    return part.output.trim().length > 0;
  }
  return false;
}

function getDisplayItemSpacingStyle(previous: MessageDisplayItem, current: MessageDisplayItem, styles: any) {
  if (
    (previous.kind === "command-group" || previous.kind === "command-run-group")
    && (current.kind === "command-group" || current.kind === "command-run-group")
  ) {
    return styles.messagePartSpacingGroups;
  }
  if (previous.kind === "exploration-group" || current.kind === "exploration-group") {
    return styles.messagePartSpacingLoose;
  }

  const previousHasTextOutput = itemHasTextOutput(previous);
  const currentHasTextOutput = itemHasTextOutput(current);

  if (previousHasTextOutput || currentHasTextOutput) {
    return styles.messagePartSpacingLoose;
  }

  return styles.messagePartSpacingTight;
}

function itemHasTextOutput(item: MessageDisplayItem) {
  if (
    item.kind === "command-group"
    || item.kind === "command-run-group"
    || item.kind === "exploration-group"
  ) {
    return false;
  }
  return partHasTextOutput(item.part);
}

function ExplorationGroup({
  parts,
  colors,
  fonts,
}: {
  parts: AIPart[];
  colors: any;
  fonts: any;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = buildExplorationSummary(parts);
  const entries = useMemo(() => {
    const seen = new Set<string>();
    const lines: Array<{ kind: "read" | "search"; line: string }> = [];
    for (const part of parts) {
      const kind = getExplorationKind(part);
      const line = formatExplorationEntry(part);
      if (!kind || !line || seen.has(line)) continue;
      seen.add(line);
      lines.push({ kind, line });
    }
    return lines;
  }, [parts]);
  return (
    <View style={styles.commandGroupContainer}>
      <TouchableOpacity
        onPress={() => setExpanded((value) => !value)}
        activeOpacity={0.7}
        style={[styles.commandGroupHeader, expanded ? { backgroundColor: colors.bg.raised } : null]}
      >
        <View style={styles.commandGroupHeaderLeft}>
          <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <SquaresSubtract size={15} color={colors.fg.muted} strokeWidth={2} />
          </View>
          <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.medium, flex: 1 }}>
            {summary}
          </Text>
        </View>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.explorationGroupBody}>
          {entries.map((entry, index) => (
            <View key={`${entry.line}:${index}`} style={styles.groupListRow}>
              <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
                {entry.kind === "read"
                  ? <BookOpen size={15} color={colors.fg.muted} strokeWidth={2} />
                  : <Search size={15} color={colors.fg.muted} strokeWidth={2} />}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
                <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.regular }}>
                  {entry.line}
                </Text>
              </ScrollView>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
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
        style={[styles.commandGroupHeader, expanded ? { backgroundColor: colors.bg.raised } : null]}
      >
        <View style={styles.commandGroupHeaderLeft}>
          <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <SquaresSubtract size={15} color={colors.fg.muted} strokeWidth={2} />
          </View>
          <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.medium, flex: 1 }}>
            {label}
          </Text>
        </View>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.commandGroupBody}>
          {commandParts.map((part, index) => (
            <View key={String((part as any).id || `command-part-${index}`)} style={styles.groupListRowWrap}>
              <MessagePartView
                part={part}
                isUser={false}
                colors={colors}
                fonts={fonts}
                radius={radius}
                showDetailedView={showDetailedView}
                pendingPermission={pendingPermission}
                onPermissionReply={onPermissionReply}
                groupedRow
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function CommandRunGroup({
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
  const label = buildCommandGroupLabel(commandParts);

  return (
    <View style={styles.commandGroupContainer}>
      <TouchableOpacity
        onPress={() => setExpanded((value) => !value)}
        activeOpacity={0.7}
        style={[styles.commandGroupHeader, expanded ? { backgroundColor: colors.bg.raised } : null]}
      >
        <View style={styles.commandGroupHeaderLeft}>
          <View style={[styles.commandGroupIconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <SquaresSubtract size={15} color={colors.fg.muted} strokeWidth={2} />
          </View>
          <Text style={{ color: colors.fg.muted, fontSize: typography.subHeading, fontFamily: fonts.sans.medium, flex: 1 }}>
            {label}
          </Text>
        </View>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.commandGroupBody}>
          {commandParts.map((part, index) => (
            <View key={String((part as any).id || `command-run-part-${index}`)} style={styles.groupListRowWrap}>
              <MessagePartView
                part={part}
                isUser={false}
                colors={colors}
                fonts={fonts}
                radius={radius}
                showDetailedView={showDetailedView}
                pendingPermission={pendingPermission}
                onPermissionReply={onPermissionReply}
                groupedRow
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
  groupedRow = false,
}: {
  part: AIPart;
  isUser: boolean;
  colors: any;
  fonts: any;
  radius: any;
  showDetailedView: boolean;
  pendingPermission?: AIPermission | null;
  onPermissionReply?: (response: PermissionResponse) => void;
  groupedRow?: boolean;
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
          groupedRow={groupedRow}
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
    case "plan":
      return <PlanPartView part={part} />;
    case "step-start":
      return null;
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
  const questions = Array.isArray(questionRequest.questions) ? questionRequest.questions : [];
  const [selectedIndices, setSelectedIndices] = useState<Record<number, number | null>>(() =>
    Object.fromEntries(questions.map((question, index) => [index, Array.isArray(question?.options) && question.options.length > 0 ? 0 : null]))
  );
  const [freeformAnswers, setFreeformAnswers] = useState<Record<number, string>>({});

  const handleSubmit = () => {
    const answers = questions.map((question, index) => {
      const baseOptions = Array.isArray(question?.options) ? question.options : [];
      const options = question?.isOther
        ? [...baseOptions, { label: "__other__", description: "Enter a custom answer." }]
        : baseOptions;
      const selectedIndex = selectedIndices[index];
      const selectedLabel = selectedIndex != null ? options[selectedIndex]?.label : undefined;
      const typedValue = (freeformAnswers[index] || "").trim();

      if (selectedLabel === "__other__") {
        return typedValue ? [typedValue] : [];
      }

      if (selectedLabel) {
        return [selectedLabel];
      }

      return typedValue ? [typedValue] : [];
    });

    if (answers.every((entry) => entry.length > 0)) {
      onSubmit(answers);
    }
  };

  const canSubmit = questions.length > 0 && questions.every((question, index) => {
    const baseOptions = Array.isArray(question?.options) ? question.options : [];
    const options = question?.isOther
      ? [...baseOptions, { label: "__other__", description: "Enter a custom answer." }]
      : baseOptions;
    const selectedIndex = selectedIndices[index];
    const selectedLabel = selectedIndex != null ? options[selectedIndex]?.label : undefined;
    const typedValue = (freeformAnswers[index] || "").trim();

    if (selectedLabel === "__other__") {
      return typedValue.length > 0;
    }
    if (selectedLabel) {
      return true;
    }
    return typedValue.length > 0;
  });

  return (
    <Modal transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { backgroundColor: colors.bg.raised, borderRadius: radius.md, borderColor: colors.bg.raised }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Sparkles size={20} color={colors.accent.default} strokeWidth={2} />
            <Text style={{ color: colors.fg.default, fontSize: 15, fontFamily: fonts.sans.semibold }}>Input Needed</Text>
          </View>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 16, paddingBottom: 8 }}>
            {questions.map((question, questionIndex) => {
              const baseOptions = Array.isArray(question?.options) ? question.options : [];
              const options = question?.isOther
                ? [...baseOptions, { label: "__other__", description: "Enter a custom answer." }]
                : baseOptions;
              const selectedIndex = selectedIndices[questionIndex];
              const selectedLabel = selectedIndex != null ? options[selectedIndex]?.label : undefined;
              const shouldShowFreeform = options.length === 0 || selectedLabel === "__other__";

              return (
                <View key={question.id || `${question.header}:${questionIndex}`}>
                  <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold, marginBottom: 6 }}>
                    {question?.header || `Question ${questionIndex + 1}`}
                  </Text>
                  <Text style={{ color: colors.fg.muted, fontSize: 13, fontFamily: fonts.sans.regular, marginBottom: 14 }}>
                    {question?.question || "The agent needs your input to continue."}
                  </Text>
                  {options.length > 0 ? (
                    <View style={{ gap: 8, marginBottom: shouldShowFreeform ? 12 : 0 }}>
                      {options.map((option, optionIndex) => {
                        const active = selectedIndex === optionIndex;
                        const label = option.label === "__other__" ? "Other" : option.label;
                        return (
                          <TouchableOpacity
                            key={`${label}:${optionIndex}`}
                            onPress={() => setSelectedIndices((prev) => ({ ...prev, [questionIndex]: optionIndex }))}
                            style={{
                              borderWidth: 1,
                              borderColor: active ? colors.accent.default : colors.bg.raised,
                              backgroundColor: colors.bg.raised,
                              borderRadius: radius.md,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.semibold }}>
                              {label}
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
                  ) : null}
                  {shouldShowFreeform ? (
                    <TextInput
                      value={freeformAnswers[questionIndex] || ""}
                      onChangeText={(value) => setFreeformAnswers((prev) => ({ ...prev, [questionIndex]: value }))}
                      placeholder="Type your answer"
                      placeholderTextColor={colors.fg.muted}
                      multiline={!question?.isSecret}
                      secureTextEntry={!!question?.isSecret}
                      style={{
                        color: colors.fg.default,
                        backgroundColor: colors.bg.raised,
                        borderRadius: radius.md,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        minHeight: question?.isSecret ? undefined : 96,
                        textAlignVertical: question?.isSecret ? "center" : "top",
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
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
              style={[styles.permissionBtn, { backgroundColor: colors.accent.default, borderRadius: radius.sm, opacity: canSubmit ? 1 : 0.5 }]}
              activeOpacity={0.7}
              disabled={!canSubmit}
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

// ============================================================================
// Bottom Sheet Picker
// ============================================================================

function ConfigureSheet({
  visible,
  backend,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onClose,
  colors,
  fonts,
}: {
  visible: boolean;
  backend: AiBackend;
  modelOptions: { id: string; name: string }[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  onClose: () => void;
  colors: any;
  fonts: any;
}) {
  return (
    <InfoSheet visible={visible} onClose={onClose} title="Model" description="Select a model">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 0, paddingBottom: 48, gap: 12 }}
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 6 }}>
          {modelOptions.length > 0 ? modelOptions.map((option) => {
            const selected = option.id === selectedModelId;
            return (
              <TouchableOpacity
                key={option.id}
                style={[styles.sheetRow, { backgroundColor: selected ? colors.bg.raised : "transparent", borderRadius: 8 }]}
                onPress={() => onSelectModel(option.id)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.regular }}>
                    {option.name}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }) : (
            <View style={[styles.backendOption, { backgroundColor: colors.bg.raised, borderRadius: 10, opacity: 0.7 }]}>
              <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular }}>
                {backend === "codex" ? "Auto" : "No models available"}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </InfoSheet>
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
  const headerHeight = useHeaderHeight();
  const { status, sessionState } = useConnection();
  const { fs } = useApi();
  const { register, unregister } = useSessionRegistryActions();
  const drawerStatus = useDrawerStatus();
  const isDrawerOpen = drawerStatus === "open";

  // Session state
  const [sessionTabs, setSessionTabs] = useState<AITab[]>([]);
  const [draftTabs, setDraftTabs] = useState<AITab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingBackend, setPendingBackend] = useState<AiBackend | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<string, AIMessage[]>>({});

  // Config state
  const [agentsByBackend, setAgentsByBackend] = useState<Record<AiBackend, { id: string; name: string; icon?: React.ComponentType<any> }[]>>({
    opencode: DEFAULT_OPENCODE_AGENTS,
    codex: DEFAULT_CODEX_AGENTS,
  });
  const [modelOptionsByBackend, setModelOptionsByBackend] = useState<Record<AiBackend, { id: string; name: string }[]>>({
    opencode: [],
    codex: [],
  });
  const [selectedAgentByBackend, setSelectedAgentByBackend] = useState<Record<AiBackend, string>>({
    opencode: "build",
    codex: "default",
  });
  const [selectedModelByBackend, setSelectedModelByBackend] = useState<Record<AiBackend, string>>({
    opencode: "",
    codex: "",
  });
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<NonNullable<CodexPromptOptions["reasoningEffort"]>>("medium");
  const [codexSpeed, setCodexSpeed] = useState<NonNullable<CodexPromptOptions["speed"]>>("balanced");
  const [codexPermissionMode, setCodexPermissionMode] = useState<NonNullable<CodexPromptOptions["permissionMode"]>>("default");
  const [providersByBackend, setProvidersByBackend] = useState<Record<AiBackend, AIProvider[]>>({
    opencode: [],
    codex: [],
  });

  // UI state
  const [inputText, setInputText] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showCodexReasoningMenu, setShowCodexReasoningMenu] = useState(false);
  const [showCodexSpeedMenu, setShowCodexSpeedMenu] = useState(false);
  const [showCodexPermissionMenu, setShowCodexPermissionMenu] = useState(false);
  const [showCodexContextUsageMenu, setShowCodexContextUsageMenu] = useState(false);
  const [modeMenuAnchor, setModeMenuAnchor] = useState<{ x: number; width: number } | null>(null);
  const [codexReasoningAnchor, setCodexReasoningAnchor] = useState<{ x: number; width: number } | null>(null);
  const [codexSpeedAnchor, setCodexSpeedAnchor] = useState<{ x: number; width: number } | null>(null);
  const [codexPermissionAnchor, setCodexPermissionAnchor] = useState<{ x: number; width: number } | null>(null);
  const [codexContextUsageAnchor, setCodexContextUsageAnchor] = useState<{ x: number; width: number } | null>(null);
  const [pendingImage, setPendingImage] = useState<AIFileAttachment | null>(null);
  const [atMentionActive, setAtMentionActive] = useState(false);
  const [atMentionQuery, setAtMentionQuery] = useState("");
  const [allWorkspaceFiles, setAllWorkspaceFiles] = useState<string[]>([]);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [taggedFiles, setTaggedFiles] = useState<{ path: string; name: string }[]>([]);
  const [streamingBySession, setStreamingBySession] = useState<Record<string, true>>({});
  const [codexUsageBySession, setCodexUsageBySession] = useState<Record<string, { used?: number; total?: number }>>({});
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
  const messagesListRef = useRef<FlashList<any>>(null);
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
  const deletedSessionKeysRef = useRef<Set<string>>(new Set());
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
  const isAnySessionStreaming = useMemo(
    () => Object.keys(streamingBySession).length > 0,
    [streamingBySession],
  );
  const isActiveSessionStreaming = !!activeSessionId && !!streamingBySession[activeSessionId];
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeBackend: AiBackend = activeTab?.backend ?? pendingBackend ?? "opencode";
  const agents = agentsByBackend[activeBackend] || [];
  const modelOptions = modelOptionsByBackend[activeBackend] || [];
  const selectedAgent = selectedAgentByBackend[activeBackend] || "";
  const selectedModel = selectedModelByBackend[activeBackend] || "";
  const providers = providersByBackend[activeBackend] || [];
  const needsApiKey = needsApiKeyByBackend[activeBackend] || false;
  const isActiveSessionLoading = !!activeSessionId && loadingSessionId === activeSessionId && !messagesMap[activeSessionId];
  const composerBottomOffset = composerHeight + (activeBackend === "codex" && showMoreOptions ? 40 : 0);

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
        case "message.part.removed": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const msgId = props.messageID as string | undefined;
          const partId = (props.partID as string) || (props.partId as string);
          if (!sessId || !msgId || !partId) break;
          setMessagesMap((prev) => {
            const existing = prev[sessId] || [];
            const msgIdx = existing.findIndex((m) => m.id === msgId);
            if (msgIdx < 0) return prev;
            const updated = [...existing];
            updated[msgIdx] = {
              ...updated[msgIdx],
              parts: (updated[msgIdx].parts || []).filter((part) => (part as any).id !== partId),
            };
            return { ...prev, [sessId]: updated };
          });
          break;
        }
        case "session.updated": {
          const info = (props.info || props) as Record<string, unknown>;
          const backend = (event.backend ?? "opencode") as AiBackend;
          const sessId = info.id as string;
          const deletedKey = `${backend}:${sessId}`;
          if (sessId && deletedSessionKeysRef.current.has(deletedKey)) {
            break;
          }
          const title = info.title as string;
          const updatedAt = (info.time as Record<string, unknown> | undefined)?.updated as number | undefined;
          if (sessId) {
            setSessionTabs((prev) => {
              const existingIndex = prev.findIndex((t) => t.sessionId === sessId && t.backend === backend);
              if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = {
                  ...updated[existingIndex],
                  title: title || updated[existingIndex].title,
                };
                updated.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
                return updated;
              }

              return mergeSessionTabs(prev, [{
                id: sessId,
                title: title || "Conversation",
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
        case "session.deleted": {
          const info = (props.info || props) as Record<string, unknown>;
          const backend = (event.backend ?? "opencode") as AiBackend;
          const sessId = (info.id as string) || (props.sessionID as string) || (props.sessionId as string);
          if (!sessId) break;
          deletedSessionKeysRef.current.add(`${backend}:${sessId}`);
          setSessionTabs((prev) => prev.filter((t) => !(t.sessionId === sessId && t.backend === backend)));
          setMessagesMap((prev) => {
            const next = { ...prev };
            delete next[sessId];
            return next;
          });
          setErrorMessages((prev) => {
            const next = { ...prev };
            delete next[sessId];
            return next;
          });
          setSessionActivityLabels((prev) => {
            const next = { ...prev };
            delete next[sessId];
            return next;
          });
          setActiveTabId((prev) => (prev === sessId ? null : prev));
          setStreamingBySession((prev) => {
            if (!prev[sessId]) return prev;
            const next = { ...prev };
            delete next[sessId];
            return next;
          });
          break;
        }
        case "session.status": {
          // OpenCode: properties = { sessionID, status: { type: "idle" | "busy" | "retry" } }
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const statusObj = props.status as Record<string, unknown> | string | undefined;
          const statusType = typeof statusObj === "object" ? (statusObj?.type as string) : (statusObj as string);
          const normalized = (statusType || "").toLowerCase();
          const streaming = normalized === "busy" || normalized === "running" || normalized === "working";
          if (sessId) {
            setStreamingBySession((prev) => {
              if (streaming) {
                if (prev[sessId]) return prev;
                return { ...prev, [sessId]: true };
              }
              if (!prev[sessId]) return prev;
              const next = { ...prev };
              delete next[sessId];
              return next;
            });
          }
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
          if (sessId) {
            setStreamingBySession((prev) => {
              if (!prev[sessId]) return prev;
              const next = { ...prev };
              delete next[sessId];
              return next;
            });
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
        case "session.usage": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const tokenUsage = props.tokenUsage as Record<string, unknown> | undefined;
          const totalUsage = tokenUsage?.total as Record<string, unknown> | undefined;
          const used = typeof totalUsage?.totalTokens === "number" ? totalUsage.totalTokens : null;
          const total = typeof tokenUsage?.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
          if (sessId && (used !== null || (total !== null && total > 0))) {
            setCodexUsageBySession((prev) => ({
              ...prev,
              [sessId]: {
                used: used ?? prev[sessId]?.used,
                total: total && total > 0 ? total : prev[sessId]?.total,
              },
            }));
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
            setStreamingBySession((prev) => (
              prev[sessId]
                ? prev
                : { ...prev, [sessId]: true }
            ));
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Waiting for input..." }));
          }
          setPendingQuestion(props as unknown as AIQuestion);
          break;
        }
        case "question.replied":
        case "question.rejected": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setStreamingBySession((prev) => (
              prev[sessId]
                ? prev
                : { ...prev, [sessId]: true }
            ));
            setSessionActivityLabels((prev) => ({ ...prev, [sessId]: "Working..." }));
          }
          setPendingQuestion(null);
          break;
        }
        case "session.error":
        case "prompt_error": {
          const rawErr = props.error;
          const errMsg = typeof rawErr === 'string' ? rawErr : (rawErr && typeof rawErr === 'object' ? ((rawErr as any).message || (rawErr as any).name || JSON.stringify(rawErr)) : null) || "An error occurred";
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId) {
            setStreamingBySession((prev) => {
              if (!prev[sessId]) return prev;
              const next = { ...prev };
              delete next[sessId];
              return next;
            });
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
              const filteredAgents = backend === "opencode"
                ? (agentsList as AIAgent[]).filter((a) => {
                    const normalized = (a.mode || a.name || "").trim().toLowerCase();
                    return normalized === "build" || normalized === "plan";
                  })
                : (agentsList as AIAgent[]);
              const mapped = filteredAgents.map((a) => {
                const raw = a.name || a.mode;
                const id = (a.mode || a.name || "").trim().toLowerCase();
                return {
                  id: id || raw,
                  name: raw.charAt(0).toUpperCase() + raw.slice(1),
                  icon: a.mode === "plan" ? MapIcon : Hammer,
                };
              });
              const resolvedAgents = mapped.length === 0
                ? (backend === "codex" ? DEFAULT_CODEX_AGENTS : DEFAULT_OPENCODE_AGENTS)
                : mapped;
              setAgentsByBackend((prev) => ({ ...prev, [backend]: resolvedAgents }));
              setSelectedAgentByBackend((prev) => ({ ...prev, [backend]: resolvedAgents[0]?.id || "" }));
            } else if (backend === "codex") {
              setAgentsByBackend((prev) => ({ ...prev, codex: DEFAULT_CODEX_AGENTS }));
              setSelectedAgentByBackend((prev) => ({ ...prev, codex: "default" }));
            }
          } catch {
            if (backend === "codex") {
              setAgentsByBackend((prev) => ({ ...prev, codex: DEFAULT_CODEX_AGENTS }));
              setSelectedAgentByBackend((prev) => ({ ...prev, codex: "default" }));
            }
          }

          try {
            const result = await ai.getProviders(backend);
            const providersList = result.providers;
            const defaults = result.defaults || {};
            if (Array.isArray(providersList)) {
              setProvidersByBackend((prev) => ({ ...prev, [backend]: providersList as AIProvider[] }));
              const models: { id: string; name: string }[] = [];
              let hasConfiguredKey = false;
              let defaultModelId = "";

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
        const incoming = msgs as AIMessage[];
        const next = backend === "codex"
          ? incoming.map((msg) => {
              const existingMsg = (prev[sessionId] || []).find((m) => m.id === msg.id);
              if (!existingMsg) return msg;
              return {
                ...msg,
                parts: mergeMessagePartsPreservingRichState(existingMsg.parts || [], msg.parts || []),
              };
            })
          : incoming;
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
        setSessionTabs((prev) => {
          const nextTabs = reconcileSessionTabs(prev, sessions as AISession[]);
          setActiveTabId((prevActive) => {
            if (!prevActive) return prevActive;
            return nextTabs.some((t) => t.id === prevActive) || draftTabs.some((t) => t.id === prevActive)
              ? prevActive
              : (nextTabs[nextTabs.length - 1]?.id ?? null);
          });
          return nextTabs;
        });
      } catch {
        // best effort refresh
      }
    };

    void refreshSessions();
    return () => {
      cancelled = true;
    };
  }, [status, isInitialized, isActive, drawerStatus, ai, draftTabs]);

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
      if (cancelled || isActiveSessionStreaming || activeBackend !== "opencode" || !activeSessionId) {
        return;
      }
      await refreshSessionMessages(activeSessionId, activeBackend, false);
    };

    const interval = setInterval(refreshOpenCodeActiveSession, 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, isInitialized, isActive, isActiveSessionStreaming, activeBackend, activeSessionId, refreshSessionMessages]);

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

  // Scroll to bottom on new messages
  const activeMessageBucketId = useMemo(() => {
    if (activeSessionId) return activeSessionId;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab && !tab.sessionId) return tab.id;
    return null;
  }, [activeSessionId, tabs, activeTabId]);
  const currentMessages = activeMessageBucketId ? messagesMap[activeMessageBucketId] || [] : [];
  const currentErrors = activeMessageBucketId ? errorMessages[activeMessageBucketId] || [] : [];
const selectedModelNameFull = modelOptions.find((m) => m.id === selectedModel)?.name
    || (activeBackend === "codex" ? "Auto" : "Select model");
  const selectedModelName = truncateButtonLabel(selectedModelNameFull);
  const reasoningOptions: Array<{ id: NonNullable<CodexPromptOptions["reasoningEffort"]>; label: string }> = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
  const speedOptions: Array<{ id: NonNullable<CodexPromptOptions["speed"]>; label: string }> = [
    { id: "fast", label: "Fast" },
    { id: "balanced", label: "Balanced" },
    { id: "quality", label: "Quality" },
  ];
  const permissionOptions: Array<{ id: NonNullable<CodexPromptOptions["permissionMode"]>; label: string }> = [
    { id: "default", label: "Default permission" },
    { id: "full-access", label: "Full access" },
  ];
  const codexReasoningLabel = truncateButtonLabel(`${codexReasoningEffort[0].toUpperCase()}${codexReasoningEffort.slice(1)}`);
  const codexSpeedLabel = truncateButtonLabel(`${codexSpeed[0].toUpperCase()}${codexSpeed.slice(1)}`);
  const codexPermissionLabel = truncateButtonLabel(codexPermissionMode === "full-access" ? "Full access" : "Default permission");
  const selectedAgentNameFull = activeBackend === "codex" && agents.length === 0
    ? ""
    : ((agents.find((a) => a.id === selectedAgent)?.name || selectedAgent) as string);
  const selectedAgentName = truncateButtonLabel(selectedAgentNameFull || "Mode");
  const combinedConfigLabel = activeBackend === "opencode" && selectedAgentNameFull
    ? `${selectedAgentNameFull} · ${selectedModelName}`
    : selectedModelName;
  const codexContextUsage = useMemo(() => {
    if (!activeSessionId) return undefined;
    const liveUsage = codexUsageBySession[activeSessionId];
    if (liveUsage?.used != null && liveUsage?.total != null && liveUsage.total > 0) {
      return { used: liveUsage.used, total: liveUsage.total };
    }
    return deriveUsageFromMessages(currentMessages, liveUsage?.total);
  }, [activeSessionId, codexUsageBySession, currentMessages]);
  useEffect(() => {
    isNearBottomRef.current = true;
    autoFollowRef.current = isActiveSessionStreaming;
    setShowScrollToBottom(false);
  }, [activeSessionId, isActiveSessionStreaming]);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;

    if (!settings.brainrotAiChatIntegration) {
      prevStreamingRef.current = isAnySessionStreaming;
      return;
    }

    if (!wasStreaming && isAnySessionStreaming) {
      innerApi.showBrainrot();
    } else if (wasStreaming && !isAnySessionStreaming) {
      innerApi.showAIChat();
    }

    prevStreamingRef.current = isAnySessionStreaming;
  }, [isAnySessionStreaming, settings.brainrotAiChatIntegration]);

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
  const markSessionAsUserActive = useCallback((sessionId: string, backend: AiBackend) => {
    const now = Date.now();
    setSessionTabs((prev) => prev.map((tab) => (
      tab.sessionId === sessionId && tab.backend === backend
        ? { ...tab, updatedAt: now }
        : tab
    )));
  }, []);

  const createNewTab = () => {
    setBackendPickerVisible(true);
  };

  const createNewTabWithBackend = async (backend: "opencode" | "codex") => {
    const previousActiveTabId = activeTabId;
    const draftTabId = `draft-${backend}-${Date.now().toString(36)}`;
    const draftTab: AITab = {
      id: draftTabId,
      title: formatBackendSessionTitle(backend),
      backend,
      updatedAt: Date.now(),
    };

    setBackendPickerVisible(false);
    setPendingBackend(null);
    setDraftTabs((prev) => [...prev, draftTab]);
    setMessagesMap((prev) => ({ ...prev, [draftTabId]: prev[draftTabId] || [] }));
    setActiveTabId(draftTabId);
    setInputText("");
    setPendingImage(null);

    try {
      const availableBackends = await ai.getBackends();
      if (!availableBackends.includes(backend)) {
        setDraftTabs((prev) => prev.filter((tab) => tab.id !== draftTabId));
        setMessagesMap((prev) => {
          const next = { ...prev };
          delete next[draftTabId];
          return next;
        });
        setActiveTabId((prev) => (prev === draftTabId ? previousActiveTabId : prev));
        showBackendMissingInstallAlert(backend);
        return;
      }
    } catch {
      // If backend discovery fails, we still allow the flow and handle errors on session creation.
    }
  };

  const deleteTab = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);

    // Optimistic update — remove immediately
    setSessionTabs((prev) => prev.filter((t) => t.id !== tabId));
    setDraftTabs((prev) => prev.filter((t) => t.id !== tabId));
    if (tab?.sessionId) {
      setMessagesMap((prev) => {
        const next = { ...prev };
        delete next[tab.sessionId];
        return next;
      });
      setErrorMessages((prev) => {
        const next = { ...prev };
        delete next[tab.sessionId];
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
          const deleted = await ai.deleteSession(tab.sessionId, tab.backend);
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
  }, [tabs, activeTabId, ai]);

  const closeTab = useCallback((tabId: string) => {
    Alert.alert(
      "Delete Session",
      "Are you sure you want to delete this session?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteTab(tabId),
        },
      ],
    );
  }, [deleteTab]);

  const renameTab = (tabId: string, nextTitle: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId) return;
    const trimmed = nextTitle.trim();
    if (!trimmed) return;

    const previousTitle = tab.title;
    setSessionTabs((prev) => prev.map((t) => (
      t.id === tabId ? { ...t, title: trimmed } : t
    )));

    void (async () => {
      try {
        const renamed = await ai.renameSession(tab.sessionId!, trimmed, tab.backend);
        const finalTitle = (renamed.title || "").trim() || trimmed;
        setSessionTabs((prev) => prev.map((t) => (
          t.id === tabId ? { ...t, title: finalTitle } : t
        )));
      } catch (err) {
        setSessionTabs((prev) => prev.map((t) => (
          t.id === tabId ? { ...t, title: previousTitle } : t
        )));
        const message = err instanceof Error ? err.message : "Failed to rename session";
        Alert.alert("Rename Failed", message);
      }
    })();
  };

  const handleTabPress = useCallback(async (tabId: string) => {
    setPendingBackend(null);
    setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && !messagesMap[tab.sessionId]) {
      try {
        setLoadingSessionId(tab.sessionId);
        const msgs = await ai.getMessages(tab.sessionId, tab.backend);
        if (Array.isArray(msgs)) {
          setMessagesMap((prev) => ({ ...prev, [tab.sessionId!]: msgs as AIMessage[] }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? "");
        if (/session not found/i.test(message) || /NotFoundError/i.test(message)) {
          setSessionTabs((prev) => prev.filter((t) => !(t.sessionId === tab.sessionId && t.backend === tab.backend)));
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
    return { providerID, modelID };
  }, [selectedModel]);

  const getCodexPromptOptions = useCallback((): CodexPromptOptions | undefined => {
    if (activeBackend !== "codex") return undefined;
    return {
      reasoningEffort: codexReasoningEffort,
      speed: codexSpeed,
      permissionMode: codexPermissionMode,
    };
  }, [activeBackend, codexPermissionMode, codexReasoningEffort, codexSpeed]);

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

  const handleAttachment = useCallback(() => {
    setShowAttachMenu(prev => !prev);
  }, []);

  const handleAttachGallery = useCallback(async () => {
    setShowAttachMenu(false);
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
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = inferImageMime(asset.uri, asset.mimeType);
      const filename = asset.fileName || asset.uri.split("/").pop() || "image";
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      setPendingImage({ type: "file", mime, filename, url: `data:${mime};base64,${base64}` });
    } catch (err) {
      console.error("Gallery pick error:", err);
      Alert.alert("Error", "Failed to pick image");
    }
  }, []);

  const handleAttachCamera = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Camera Permission", "Camera permission is required to take photos.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        base64: false,
        presentationStyle: Platform.OS === "ios" ? ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN : undefined,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = inferImageMime(asset.uri, asset.mimeType);
      const filename = asset.fileName || asset.uri.split("/").pop() || "photo";
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      setPendingImage({ type: "file", mime, filename, url: `data:${mime};base64,${base64}` });
    } catch (err) {
      console.error("Camera error:", err);
      Alert.alert("Error", "Failed to take photo");
    }
  }, []);

  const handleAttachFile = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = asset.mimeType || "application/octet-stream";
      const filename = asset.name;
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      setPendingImage({ type: "file", mime, filename, url: `data:${mime};base64,${base64}` });
    } catch (err) {
      console.error("Document pick error:", err);
      Alert.alert("Error", "Failed to pick file");
    }
  }, []);

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
      });
    } catch (err) {
      console.error("Image pick error:", err);
      Alert.alert("Error", "Failed to pick image");
    }
  }, []);

  // Send message / handle slash commands
  const sendMessage = async (rawText?: string) => {
    let text = (rawText ?? inputText).trim();
    if (!text && !pendingImage) return;
    const displayText = text;

    // Inject @mentioned file contents as context
    const mentionMatches = [...text.matchAll(/@([\w.\-]+)/g)];
    if (mentionMatches.length > 0) {
      const fileSections: string[] = [];
      for (const match of mentionMatches) {
        const mentionedName = match[1];
        const filePath = allWorkspaceFiles.find((p) => (p.split("/").pop() ?? p) === mentionedName);
        if (!filePath) continue;
        try {
          const fileContent = await fs.read(filePath);
          if (fileContent.encoding === "utf8") {
            fileSections.push(`<file path="${filePath}">\n${fileContent.content}\n</file>`);
          }
        } catch {}
      }
      if (fileSections.length > 0) {
        text = fileSections.join("\n\n") + "\n\n" + text;
      }
    }

    if (rawText == null) {
      setInputText("");
      animateInputHeight(52);
      Keyboard.dismiss();
    }

    // Resolve backend + transient draft context
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const messageBackend: "opencode" | "codex" = activeTab?.backend ?? pendingBackend ?? "opencode";
    const selectedAgentForBackend = selectedAgent || undefined;
    let sessId = activeSessionId;
    let localDraftTabId: string | null = activeTab && !activeTab.sessionId ? activeTab.id : null;
    if (!sessId && !localDraftTabId) {
      localDraftTabId = `draft-send-${Date.now().toString(36)}`;
      const draftTab: AITab = {
        id: localDraftTabId,
        title: messageBackend === "codex" ? "Codex" : "OpenCode",
        backend: messageBackend,
        updatedAt: Date.now(),
      };
      setDraftTabs((prev) => [...prev, draftTab]);
      setMessagesMap((prev) => ({ ...prev, [localDraftTabId!]: prev[localDraftTabId!] || [] }));
      setActiveTabId(localDraftTabId);
    }

    const ensureSession = async (): Promise<string | null> => {
      if (sessId) return sessId;
      try {
        const session = await ai.createSession(undefined, messageBackend);
        sessId = session.id;
        const derivedTitle = displayText.replace(/@[\w.\-]+\s*/g, "").trim().slice(0, 40) || displayText.trim().slice(0, 40);
        const sessionTitle = (session.title || "").trim() || derivedTitle || (messageBackend === "codex" ? "Codex" : "OpenCode");
        setSessionTabs((prev) => mergeSessionTabs(prev, [{ ...session, backend: messageBackend } as AISession]));
        setPendingBackend(null);
        const currentActiveTabId = localDraftTabId ?? activeTabId;
        setDraftTabs((prev) => prev.filter((t) => t.id !== currentActiveTabId));
        setMessagesMap((prev) => {
          if (!currentActiveTabId || currentActiveTabId === session.id) return prev;
          const draftMessages = prev[currentActiveTabId];
          if (!draftMessages) return prev;
          const next = { ...prev };
          delete next[currentActiveTabId];
          next[session.id] = draftMessages;
          return next;
        });
        setSessionTabs((prev) => {
          const existing = prev.find((t) => t.sessionId === session.id && t.backend === messageBackend);
          if (!existing) return prev;
          return prev.map((t) => (
            t.sessionId === session.id && t.backend === messageBackend
              ? { ...t, title: sessionTitle }
              : t
          ));
        });
        setActiveTabId(session.id);
        return sessId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? "");
        if (isBackendUnavailableError(message)) {
          showBackendMissingInstallAlert(messageBackend);
        } else {
          Alert.alert("Error", "Failed to create AI session");
        }
        return null;
      }
    };

    // Handle slash commands
    if (text.startsWith("/") && !pendingImage) {
      const ensured = await ensureSession();
      if (!ensured) return;
      markSessionAsUserActive(ensured, messageBackend);
      const cmd = text.slice(1).split(" ")[0].toLowerCase();
      try {
        switch (cmd) {
          case "undo": {
            if (messageBackend === "codex") {
              throw new Error("Codex undo is not supported in Lunel yet");
            }
            const msgs = messagesMap[ensured] || [];
            const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
            if (lastUserMsg) await ai.revert(ensured, lastUserMsg.id, messageBackend);
            break;
          }
          case "redo":
            if (messageBackend === "codex") {
              throw new Error("Codex redo is not supported in Lunel yet");
            }
            await ai.unrevert(ensured, messageBackend);
            break;
          case "abort":
            await ai.abort(ensured, messageBackend);
            setStreamingBySession((prev) => {
              if (!prev[ensured]) return prev;
              const next = { ...prev };
              delete next[ensured];
              return next;
            });
            break;
          case "init":
            if (messageBackend === "codex") {
              throw new Error("Codex init is not supported in Lunel yet");
            }
            await ai.runCommand(ensured, "init", messageBackend);
            break;
          default:
            await ai.sendPrompt(
              ensured,
              text,
              getModelRef(),
              selectedAgentForBackend,
              messageBackend,
              undefined,
              getCodexPromptOptions(),
            );
            setSessionActivityLabels((prev) => ({ ...prev, [ensured]: "Thinking..." }));
            setStreamingBySession((prev) => ({ ...prev, [ensured]: true }));
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
      if (displayText) {
        optimisticParts.push({ type: "text", text: displayText } as AIPart);
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
      const optimisticBucketId = sessId ?? localDraftTabId;
      if (!optimisticBucketId) {
        Alert.alert("Error", "Failed to prepare AI session");
        return;
      }
      setMessagesMap((prev) => ({
        ...prev,
        [optimisticBucketId]: [...(prev[optimisticBucketId] || []), optimisticMsg],
      }));
      scrollToLatest(true, true);

      const ensured = await ensureSession();
      if (!ensured) {
        setMessagesMap((prev) => ({
          ...prev,
          [optimisticBucketId]: (prev[optimisticBucketId] || []).filter((msg) => msg.id !== optimisticMessageId),
        }));
        return;
      }
      markSessionAsUserActive(ensured, messageBackend);

      await ai.sendPrompt(
        ensured,
        text,
        getModelRef(),
        selectedAgentForBackend,
        messageBackend,
        pendingImage ? [pendingImage] : undefined,
        getCodexPromptOptions(),
      );
      setMessagesMap((prev) => {
        const committedBucketId = ensured;
        const sessionMessages = prev[committedBucketId] || [];
        const idx = sessionMessages.findIndex((m) => m.id === optimisticMessageId);
        if (idx < 0) return prev;
        const updated = [...sessionMessages];
        const existing = updated[idx];
        if (!existing) return prev;
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
        return { ...prev, [committedBucketId]: updated };
      });
      setSessionActivityLabels((prev) => ({ ...prev, [ensured]: "Thinking..." }));
      setStreamingBySession((prev) => ({ ...prev, [ensured]: true }));
      setPendingImage(null);
    } catch (err) {
      const fallbackBucketId = sessId ?? localDraftTabId;
      if (fallbackBucketId) {
        setMessagesMap((prev) => ({
          ...prev,
          [fallbackBucketId]: (prev[fallbackBucketId] || []).filter((msg) => !msg.id.startsWith("opt-")),
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

  const loadWorkspaceFiles = useCallback(async () => {
    if (workspaceFilesLoading) return;
    setWorkspaceFilesLoading(true);
    const IGNORED = new Set(["node_modules", ".git", ".next", "dist", "build", ".expo", "__pycache__", ".DS_Store"]);
    const paths: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 5) return;
      try {
        const entries = await fs.list(dir);
        for (const entry of entries) {
          const fullPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (IGNORED.has(entry.name)) continue;
          if (entry.type === "file") {
            paths.push(fullPath);
          } else if (entry.type === "directory") {
            await walk(fullPath, depth + 1);
          }
        }
      } catch {}
    };
    await walk(".", 0);
    setAllWorkspaceFiles(paths);
    setWorkspaceFilesLoading(false);
  }, [fs, workspaceFilesLoading]);

  // Pre-load workspace files when connected
  useEffect(() => {
    if (status === "connected" && allWorkspaceFiles.length === 0 && !workspaceFilesLoading) {
      loadWorkspaceFiles();
    }
  }, [status, allWorkspaceFiles.length, workspaceFilesLoading, loadWorkspaceFiles]);

  const handleInputChange = useCallback((text: string) => {
    setInputText(text);
    if (text.length === 0) {
      animateInputHeight(52);
      setAtMentionActive(false);
      setAtMentionQuery("");
      return;
    }
    const atIdx = text.lastIndexOf("@");
    if (atIdx !== -1) {
      const afterAt = text.slice(atIdx + 1);
      if (!afterAt.includes(" ") && !afterAt.includes("\n")) {
        if (allWorkspaceFiles.length === 0) loadWorkspaceFiles();
        setAtMentionQuery(afterAt);
        setAtMentionActive(true);
        return;
      }
    }
    setAtMentionActive(false);
    setAtMentionQuery("");
  }, [animateInputHeight, allWorkspaceFiles, loadWorkspaceFiles]);

  const selectFileMention = useCallback((filePath: string) => {
    const fileName = filePath.split("/").pop() ?? filePath;
    setInputText((prev) => {
      const atIdx = prev.lastIndexOf("@");
      if (atIdx === -1) return prev;
      return prev.slice(0, atIdx) + `@${fileName} `;
    });
    setAtMentionActive(false);
    setAtMentionQuery("");
  }, []);

  const removeTaggedFile = useCallback((path: string) => {
    setTaggedFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const enterVoiceMode = useCallback(async () => {
    if (isVoiceBusy) return;
    setShowMoreOptions(false);
    setShowCodexReasoningMenu(false);
    setShowCodexSpeedMenu(false);
    setShowCodexPermissionMenu(false);
    setShowCodexContextUsageMenu(false);
    setIsVoiceMode(true);
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
        setIsVoiceMode(false);
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
    } catch (err) {
      console.error("Voice recording start error:", err);
      setIsVoiceMode(false);
      Alert.alert("Voice Input", "Failed to start recording.");
      resetEqualizer();
    }
  }, [
    animateInputHeight,
    isVoiceBusy,
    resetEqualizer,
    updateEqualizer,
  ]);

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
      setStreamingBySession((prev) => {
        if (!prev[activeSessionId]) return prev;
        const next = { ...prev };
        delete next[activeSessionId];
        return next;
      });
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
    const shouldShowThinking = isActiveSessionStreaming;
    if (shouldShowThinking) {
      items.push({ type: "thinking", id: "thinking-indicator", label: activeSessionActivityLabel });
    }
    for (let i = 0; i < currentErrors.length; i++) {
      items.push({ type: "error", data: currentErrors[i], id: `err-${i}` });
    }
    return items;
  }, [currentMessages, currentErrors, isActiveSessionStreaming, activeSessionId, activeSessionActivityLabel]);

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

  const handleDetailedViewAction = useCallback(() => {
    setShowDetailedView((prev) => !prev);
  }, []);

  const handleDeleteActiveSession = useCallback(() => {
    if (!activeTab) return;
    void closeTab(activeTab.id);
  }, [activeTab, closeTab]);

  const hasContent = listData.length > 0;
  const messagesBottomInset = 16;

  useEffect(() => {
    if (!hasContent) return;
    if (!isNearBottomRef.current) return;
    scrollToLatest(false);
  }, [messagesBottomInset, hasContent, scrollToLatest]);

  useEffect(() => {
    // Only register persisted sessions in the sidebar. Draft tabs should stay local
    // to the panel until the user actually sends the first prompt.
    const sessionItems = tabs
      .filter((t) => !!t.sessionId)
      .map((t) => ({ id: t.id, title: t.title, backend: t.backend }));
    register('ai', {
      sessions: sessionItems,
      activeSessionId: tabs.some((t) => t.id === activeTabId && !!t.sessionId) ? activeTabId : null,
      loading: status === 'connected' && (!isInitialized || isInitialSessionsLoading),
      onSessionPress: handleTabPress,
      onSessionClose: deleteTab,
      onSessionRename: renameTab,
      onCreateSession: createNewTab,
    });
  }, [tabs, activeTabId, status, isInitialized, isInitialSessionsLoading, register, handleTabPress, deleteTab, renameTab, createNewTab]);

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
      <InfoSheet
        visible={backendPickerVisible}
        onClose={() => setBackendPickerVisible(false)}
        title="New Session"
        description="Choose an AI backend to start a new session"
      >
        <View style={{ gap: 6, paddingBottom: 80 }}>
          {[
            { backend: "codex" as const, label: "Codex", description: "OpenAI Codex CLI", Icon: Codex },
            { backend: "opencode" as const, label: "OpenCode", description: "The open source AI coding agent", Icon: OpenCode },
            { label: "Claude Code", description: "Coming soon", disabled: true, Icon: ClaudeCode },
          ].map(({ backend, label, description, disabled, Icon }) => (
            <TouchableOpacity
              key={backend ?? label}
              onPress={() => {
                if (!disabled && backend) void createNewTabWithBackend(backend);
              }}
              activeOpacity={disabled ? 1 : 0.75}
              style={[styles.backendOption, {
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 0,
                backgroundColor: disabled ? colors.bg.base : "transparent",
                borderRadius: 10,
                opacity: disabled ? 0.55 : 1,
              }]}
            >
              <Icon size={24} color={colors.fg.default} />
              <View>
                <Text style={{ color: colors.fg.default, fontSize: typography.body, fontFamily: fonts.sans.medium }}>
                  {label}
                </Text>
                <Text style={{ color: colors.fg.muted, fontSize: typography.caption, fontFamily: fonts.sans.regular, marginTop: 1 }}>
                  {description}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </InfoSheet>

      {/* Header */}
      <Header
        title={
          activeTab
            ? formatBackendSessionTitle(activeTab.backend, activeTab.title)
            : pendingBackend
              ? formatBackendSessionTitle(pendingBackend)
              : "AI"
        }
        colors={colors}
        showBottomBorder={tabs.length > 0}
        rightAccessory={(
          <View style={styles.headerMenuWrapper}>
            <MenuView
              shouldOpenOnLongPress={false}
              preferredMenuAnchorPosition="bottom"
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
        ) : tabs.length === 0 && !pendingBackend ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 20,
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
              <AISkeleton colors={colors} paddingTop={0} />
            ) : hasContent ? (
              <FlashList
                ref={messagesListRef}
                data={listData}
                keyExtractor={(item) => item.type === "message" ? item.data.id : item.id}
                renderItem={renderListItem}
                estimatedItemSize={140}
                style={{ flex: 1 }}
                indicatorStyle="default"
                onLayout={(e) => {
                  listViewportHeightRef.current = e.nativeEvent.layout.height;
                }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingTop: 18,
                  paddingBottom: messagesBottomInset,
                }}
                onContentSizeChange={(_, contentHeight) => {
                  contentHeightRef.current = contentHeight;
                  const grew = contentHeight > lastContentHeightRef.current;
                  if (grew && isActiveSessionStreaming && isNearBottomRef.current) {
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
                  if (!nearBottom && isActiveSessionStreaming && userDraggingMessagesRef.current) {
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
              <Pressable style={{ flex: 1 }} onPress={() => { inputRef.current?.blur(); Keyboard.dismiss(); }}>
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


            {/* Composer */}
            <LinearGradient
              colors={[colors.bg.base + "1a", colors.bg.base + "ff"]}
              style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: composerBottomOffset + 24 }}
              pointerEvents="none"
            />
            {/* @ file mention dropdown */}
            {atMentionActive && (() => {
              const query = atMentionQuery.toLowerCase();
              const filtered = allWorkspaceFiles.filter((p) => p.toLowerCase().includes(query));
              if (!workspaceFilesLoading && filtered.length === 0) return null;
              return (
                <View style={{
                  position: "absolute",
                  bottom: composerBottomOffset + 18,
                  left: 8,
                  right: 8,
                  backgroundColor: colors.bg.raised,
                  borderRadius: 10,
                  borderWidth: 0.5,
                  borderColor: colors.border.secondary,
                  zIndex: 1000,
                  maxHeight: 260,
                  paddingVertical: 6,
                  shadowColor: "#000",
                  shadowOpacity: 0.15,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: -2 },
                }}>
                  {workspaceFilesLoading && filtered.length === 0 ? (
                    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10 }}>
                      <ActivityIndicator size="small" color={colors.fg.subtle} />
                      <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: 13 }}>Loading files...</Text>
                    </View>
                  ) : (
                    <ScrollView
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={true}
                      style={{ borderRadius: 10 }}
                    >
                      {filtered.map((filePath) => {
                        const parts = filePath.split("/");
                        const fileName = parts.pop() ?? filePath;
                        const dir = parts.join("/");
                        return (
                          <TouchableOpacity
                            key={filePath}
                            onPress={() => selectFileMention(filePath)}
                            activeOpacity={0.7}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              marginHorizontal: 6,
                              marginVertical: 2,
                              paddingHorizontal: 10,
                              paddingVertical: 9,
                              gap: 10,
                              borderRadius: 8,
                              backgroundColor: colors.bg.elevated + "60",
                            }}
                          >
                            <File size={14} color={colors.fg.subtle} />
                            <Text style={{ flex: 1, fontFamily: fonts.sans.regular, fontSize: 13 }} numberOfLines={1}>
                              <Text style={{ color: colors.fg.default }}>{fileName}</Text>
                              {dir ? <Text style={{ color: colors.fg.subtle, fontSize: typography.caption }}>{`  •  ${dir}`}</Text> : null}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              );
            })()}
            <View style={{ position: "relative" }}>
            {!isVoiceMode ? (
            <GestureDetector gesture={swipeDownGesture}>
            <Animated.View
              pointerEvents="auto"
              style={[
                styles.inputContainer,
                {
                  backgroundColor: colors.bg.raised,
                  borderColor: colors.border.main,
                  borderRadius: 12,
                  borderCurve: 'continuous',
                  zIndex: showAttachMenu ? 200 : 10,
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
                placeholder="Ask, Plan, @ for file context"
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
                <View
                  style={{
                    marginTop: 8,
                    marginBottom: 4,
                    alignSelf: "flex-start",
                    borderRadius: radius.lg,
                    overflow: "hidden",
                  }}
                >
                  <View style={{ position: "relative" }}>
                    <Image
                      source={{ uri: pendingImage.url }}
                      style={{ width: 88, height: 88, borderRadius: radius.lg, backgroundColor: colors.bg.raised }}
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
                </View>
              ) : null}

              <View style={styles.composerBottomBar}>
                {showAttachMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowAttachMenu(false)}
                  />
                )}
                {showModeMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowModeMenu(false)}
                  />
                )}
                {showCodexReasoningMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowCodexReasoningMenu(false)}
                  />
                )}
                {showCodexSpeedMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowCodexSpeedMenu(false)}
                  />
                )}
                {showCodexPermissionMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowCodexPermissionMenu(false)}
                  />
                )}
                {showCodexContextUsageMenu && (
                  <Pressable
                    style={{ position: "absolute", top: -9999, left: -9999, right: -9999, bottom: -9999, zIndex: 998 }}
                    onPress={() => setShowCodexContextUsageMenu(false)}
                  />
                )}
                {showModeMenu && agents.length > 0 && (
                  <View style={{
                    position: "absolute",
                    bottom: "100%",
                    marginBottom: 8,
                    backgroundColor: colors.bg.raised,
                    borderRadius: 8,
                    borderWidth: 0.5,
                    borderColor: colors.border.secondary,
                    paddingVertical: 5,
                    paddingHorizontal: 5,
                    minWidth: 130,
                    zIndex: 999,
                    ...getDropdownHorizontalPosition(modeMenuAnchor, 130),
                  }}>
                    <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.medium, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6 }}>Modes</Text>
                    {agents.map((agent) => {
                      const isSelected = selectedAgent === agent.id;
                      return (
                        <TouchableOpacity
                          key={agent.id}
                          onPress={() => {
                            setSelectedAgentByBackend((prev) => ({ ...prev, [activeBackend]: agent.id }));
                            setShowModeMenu(false);
                          }}
                          activeOpacity={0.7}
                          style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 7, backgroundColor: isSelected ? colors.bg.elevated : "transparent", borderRadius: 5 }}
                        >
                          <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>{agent.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
                {showAttachMenu && (
                  <View style={{
                    position: "absolute",
                    bottom: "100%",
                    left: 0,
                    marginBottom: 8,
                    backgroundColor: colors.bg.raised,
                    borderRadius: 8,
                    borderWidth: 0.5,
                    borderColor: colors.border.secondary,
                    overflow: "hidden",
                    paddingVertical: 4,
                    minWidth: 150,
                    zIndex: 999,
                  }}>
                    <TouchableOpacity
                      onPress={handleAttachGallery}
                      activeOpacity={0.7}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 7 }}
                    >
                      <Foundation name="photo" size={15} color={colors.fg.default} />
                      <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>Select from Gallery</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleAttachCamera}
                      activeOpacity={0.7}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 7 }}
                    >
                      <Feather name="camera" size={14} color={colors.fg.default} />
                      <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>Take Photo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleAttachFile}
                      activeOpacity={0.7}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 7 }}
                    >
                      <Fontisto name="paperclip" size={13} color={colors.fg.default} />
                      <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>Choose File</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View pointerEvents={isVoiceMode ? "none" : "auto"} style={styles.composerRow}>
                  {/* Left group: attachment + model + codex prefs */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, overflow: "hidden" }}>
                    <TouchableOpacity
                      style={[styles.actionButton, { borderRadius: 8, overflow: "visible", flexShrink: 0, flexGrow: 0, backgroundColor: showAttachMenu ? colors.bg.elevated : "transparent" }]}
                      onPress={handleAttachment}
                      activeOpacity={0.7}
                      disabled={isVoiceBusy}
                    >
                      <Plus size={18} color={colors.fg.default} strokeWidth={2.4} style={{ opacity: 0.9 }} />
                    </TouchableOpacity>

                    {agents.length > 0 && (
                      <View
                        onLayout={(e) => {
                          const { x, width } = e.nativeEvent.layout;
                          setModeMenuAnchor({ x, width });
                        }}
                      >
                        <TouchableOpacity
                          style={[styles.modelButton, { borderColor: colors.border.secondary, flexShrink: 0, flexGrow: 0, backgroundColor: showModeMenu ? colors.bg.elevated : "transparent" }]}
                          onPress={() => setShowModeMenu(v => !v)}
                          activeOpacity={0.7}
                        >
                          <Text numberOfLines={1} style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}>
                            {selectedAgentName}
                          </Text>
                          <ChevronDown size={13} color={colors.fg.subtle} />
                        </TouchableOpacity>
                      </View>
                    )}

                    <TouchableOpacity
                      style={[styles.modelButton, { borderColor: colors.border.secondary, flexShrink: 1, flexGrow: 0, minWidth: 40, maxWidth: 90 }]}
                      onPress={() => setActiveSheet("configure")}
                      activeOpacity={0.7}
                      disabled={activeBackend !== "codex" && agents.length === 0 && modelOptions.length === 0}
                    >
                      <Text
                        numberOfLines={1}
                        style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                      >
                        {selectedModelName}
                      </Text>
                      <ChevronDown size={13} color={colors.fg.subtle} />
                    </TouchableOpacity>

                    {activeBackend === "codex" ? (
                      <TouchableOpacity
                        style={[styles.actionButton, { borderRadius: 6, backgroundColor: showMoreOptions ? colors.bg.elevated : "transparent" }]}
                        onPress={() => setShowMoreOptions(v => !v)}
                        activeOpacity={0.7}
                      >
                        <SlidersHorizontal size={18} color={colors.fg.default} style={{ opacity: 0.9 }} />
                      </TouchableOpacity>
                    ) : null}

                  </View>

                  {/* Right group: mic + send — never pushed out */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0, flexGrow: 0 }}>
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() => {
                        setAtMentionActive(false);
                        setAtMentionQuery("");
                        enterVoiceMode();
                      }}
                      disabled={isVoiceBusy}
                      activeOpacity={0.7}
                    >
                      <Mic size={18} color={colors.fg.default} style={{ opacity: 0.9 }} />
                    </TouchableOpacity>

                  {isActiveSessionStreaming ? (
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
                        backgroundColor: (inputText.trim() || pendingImage) ? colors.accent.default : colors.bg.base,
                        borderColor: "transparent",
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
              </View>

            </Animated.View>
            </GestureDetector>
            ) : null}

            {!isVoiceMode && activeBackend === "codex" && showMoreOptions && (
              <View style={{
                marginHorizontal: 8,
                marginBottom: 8,
                borderRadius: 12,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <View
                    style={{ position: "relative" }}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout;
                      setCodexReasoningAnchor({ x, width });
                    }}
                  >
                    {showCodexReasoningMenu && (
                      <View style={{
                        position: "absolute",
                        bottom: "100%",
                        marginBottom: 8,
                        backgroundColor: colors.bg.raised,
                        borderRadius: 8,
                        borderWidth: 0.5,
                        borderColor: colors.border.secondary,
                        paddingVertical: 5,
                        paddingHorizontal: 5,
                        minWidth: 130,
                        zIndex: 999,
                        ...getDropdownHorizontalPosition(codexReasoningAnchor, 130),
                      }}>
                        <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.medium, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6 }}>Reasoning</Text>
                        {reasoningOptions.map((option) => {
                          const isSelected = codexReasoningEffort === option.id;
                          return (
                            <TouchableOpacity
                              key={option.id}
                              onPress={() => {
                                setCodexReasoningEffort(option.id);
                                setShowCodexReasoningMenu(false);
                              }}
                              activeOpacity={0.7}
                              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 7, backgroundColor: isSelected ? colors.bg.elevated : "transparent", borderRadius: 5 }}
                            >
                              <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>{option.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        setShowCodexSpeedMenu(false);
                        setShowCodexPermissionMenu(false);
                        setShowCodexContextUsageMenu(false);
                        setShowCodexReasoningMenu((v) => !v);
                      }}
                      activeOpacity={0.7}
                      style={[styles.modelButton, { borderColor: colors.border.secondary, backgroundColor: "transparent", flexShrink: 0, flexGrow: 0 }]}
                    >
                      <Text numberOfLines={1} style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}>
                        {codexReasoningLabel}
                      </Text>
                      <ChevronDown size={13} color={colors.fg.subtle} />
                    </TouchableOpacity>
                  </View>

                  <View
                    style={{ position: "relative" }}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout;
                      setCodexSpeedAnchor({ x, width });
                    }}
                  >
                    {showCodexSpeedMenu && (
                      <View style={{
                        position: "absolute",
                        bottom: "100%",
                        marginBottom: 8,
                        backgroundColor: colors.bg.raised,
                        borderRadius: 8,
                        borderWidth: 0.5,
                        borderColor: colors.border.secondary,
                        paddingVertical: 5,
                        paddingHorizontal: 5,
                        minWidth: 130,
                        zIndex: 999,
                        ...getDropdownHorizontalPosition(codexSpeedAnchor, 130),
                      }}>
                        <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.medium, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6 }}>Speed</Text>
                        {speedOptions.map((option) => {
                          const isSelected = codexSpeed === option.id;
                          return (
                            <TouchableOpacity
                              key={option.id}
                              onPress={() => {
                                setCodexSpeed(option.id);
                                setShowCodexSpeedMenu(false);
                              }}
                              activeOpacity={0.7}
                              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 7, backgroundColor: isSelected ? colors.bg.elevated : "transparent", borderRadius: 5 }}
                            >
                              <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>{option.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        setShowCodexReasoningMenu(false);
                        setShowCodexPermissionMenu(false);
                        setShowCodexContextUsageMenu(false);
                        setShowCodexSpeedMenu((v) => !v);
                      }}
                      activeOpacity={0.7}
                      style={[styles.modelButton, { borderColor: colors.border.secondary, backgroundColor: "transparent", flexShrink: 0, flexGrow: 0 }]}
                    >
                      <Text numberOfLines={1} style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}>
                        {codexSpeedLabel}
                      </Text>
                      <ChevronDown size={13} color={colors.fg.subtle} />
                    </TouchableOpacity>
                  </View>

                  <View
                    style={{ position: "relative" }}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout;
                      setCodexPermissionAnchor({ x, width });
                    }}
                  >
                    {showCodexPermissionMenu && (
                      <View style={{
                        position: "absolute",
                        bottom: "100%",
                        marginBottom: 8,
                        backgroundColor: colors.bg.raised,
                        borderRadius: 8,
                        borderWidth: 0.5,
                        borderColor: colors.border.secondary,
                        paddingVertical: 5,
                        paddingHorizontal: 5,
                        minWidth: 150,
                        zIndex: 999,
                        ...getDropdownHorizontalPosition(codexPermissionAnchor, 150),
                      }}>
                        <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.medium, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6 }}>Permission</Text>
                        {permissionOptions.map((option) => {
                          const isSelected = codexPermissionMode === option.id;
                          return (
                            <TouchableOpacity
                              key={option.id}
                              onPress={() => {
                                setCodexPermissionMode(option.id);
                                setShowCodexPermissionMenu(false);
                              }}
                              activeOpacity={0.7}
                              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 7, backgroundColor: isSelected ? colors.bg.elevated : "transparent", borderRadius: 5 }}
                            >
                              <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.list }}>{option.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        setShowCodexReasoningMenu(false);
                        setShowCodexSpeedMenu(false);
                        setShowCodexContextUsageMenu(false);
                        setShowCodexPermissionMenu((v) => !v);
                      }}
                      activeOpacity={0.7}
                      style={[styles.modelButton, { borderColor: colors.border.secondary, backgroundColor: "transparent", flexShrink: 0, flexGrow: 0 }]}
                    >
                      <Text numberOfLines={1} style={[styles.modelText, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}>
                        {codexPermissionLabel}
                      </Text>
                      <ChevronDown size={13} color={colors.fg.subtle} />
                    </TouchableOpacity>
                  </View>

                  <View
                    style={{ position: "relative" }}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout;
                      setCodexContextUsageAnchor({ x, width });
                    }}
                  >
                    {showCodexContextUsageMenu && (
                      <View style={{
                        position: "absolute",
                        bottom: "100%",
                        marginBottom: 8,
                        backgroundColor: colors.bg.raised,
                        borderRadius: 8,
                        borderWidth: 0.5,
                        borderColor: colors.border.secondary,
                        paddingVertical: 5,
                        paddingHorizontal: 5,
                        minWidth: 190,
                        zIndex: 999,
                        ...getDropdownHorizontalPosition(codexContextUsageAnchor, 190),
                      }}>
                        <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.medium, fontSize: 11, paddingHorizontal: 10, paddingTop: 4 }}>
                          Context window:
                        </Text>
                        {codexContextUsage ? (
                          <>
                            <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.semibold, fontSize: 10, paddingHorizontal: 10, paddingTop: 8 }}>
                              {`${formatContextPercent(codexContextUsage.used, codexContextUsage.total)} (${Math.max(0, 100 - Math.round((codexContextUsage.used / codexContextUsage.total) * 100))}% left)`}
                            </Text>
                            <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: 10, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 8 }}>
                              {`${formatTokens(codexContextUsage.used)} / ${formatTokens(codexContextUsage.total)} tokens used`}
                            </Text>
                          </>
                        ) : (
                          <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: 10, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 }}>
                            Usage not available yet
                          </Text>
                        )}
                      </View>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        setShowCodexReasoningMenu(false);
                        setShowCodexSpeedMenu(false);
                        setShowCodexPermissionMenu(false);
                        setShowCodexContextUsageMenu((v) => !v);
                      }}
                      activeOpacity={0.7}
                      style={[styles.actionButton, { borderRadius: 6, backgroundColor: showCodexContextUsageMenu ? colors.bg.elevated : "transparent" }]}
                    >
                      <PieChart size={17} color={colors.fg.default} style={{ opacity: 0.9 }} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}

            </View>

            {showScrollToBottom && hasContent ? (
              <Animated.View
                entering={ZoomIn.duration(180)}
                exiting={ZoomOut.duration(140)}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: isVoiceMode ? 68 : composerBottomOffset + 18,
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
              modelOptions={modelOptions}
              selectedModelId={selectedModel}
              onSelectModel={(id) => {
                setSelectedModelByBackend((prev) => ({ ...prev, [activeBackend]: id }));
              }}
              onClose={() => setActiveSheet(null)}
              colors={colors}
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
    borderWidth: 0.5,
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
    marginHorizontal: -4,
    paddingHorizontal: 4,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderRadius: 10,
  },
  commandGroupHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  commandGroupIconFrame: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.4,
    borderRadius: 6,
    flexShrink: 0,
  },
  commandGroupBody: {
    marginTop: 4,
  },
  explorationGroupBody: {
    marginTop: 4,
  },
  groupListRowWrap: {
  },
  groupListRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },

  // Reasoning
  reasoningContainer: {
    marginVertical: 0,
  },
  reasoningHeader: {
  },
  reasoningHeaderLeft: {
  },
  reasoningBody: {
    padding: 10,
    borderWidth: 1,
    marginTop: 4,
    marginBottom: 4,
    marginHorizontal: -4,
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
    overflow: "hidden",
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
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 1.5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    overflow: "hidden",
  },
  modelText: {
    fontSize: 12,
    flexShrink: 1,
    minWidth: 0,
  },

  // Action buttons
  actionButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },

  // Input styles
  inputContainer: {
    marginHorizontal: 8,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
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
