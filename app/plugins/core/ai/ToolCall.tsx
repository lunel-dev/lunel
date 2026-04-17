import React, { useMemo, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SquaresSubtract } from "lucide-react-native";
import Svg, { Path } from "react-native-svg";
import { useEditorConfig } from "@/contexts/EditorContext";
import type { AIPart, AIPermission, PermissionResponse } from "./types";
import { looksLikeDiff, parseDiffChunks, classifyDiffLine } from "./diff";

const BOX_RADIUS = 8;

function InlineChevronIcon({ size = 14, color = "currentColor", expanded = false }: { size?: number; color?: string; expanded?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={expanded ? { transform: [{ rotate: "90deg" }] } : undefined}>
      <Path d="m9 6l6 6l-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function formatToolInput(input: unknown, toolName: string): string | null {
  if (!input) return null;
  if (typeof input === "string") return input;

  const obj = input as Record<string, unknown>;

  // Tool-specific formatting
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell")) {
    return (obj.command as string) || (obj.cmd as string) || JSON.stringify(obj, null, 2);
  }
  if (lower.includes("read")) {
    return (obj.path as string) || (obj.file_path as string) || (obj.filePath as string) || JSON.stringify(obj, null, 2);
  }
  if (lower.includes("write") || lower.includes("edit")) {
    const path = (obj.path as string) || (obj.file_path as string) || (obj.filePath as string) || "";
    return path || JSON.stringify(obj, null, 2);
  }
  if (lower.includes("glob") || lower.includes("grep") || lower.includes("search")) {
    const pattern = (obj.pattern as string) || (obj.query as string) || "";
    const path = (obj.path as string) || "";
    return pattern ? `${pattern}${path ? ` in ${path}` : ""}` : JSON.stringify(obj, null, 2);
  }

  return JSON.stringify(obj, null, 2);
}

function formatToolOutput(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return null;
    // Truncate very long outputs
    if (trimmed.length > 2000) {
      return trimmed.slice(0, 2000) + "\n... (truncated)";
    }
    return trimmed;
  }
  if (typeof output === "object" && !Array.isArray(output) && Object.keys(output as Record<string, unknown>).length === 0) {
    return null;
  }
  const str = JSON.stringify(output, null, 2);
  if (!str || str === "{}" || str === "[]") {
    return null;
  }
  if (str.length > 2000) {
    return str.slice(0, 2000) + "\n... (truncated)";
  }
  return str;
}

function extractCommandPreview(input: unknown): string | null {
  if (!input) return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed || null;
  }

  const obj = input as Record<string, unknown>;
  const command = [obj.command, obj.cmd, obj.raw_command, obj.rawCommand, obj.invocation, obj.input]
    .find((value) => typeof value === "string" && value.trim());

  return typeof command === "string" ? command.trim() : null;
}

function isCommandLikeTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "command"
    || normalized.includes("bash")
    || normalized.includes("shell")
    || normalized.includes("terminal")
    || normalized.includes("exec");
}

