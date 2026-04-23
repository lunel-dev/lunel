import { FlashList, type FlashListRef } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "@/contexts/ThemeContext";
import { Check, ChevronDown, ChevronRight, Copy, MousePointerClick, Plus, RefreshCw, SquarePen, X } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import {
  DevsoleElementsAttribute,
  DevsoleElementsChildNode,
  DevsoleElementsSnapshot,
  DevsoleElementsStyleProperty,
} from "./types";

type TreeNode = {
  path: string;
  depth: number;
  label: string;
  nodeType: DevsoleElementsChildNode["nodeType"];
  childCount: number;
  hasChildren: boolean;
  textPreview?: string | null;
};

function fallbackFromSnapshot(snapshot: DevsoleElementsSnapshot): DevsoleElementsChildNode {
  return {
    path: snapshot.path,
    label: snapshot.label,
    nodeType: snapshot.nodeType,
    childCount: snapshot.childCount,
    hasChildren: snapshot.childCount > 0,
    textPreview: snapshot.textPreview,
  };
}

function buildTreeRows(
  root: DevsoleElementsSnapshot | null,
  snapshotsByPath: Record<string, DevsoleElementsSnapshot>,
  expandedPaths: Set<string>,
  depth = 0,
  node?: DevsoleElementsChildNode
): TreeNode[] {
  if (!root) return [];

  const currentNode = node || fallbackFromSnapshot(root);
  if (currentNode.nodeType !== "element") {
    return [];
  }
  const rows: TreeNode[] = [
    {
      path: currentNode.path,
      depth,
      label: currentNode.label,
      nodeType: currentNode.nodeType,
      childCount: currentNode.childCount,
      hasChildren: currentNode.hasChildren,
      textPreview: currentNode.textPreview,
    },
  ];

  if (!expandedPaths.has(currentNode.path)) {
    return rows;
  }

  root.children.forEach((child) => {
    if (child.nodeType !== "element") {
      return;
    }

    const childSnapshot = snapshotsByPath[child.path];
    if (childSnapshot) {
      rows.push(
        ...buildTreeRows(
          childSnapshot,
          snapshotsByPath,
          expandedPaths,
          depth + 1,
          child
        )
      );
      return;
    }

    rows.push({
      path: child.path,
      depth: depth + 1,
      label: child.label,
      nodeType: child.nodeType,
      childCount: child.childCount,
      hasChildren: child.hasChildren,
      textPreview: child.textPreview,
    });
  });

  return rows;
}