function DiffViewer({
  outputText,
  colors,
  fonts,
  radius,
}: {
  outputText: string;
  colors: any;
  fonts: any;
  radius: any;
}) {
  const chunks = useMemo(() => parseDiffChunks(outputText), [outputText]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(chunks.map((chunk) => chunk.id)));

  if (chunks.length === 0) return null;

  return (
    <View style={styles.diffList}>
      {chunks.map((chunk) => {
        const expanded = expandedIds.has(chunk.id);
        const actionColor = chunk.action === "added"
          ? '#22c55e'
          : chunk.action === "deleted"
            ? '#ef4444'
            : chunk.action === "renamed"
              ? colors.accent.default
              : colors.fg.default;

        return (
          <View
            key={chunk.id}
            style={[styles.diffCard, { backgroundColor: colors.bg.base, borderRadius: BOX_RADIUS, borderColor: colors.bg.raised }]}
          >
            <TouchableOpacity
              onPress={() => {
                setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(chunk.id)) next.delete(chunk.id);
                  else next.add(chunk.id);
                  return next;
                });
              }}
              activeOpacity={0.7}
              style={styles.diffCardHeader}
            >
              <View style={styles.diffCardTitleRow}>
                <InlineChevronIcon size={14} color={colors.fg.muted} expanded={expanded} />
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, color: colors.fg.default, fontSize: 12, fontFamily: fonts.mono.regular }}
                >
                  {chunk.path}
                </Text>
              </View>
              <View style={styles.diffTotals}>
                <Text style={{ color: actionColor, fontSize: 10, fontFamily: fonts.mono.regular }}>
                  {chunk.action}
                </Text>
                {chunk.additions > 0 ? (
                  <Text style={{ color: '#22c55e', fontSize: 10, fontFamily: fonts.mono.regular }}>
                    +{chunk.additions}
                  </Text>
                ) : null}
                {chunk.deletions > 0 ? (
                  <Text style={{ color: '#ef4444', fontSize: 10, fontFamily: fonts.mono.regular }}>
                    -{chunk.deletions}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>

            {expanded ? (
              <View style={[styles.diffCodeWrap, { borderTopColor: colors.bg.raised }]}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  bounces={false}
                  contentContainerStyle={styles.diffScrollContent}
                >
                  <View style={styles.diffCodeContent}>
                    {chunk.diffCode.split("\n").map((line, index) => {
                      const kind = classifyDiffLine(line);
                      const textColor = kind === "addition"
                        ? '#22c55e'
                        : kind === "deletion"
                          ? '#ef4444'
                          : kind === "hunk"
                            ? colors.fg.subtle
                            : kind === "meta"
                              ? colors.fg.muted
                              : colors.fg.default;
                      const backgroundColor = kind === "addition"
                        ? `${'#22c55e'}1A`
                        : kind === "deletion"
                          ? `${'#ef4444'}1A`
                          : "transparent";

                      if (kind === "meta") {
                        return null;
                      }

                      return (
                        <View
                          key={`${chunk.id}:${index}`}
                          style={[styles.diffLineRow, { backgroundColor }]}
                        >
                          <View
                            style={[
                              styles.diffIndicator,
                              {
                                backgroundColor: kind === "addition"
                                  ? '#22c55e'
                                  : kind === "deletion"
                                    ? '#ef4444'
                                    : "transparent",
                              },
                            ]}
                          />
                          <Text
                            selectable
                            style={{ color: textColor, fontSize: 11, fontFamily: fonts.mono.regular, lineHeight: 16, paddingHorizontal: 10, paddingVertical: 1, minWidth: "100%" as any }}
                          >
                            {line || " "}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

interface ToolCallProps {
  part: AIPart;
  colors: any;
  fonts: any;
  radius: any;
  permission?: AIPermission | null;
  onPermissionReply?: (response: PermissionResponse) => void;
  compactCommandRow?: boolean;
}

export default function ToolCall({
  part,
  colors,
  fonts,
  radius,
  permission,
  onPermissionReply,
  compactCommandRow = false,
}: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const { config } = useEditorConfig();

  const toolName = (part.name as string) || (part.toolName as string) || "tool";
  const commandPreview = isCommandLikeTool(toolName) ? extractCommandPreview(part.input) : null;
  const isCommandRow = !!commandPreview;
  const headerLabel = commandPreview || toolName;
  const state = (part.state as string) || "running";
  const bodyFontSize = config.aiFontSize;

  const isError = state === "error";
  const isCompleted = state === "completed";
  const inputText = isCommandRow ? null : formatToolInput(part.input, toolName);
  const outputText = formatToolOutput(part.output);
  const showDiffViewer = !!outputText && looksLikeDiff(outputText);
  const canExpand = Boolean(
    inputText
    || outputText
    || (isError && part.error != null)
    || permission
  );

  const statusColor = isError
    ? '#ef4444'
    : isCompleted
    ? '#22c55e'
    : colors.accent.default;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={canExpand ? () => setExpanded(!expanded) : undefined}
        style={[
          styles.header,
          isCommandRow && expanded ? styles.headerExpandedTop : undefined,
          isCommandRow && compactCommandRow ? styles.compactCommandHeader : undefined,
        ]}
        activeOpacity={canExpand ? 0.7 : 1}
      >
        <View style={[styles.headerLeft, isCommandRow && expanded ? styles.headerLeftTop : undefined]}>
          <View style={[styles.iconFrame, { borderColor: `${colors.fg.subtle}4D` }]}>
            <SquaresSubtract size={15} color={colors.fg.muted} strokeWidth={2} />
          </View>
          {isCommandRow ? (
            <View
              style={[
                styles.commandPill,
                compactCommandRow ? styles.commandPillCompact : undefined,
                expanded ? styles.commandPillTop : undefined,
              ]}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                bounces={false}
                contentContainerStyle={styles.commandScrollContent}
              >
                <Text
                  style={[
                    styles.toolName,
                    { color: colors.fg.default, fontFamily: fonts.mono.regular, fontSize: bodyFontSize },
                  ]}
                  numberOfLines={expanded ? undefined : 1}
                >
                  {headerLabel}
                </Text>
              </ScrollView>
            </View>
          ) : (
            <View style={styles.toolTextWrap}>
              <Text
                style={[
                  styles.toolName,
                  { color: colors.fg.default, fontFamily: fonts.mono.regular, fontSize: bodyFontSize },
                ]}
                numberOfLines={1}
              >
                {headerLabel}
              </Text>
            </View>
          )}
        </View>
        {canExpand ? <InlineChevronIcon size={14} color={colors.fg.muted} expanded={expanded} /> : null}
      </TouchableOpacity>

      {expanded && canExpand && (
        <View
          style={[
            styles.body,
              {
                borderWidth: isCommandRow ? 0 : 1,
                borderColor: colors.bg.raised,
                borderLeftWidth: isCommandRow ? 0 : 3,
                borderLeftColor: isCommandRow ? colors.bg.raised : statusColor,
                borderRadius: BOX_RADIUS,
                backgroundColor: colors.bg.raised,
              },
            ]}
        >
          {/* Input */}
          {!isCommandRow && inputText && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.medium }]}>
                Input
              </Text>
              <View
                style={[
                  styles.monoBox,
                  { backgroundColor: colors.bg.base, borderRadius: BOX_RADIUS },
                ]}
              >
                <Text
                  style={[
                    styles.sectionContent,
                    { color: colors.fg.muted, fontFamily: fonts.mono.regular },
                  ]}
                  selectable
                >
                  {inputText}
                </Text>
              </View>
            </View>
          )}

          {/* Output */}
          {outputText && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.medium }]}>
                Output
              </Text>
              {showDiffViewer ? (
                <DiffViewer outputText={outputText} colors={colors} fonts={fonts} radius={radius} />
              ) : (
                <View
                  style={[
                    styles.monoBox,
                    { backgroundColor: colors.bg.base, borderRadius: BOX_RADIUS },
                  ]}
                >
                  <Text
                    style={[
                      styles.sectionContent,
                      { color: colors.fg.muted, fontFamily: fonts.mono.regular },
                    ]}
                    selectable
                  >
                    {outputText}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Error */}
          {isError && part.error != null && (
            <View style={[styles.errorBlock, { backgroundColor: '#ef444420', borderRadius: BOX_RADIUS }]}>
              <Text style={{ color: '#ef4444', fontFamily: fonts.mono.regular, fontSize: 11 }}>
                {String(part.error)}
              </Text>
            </View>
          )}

          {/* Inline Permission */}
          {permission && (
            <View style={[styles.permissionBlock, { backgroundColor: colors.bg.raised, borderRadius: BOX_RADIUS }]}>
              <Text style={{ color: colors.fg.default, fontSize: 12, fontFamily: fonts.sans.medium, marginBottom: 6 }}>
                Permission Required
              </Text>
              <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.mono.regular, marginBottom: 10 }}>
                {permission.title || permission.type}
              </Text>
              <View style={styles.permissionButtons}>
                <TouchableOpacity
                  onPress={() => onPermissionReply?.("reject")}
                  style={[styles.permButton, { backgroundColor: colors.bg.raised, borderRadius: BOX_RADIUS }]}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: colors.fg.default, fontSize: 12, fontFamily: fonts.sans.medium }}>Deny</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onPermissionReply?.("always")}
                  style={[styles.permButton, { backgroundColor: colors.bg.raised, borderRadius: BOX_RADIUS }]}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: colors.fg.default, fontSize: 12, fontFamily: fonts.sans.medium }}>Always</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onPermissionReply?.("once")}
                  style={[styles.permButton, { backgroundColor: colors.accent.default, borderRadius: BOX_RADIUS }]}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: fonts.sans.medium }}>Allow</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    paddingVertical: 4,
    gap: 8,
  },
  compactCommandHeader: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
    flex: 1,
  },
  headerExpandedTop: {
    alignItems: "flex-start",
  },
  headerLeftTop: {
    alignItems: "center",
  },
  commandPill: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    overflow: "hidden",
  },
  commandPillCompact: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  commandPillTop: {
    alignItems: "flex-start",
  },
  commandScrollContent: {
    flexGrow: 1,
    paddingRight: 2,
  },
  toolTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  iconFrame: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.4,
    borderRadius: 6,
    flexShrink: 0,
  },
  toolName: {
    fontSize: 12,
  },
  body: {
    padding: 10,
    gap: 8,
    marginTop: 3,
  },
  diffList: {
    gap: 8,
  },
  diffCard: {
    borderWidth: 1,
    overflow: "hidden",
  },
  diffCardHeader: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  diffCardTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  diffTotals: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  diffCodeWrap: {
    borderTopWidth: 1,
    paddingVertical: 4,
  },
  diffLineRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  diffScrollContent: {
    minWidth: "100%",
  },
  diffCodeContent: {
    minWidth: "100%",
  },
  diffIndicator: {
    width: 2,
  },
  section: {
    gap: 4,
  },
  sectionLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  monoBox: {
    overflow: "hidden",
  },
  sectionContent: {
    fontSize: 12,
    lineHeight: 18,
    padding: 8,
  },
  errorBlock: {
    padding: 8,
  },
  permissionBlock: {
    padding: 10,
    marginTop: 4,
  },
  permissionButtons: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end",
  },
  permButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
});