function TreeRow({
  item,
  expanded,
  selected,
  onPress,
  onOpenDetail,
  onToggleExpand,
}: {
  item: TreeNode;
  expanded: boolean;
  selected: boolean;
  onPress: () => void;
  onOpenDetail: () => void;
  onToggleExpand: () => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const indent = 16 + item.depth * 14;
  const guideLevels = Array.from({ length: item.depth });

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        position: "relative",
        minHeight: 36,
        paddingLeft: indent,
        paddingRight: 14,
        paddingVertical: 6,
        backgroundColor: selected ? colors.bg.raised : "transparent",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      {guideLevels.map((_, index) => (
        <View
          key={`${item.path}-guide-${index}`}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 15 + index * 14,
            width: 0.5,
            backgroundColor: colors.border.secondary,
          }}
        />
      ))}

      {item.hasChildren ? (
        <TouchableOpacity
          onPress={onToggleExpand}
          activeOpacity={0.85}
          style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}
        >
          {expanded ? (
            <ChevronDown size={12} color={colors.fg.subtle} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} color={colors.fg.subtle} strokeWidth={2} />
          )}
        </TouchableOpacity>
      ) : (
        <View style={{ width: 16 }} />
      )}

      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{
            color: colors.fg.default,
            fontSize: 11,
            lineHeight: 15,
            fontFamily: fonts.mono.regular,
          }}
        >
          {item.label}
        </Text>
        {item.textPreview ? (
          <Text
            numberOfLines={1}
            style={{
              color: colors.fg.muted,
              fontSize: 10,
              lineHeight: 14,
              fontFamily: fonts.mono.regular,
            }}
          >
            {item.textPreview}
          </Text>
        ) : null}
      </View>

      {item.hasChildren ? (
        <Text style={{ color: colors.fg.muted, fontSize: 9, fontFamily: fonts.mono.regular }}>
          {item.childCount}
        </Text>
      ) : null}

      <TouchableOpacity onPress={onOpenDetail} activeOpacity={0.7} style={{ padding: 4 }}>
        <SquarePen size={13} color={colors.fg.subtle} strokeWidth={2} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function ElementDetailSheet({
  snapshot,
  textDraft,
  onChangeTextDraft,
  attributeRows,
  onChangeAttributeRow,
  onAddAttributeRow,
  styleRows,
  onChangeStyleRow,
  onAddStyleRow,
  onClose,
  onSaveText,
  onSaveAttributeRow,
  onSaveStyleRow,
}: {
  snapshot: DevsoleElementsSnapshot | null;
  textDraft: string;
  onChangeTextDraft: (value: string) => void;
  attributeRows: DevsoleElementsAttribute[];
  onChangeAttributeRow: (index: number, field: "name" | "value", value: string) => void;
  onAddAttributeRow: () => void;
  styleRows: DevsoleElementsStyleProperty[];
  onChangeStyleRow: (index: number, field: "name" | "value", value: string) => void;
  onAddStyleRow: () => void;
  onClose: () => void;
  onSaveText: () => void;
  onSaveAttributeRow: (index: number) => void;
  onSaveStyleRow: (index: number) => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const attributeNameRefs = useRef<Record<number, TextInput | null>>({});
  const styleNameRefs = useRef<Record<number, TextInput | null>>({});
  const previousAttributeLengthRef = useRef(attributeRows.length);
  const previousStyleLengthRef = useRef(styleRows.length);
  const [pendingFocusTarget, setPendingFocusTarget] = useState<null | "attribute" | "style">(null);
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(windowHeight);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (snapshot) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = windowHeight;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
      return;
    }

    if (!modalVisible) return;

    backdropOpacity.value = withTiming(0, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
    sheetTranslateY.value = withTiming(
      windowHeight,
      {
        duration: 240,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (finished) runOnJS(hideModal)();
      }
    );
  }, [snapshot, modalVisible, backdropOpacity, hideModal, sheetTranslateY, windowHeight]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  useEffect(() => {
    const previousLength = previousAttributeLengthRef.current;
    previousAttributeLengthRef.current = attributeRows.length;

    if (pendingFocusTarget !== "attribute" || attributeRows.length <= previousLength) {
      return;
    }

    const nextIndex = attributeRows.length - 1;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      setTimeout(() => {
        attributeNameRefs.current[nextIndex]?.focus();
      }, 80);
    });
    setPendingFocusTarget(null);
  }, [attributeRows.length, pendingFocusTarget]);

  useEffect(() => {
    const previousLength = previousStyleLengthRef.current;
    previousStyleLengthRef.current = styleRows.length;

    if (pendingFocusTarget !== "style" || styleRows.length <= previousLength) {
      return;
    }

    const nextIndex = styleRows.length - 1;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
      setTimeout(() => {
        styleNameRefs.current[nextIndex]?.focus();
      }, 80);
    });
    setPendingFocusTarget(null);
  }, [styleRows.length, pendingFocusTarget]);

  if (!modalVisible) return null;

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0,0,0,0.5)",
            },
            backdropAnimatedStyle,
          ]}
          pointerEvents="box-none"
        >
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            {
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              height: "76%",
              backgroundColor: colors.bg.raised,
              borderTopLeftRadius: radius["2xl"],
              borderTopRightRadius: radius["2xl"],
              borderBottomLeftRadius: radius.xl,
              borderBottomRightRadius: radius.xl,
              overflow: "hidden",
            },
            sheetAnimatedStyle,
          ]}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 14,
              paddingTop: 18,
              paddingBottom: 12,
              gap: 8,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: colors.fg.default,
                fontSize: 16,
                fontFamily: fonts.sans.semibold,
              }}
            >
              {snapshot?.label || "Element"}
            </Text>

            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.7}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: colors.bg.base,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <X size={16} color={colors.fg.default} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 20, gap: 12 }}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
          >
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: radius.lg,
                backgroundColor: colors.bg.base,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  style={{
                    flex: 1,
                    color: colors.fg.default,
                    fontSize: 10,
                    lineHeight: 14,
                    fontFamily: fonts.mono.regular,
                  }}
                >
                  {snapshot?.selectorPath || snapshot?.label || ""}
                </Text>
                <TouchableOpacity
                  onPress={async () =>
                    Clipboard.setStringAsync(snapshot?.selectorPath || snapshot?.label || "")
                  }
                  activeOpacity={0.85}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: radius.full,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.bg.raised,
                    borderWidth: 1,
                    borderColor: colors.bg.raised,
                  }}
                >
                  <Copy size={13} color={colors.fg.default} strokeWidth={2} />
                </TouchableOpacity>
              </View>
            </View>

            {snapshot?.sourceContent ? (
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: radius.lg,
                  backgroundColor: colors.bg.base,
                  gap: 6,
                }}
              >
                <Text
                  style={{
                    color: colors.fg.subtle,
                    fontSize: 9,
                    fontFamily: fonts.sans.medium,
                    textTransform: "uppercase",
                  }}
                >
                  Markup
                </Text>
                <Text
                  style={{
                    color: colors.fg.default,
                    fontSize: 10,
                    lineHeight: 14,
                    fontFamily: fonts.mono.regular,
                  }}
                >
                  {snapshot.sourceContent}
                </Text>
              </View>
            ) : null}

            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: radius.lg,
                backgroundColor: colors.bg.base,
                gap: 6,
              }}
            >
              <Text
                style={{
                  color: colors.fg.subtle,
                  fontSize: 9,
                  fontFamily: fonts.sans.medium,
                  textTransform: "uppercase",
                }}
              >
                Direct Text Content
              </Text>
              <TextInput
                value={textDraft}
                onChangeText={onChangeTextDraft}
                multiline
                placeholder="Direct text only"
                placeholderTextColor={colors.fg.subtle}
                style={{
                  height: 82,
                  color: colors.fg.default,
                  fontSize: 10,
                  lineHeight: 14,
                  fontFamily: fonts.mono.regular,
                  paddingHorizontal: 10,
                  paddingVertical: 10,
                  borderRadius: radius.md,
                  backgroundColor: colors.bg.raised,
                  borderWidth: 1,
                  borderColor: colors.bg.raised,
                  textAlignVertical: "top",
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={onSaveText}
                activeOpacity={0.85}
                style={{
                  alignSelf: "flex-start",
                  minWidth: 54,
                  height: 28,
                  paddingHorizontal: 10,
                  borderRadius: radius.full,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  gap: 5,
                  backgroundColor: colors.accent.default,
                }}
              >
                <Check size={12} color={'#ffffff'} strokeWidth={2} />
                <Text
                  style={{
                    color: '#ffffff',
                    fontSize: 10,
                    fontFamily: fonts.sans.semibold,
                  }}
                >
                  Save
                </Text>
              </TouchableOpacity>
            </View>

            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: radius.lg,
                backgroundColor: colors.bg.base,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text
                  style={{
                    color: colors.fg.subtle,
                    fontSize: 9,
                    fontFamily: fonts.sans.medium,
                    textTransform: "uppercase",
                  }}
                >
                  Attributes
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setPendingFocusTarget("attribute");
                    onAddAttributeRow();
                  }}
                  activeOpacity={0.85}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: radius.full,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.bg.raised,
                    borderWidth: 1,
                    borderColor: colors.bg.raised,
                  }}
                >
                  <Plus size={13} color={colors.fg.default} strokeWidth={2} />
                </TouchableOpacity>
              </View>

              {attributeRows.length === 0 ? (
                <Text
                  style={{
                    color: colors.fg.muted,
                    fontSize: 10,
                    lineHeight: 14,
                    fontFamily: fonts.sans.regular,
                  }}
                >
                  No attributes.
                </Text>
              ) : null}

              {attributeRows.map((row, index) => {
                const originalRow = snapshot?.attributes?.[index];
                const isDirty =
                  !originalRow ||
                  originalRow.name !== row.name ||
                  originalRow.value !== row.value;
                const canSave = !!row.name.trim();

                return (
                  <View
                    key={`attr-row-${index}`}
                    style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                  >
                    <TextInput
                      ref={(input) => {
                        attributeNameRefs.current[index] = input;
                      }}
                      value={row.name}
                      onChangeText={(value) => onChangeAttributeRow(index, "name", value)}
                      placeholder="attribute"
                      placeholderTextColor={colors.fg.subtle}
                      style={{
                        width: 120,
                        height: 34,
                        color: colors.accent.default,
                        fontSize: 10,
                        fontFamily: fonts.mono.regular,
                        paddingHorizontal: 10,
                        borderRadius: radius.md,
                        backgroundColor: colors.bg.raised,
                        borderWidth: 1,
                        borderColor: colors.bg.raised,
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TextInput
                      value={row.value}
                      onChangeText={(value) => onChangeAttributeRow(index, "value", value)}
                      placeholder="value"
                      placeholderTextColor={colors.fg.subtle}
                      style={{
                        flex: 1,
                        height: 34,
                        color: colors.fg.default,
                        fontSize: 10,
                        fontFamily: fonts.mono.regular,
                        paddingHorizontal: 10,
                        borderRadius: radius.md,
                        backgroundColor: colors.bg.raised,
                        borderWidth: 1,
                        borderColor: colors.bg.raised,
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    {isDirty ? (
                      <TouchableOpacity
                        onPress={() => onSaveAttributeRow(index)}
                        disabled={!canSave}
                        activeOpacity={0.85}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: radius.full,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: canSave ? colors.accent.default : colors.bg.raised,
                          borderWidth: canSave ? 0 : 1,
                          borderColor: colors.bg.raised,
                          opacity: canSave ? 1 : 0.5,
                        }}
                      >
                        <Check size={12} color={canSave ? '#ffffff' : colors.fg.subtle} strokeWidth={2} />
                      </TouchableOpacity>
                    ) : (
                      <View style={{ width: 28 }} />
                    )}
                  </View>
                );
              })}
            </View>

            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: radius.lg,
                backgroundColor: colors.bg.base,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text
                  style={{
                    color: colors.fg.subtle,
                    fontSize: 9,
                    fontFamily: fonts.sans.medium,
                    textTransform: "uppercase",
                  }}
                >
                  Declared Styles
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <TouchableOpacity
                    onPress={() => {
                      setPendingFocusTarget("style");
                      onAddStyleRow();
                    }}
                    activeOpacity={0.85}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: radius.full,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.bg.raised,
                      borderWidth: 1,
                      borderColor: colors.bg.raised,
                    }}
                  >
                    <Plus size={13} color={colors.fg.default} strokeWidth={2} />
                  </TouchableOpacity>

                </View>
              </View>

              {styleRows.length === 0 ? (
                <Text
                  style={{
                    color: colors.fg.muted,
                    fontSize: 10,
                    lineHeight: 14,
                    fontFamily: fonts.sans.regular,
                  }}
                >
                  No inline styles yet.
                </Text>
              ) : null}

              {styleRows.map((row, index) => {
                const originalRow = snapshot?.declaredStyles?.[index];
                const isDirty =
                  !originalRow ||
                  originalRow.name !== row.name ||
                  originalRow.value !== row.value ||
                  originalRow.source !== row.source;
                const canSave = !!row.name.trim() && !!row.value.trim();

                return (
                <View
                  key={`style-row-${index}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <TextInput
                    ref={(input) => {
                      styleNameRefs.current[index] = input;
                    }}
                    value={row.name}
                    onChangeText={(value) => onChangeStyleRow(index, "name", value)}
                    placeholder="property"
                    placeholderTextColor={colors.fg.subtle}
                    style={{
                      width: 120,
                      height: 34,
                      color: colors.accent.default,
                      fontSize: 10,
                      fontFamily: fonts.mono.regular,
                      paddingHorizontal: 10,
                      borderRadius: radius.md,
                      backgroundColor: colors.bg.raised,
                      borderWidth: 1,
                      borderColor: colors.bg.raised,
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TextInput
                    value={row.value}
                    onChangeText={(value) => onChangeStyleRow(index, "value", value)}
                    placeholder="value"
                    placeholderTextColor={colors.fg.subtle}
                    style={{
                      flex: 1,
                      height: 34,
                      color: colors.fg.default,
                      fontSize: 10,
                      fontFamily: fonts.mono.regular,
                      paddingHorizontal: 10,
                      borderRadius: radius.md,
                      backgroundColor: colors.bg.raised,
                      borderWidth: 1,
                      borderColor: colors.bg.raised,
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {isDirty ? (
                    <TouchableOpacity
                      onPress={() => onSaveStyleRow(index)}
                      disabled={!canSave}
                      activeOpacity={0.85}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: radius.full,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: canSave ? colors.accent.default : colors.bg.raised,
                        borderWidth: canSave ? 0 : 1,
                        borderColor: colors.bg.raised,
                        opacity: canSave ? 1 : 0.5,
                      }}
                    >
                      <Check size={12} color={canSave ? '#ffffff' : colors.fg.subtle} strokeWidth={2} />
                    </TouchableOpacity>
                  ) : (
                    <View style={{ width: 28 }} />
                  )}
                </View>
              )})}
            </View>

          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export default function ElementsSection({
  snapshot,
  listKey,
  focusPath,
  focusToken,
  isPicking,
  onStartPickElement,
  onRefresh,
  onRequestPath,
  onSaveInlineStyle,
  onSaveDirectTextContent,
  onSaveAttribute,
}: {
  snapshot: DevsoleElementsSnapshot | null;
  listKey: string;
  focusPath: string | null;
  focusToken: number;
  isPicking: boolean;
  onStartPickElement: () => void;
  onRefresh: (path: string) => void;
  onRequestPath: (path: string) => void;
  onSaveInlineStyle: (path: string, styles: DevsoleElementsStyleProperty[]) => void;
  onSaveDirectTextContent: (path: string, value: string) => void;
  onSaveAttribute: (path: string, attributes: DevsoleElementsAttribute[]) => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const listRef = useRef<FlashListRef<TreeNode> | null>(null);
  const lastAppliedFocusTokenRef = useRef(0);
  const pendingRevealPathRef = useRef<string | null>(null);
  const snapshotsByPathRef = useRef<Record<string, DevsoleElementsSnapshot>>({});
  const [snapshotsByPath, setSnapshotsByPath] = useState<Record<string, DevsoleElementsSnapshot>>({});
  const [selectedPath, setSelectedPath] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([""]));
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [attributeRows, setAttributeRows] = useState<DevsoleElementsAttribute[]>([]);
  const [styleRows, setStyleRows] = useState<DevsoleElementsStyleProperty[]>([]);

  useEffect(() => {
    setSnapshotsByPath({});
    setSelectedPath("");
    setExpandedPaths(new Set([""]));
    setDetailPath(null);
    setTextDraft("");
    setAttributeRows([]);
    setStyleRows([]);
  }, [listKey]);

  useEffect(() => {
    if (!snapshot) return;
    setSnapshotsByPath((current) => ({
      ...current,
      [snapshot.path]: snapshot,
    }));
    setSelectedPath((current) => current || snapshot.path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      next.add(snapshot.path);
      return next;
    });
  }, [snapshot]);

  useEffect(() => {
    snapshotsByPathRef.current = snapshotsByPath;
  }, [snapshotsByPath]);

  useEffect(() => {
    if (focusPath == null || focusToken === lastAppliedFocusTokenRef.current) return;
    lastAppliedFocusTokenRef.current = focusToken;
    pendingRevealPathRef.current = focusPath;

    const nextExpanded = new Set<string>([""]);
    if (focusPath) {
      const segments = focusPath.split(".");
      let currentPath = "";
      segments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}.${segment}` : segment;
        nextExpanded.add(currentPath);
      });
    }

    setSelectedPath(focusPath);
    setExpandedPaths((current) => {
      const next = new Set(current);
      nextExpanded.forEach((path) => next.add(path));
      return next;
    });

    nextExpanded.forEach((path) => {
      if (!snapshotsByPathRef.current[path]) {
        onRequestPath(path);
      }
    });
  }, [focusPath, focusToken, onRequestPath]);

  const rootSnapshot = snapshotsByPath[""] || (snapshot?.path === "" ? snapshot : null);
  const selectedSnapshot = snapshotsByPath[selectedPath] || rootSnapshot || null;
  const detailSnapshot = detailPath ? snapshotsByPath[detailPath] || null : null;

  useEffect(() => {
    if (!detailSnapshot) return;
    setTextDraft(detailSnapshot.directTextContent || "");
    setAttributeRows(detailSnapshot.attributes || []);
    setStyleRows(detailSnapshot.declaredStyles || []);
  }, [detailSnapshot]);

  const treeRows = useMemo(
    () => buildTreeRows(rootSnapshot, snapshotsByPath, expandedPaths),
    [expandedPaths, rootSnapshot, snapshotsByPath]
  );

  useEffect(() => {
    const revealPath = pendingRevealPathRef.current || selectedPath;
    if (!revealPath) return;

    const nextExpanded = new Set<string>([""]);
    if (revealPath) {
      const segments = revealPath.split(".");
      let currentPath = "";
      segments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}.${segment}` : segment;
        nextExpanded.add(currentPath);
      });
    }

    setExpandedPaths((current) => {
      let changed = false;
      const next = new Set(current);
      nextExpanded.forEach((path) => {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      });
      return changed ? next : current;
    });

    nextExpanded.forEach((path) => {
      if (!snapshotsByPathRef.current[path]) {
        onRequestPath(path);
      }
    });

    const index = treeRows.findIndex((item) => item.path === revealPath);
    if (index < 0) return;

    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({
          index,
          animated: true,
          viewPosition: 0.35,
        });
      } catch {}
    });
    pendingRevealPathRef.current = null;
  }, [selectedPath, treeRows, focusToken, onRequestPath]);

  const handleSelect = (path: string) => {
    setSelectedPath(path);
    if (!snapshotsByPath[path]) {
      onRequestPath(path);
    }
  };

  const handleToggleExpand = (item: TreeNode) => {
    if (!item.hasChildren) return;

    const isExpanded = expandedPaths.has(item.path);

    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(item.path)) {
        next.delete(item.path);
      } else {
        next.add(item.path);
      }
      return next;
    });

    if (!isExpanded && !snapshotsByPath[item.path]) {
      onRequestPath(item.path);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 4,
          backgroundColor: colors.bg.raised,
          borderBottomWidth: 0.5,
          borderBottomColor: colors.border.secondary,
          gap: 8,
        }}
      >
        <TouchableOpacity
          onPress={onStartPickElement}
          activeOpacity={0.85}
          style={{
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.full,
            backgroundColor: isPicking ? colors.accent.default : colors.bg.base,
            borderWidth: 0.5,
            borderColor: isPicking ? colors.accent.default : colors.border.secondary,
          }}
        >
          <MousePointerClick size={13} color={isPicking ? "#ffffff" : colors.fg.default} strokeWidth={2} />
        </TouchableOpacity>

        {selectedSnapshot ? (
          <View style={{ flex: 1, gap: 1 }}>
            <Text numberOfLines={1} style={{ color: colors.fg.default, fontSize: 11, fontFamily: fonts.mono.medium }}>
              {selectedSnapshot.label}
            </Text>
            <Text numberOfLines={1} style={{ color: colors.fg.muted, fontSize: 9, fontFamily: fonts.sans.medium, textTransform: "uppercase" }}>
              {selectedSnapshot.nodeType} · {selectedSnapshot.childCount} child{selectedSnapshot.childCount === 1 ? "" : "ren"}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1, gap: 1 }}>
            <Text numberOfLines={1} style={{ color: colors.fg.default, fontSize: 11, fontFamily: fonts.sans.semibold }}>
              No DOM snapshot yet
            </Text>
            <Text numberOfLines={1} style={{ color: colors.fg.muted, fontSize: 9, fontFamily: fonts.sans.medium, textTransform: "uppercase" }}>
              Load the page or pick an element
            </Text>
          </View>
        )}

        <TouchableOpacity
          onPress={() => onRefresh(selectedPath)}
          activeOpacity={0.85}
          style={{
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.full,
            backgroundColor: colors.bg.base,
            borderWidth: 0.5,
            borderColor: colors.border.secondary,
          }}
        >
          <RefreshCw size={13} color={colors.fg.default} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      {!rootSnapshot ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 20,
            gap: 10,
          }}
        >
          <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold }}>
            No DOM snapshot yet
          </Text>
          <Text
            style={{
              color: colors.fg.muted,
              fontSize: 12,
              lineHeight: 17,
              textAlign: "center",
              fontFamily: fonts.sans.regular,
            }}
          >
            Open the Elements tab on a loaded page or use the picker to inspect the current DOM tree.
          </Text>
        </View>
      ) : (

      <View style={{ flex: 1 }}>
        <FlashList
          ref={listRef}
          key={listKey}
          data={treeRows}
          keyExtractor={(item) => item.path || "root"}
          renderItem={({ item }) => (
            <TreeRow
              item={item}
              expanded={expandedPaths.has(item.path)}
              selected={selectedPath === item.path}
              onPress={() => handleSelect(item.path)}
              onOpenDetail={() => {
                setDetailPath(item.path);
                onRequestPath(item.path);
              }}
              onToggleExpand={() => handleToggleExpand(item)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 8 }}
          ItemSeparatorComponent={() => (
            <View
              style={{
                height: 0.5,
                backgroundColor: colors.border.secondary,
                marginHorizontal: 14,
              }}
            />
          )}
        />
      </View>
      )}

      <ElementDetailSheet
        snapshot={detailSnapshot}
        textDraft={textDraft}
        onChangeTextDraft={setTextDraft}
        attributeRows={attributeRows}
        onChangeAttributeRow={(index, field, value) => {
          setAttributeRows((current) =>
            current.map((row, rowIndex) =>
              rowIndex === index ? { ...row, [field]: value } : row
            )
          );
        }}
        onAddAttributeRow={() => {
          setAttributeRows((current) => [...current, { name: "", value: "" }]);
        }}
        styleRows={styleRows}
        onChangeStyleRow={(index, field, value) => {
          setStyleRows((current) =>
            current.map((row, rowIndex) =>
              rowIndex === index ? { ...row, [field]: value } : row
            )
          );
        }}
        onAddStyleRow={() => {
          setStyleRows((current) => [...current, { name: "", value: "", source: "inline" }]);
        }}
        onClose={() => setDetailPath(null)}
        onSaveText={() => {
          if (!detailPath) return;
          onSaveDirectTextContent(detailPath, textDraft);
          onRefresh(detailPath);
        }}
        onSaveAttributeRow={(index) => {
          if (!detailPath) return;
          const row = attributeRows[index];
          if (!row) return;
          const normalizedRow = {
            name: row.name.trim(),
            value: row.value,
          };
          if (!normalizedRow.name) return;
          onSaveAttribute(detailPath, [normalizedRow]);
          onRefresh(detailPath);
        }}
        onSaveStyleRow={(index) => {
          if (!detailPath) return;
          const row = styleRows[index];
          if (!row) return;
          const normalizedRow = {
            name: row.name.trim(),
            value: row.value.trim(),
            source: row.source || "inline",
          };
          if (!normalizedRow.name || !normalizedRow.value) return;
          onSaveInlineStyle(detailPath, [normalizedRow]);
          onRefresh(detailPath);
        }}
      />
    </View>
  );
}
