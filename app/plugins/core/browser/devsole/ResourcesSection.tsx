import { FlashList } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "@/contexts/ThemeContext";
import { Check, Copy, Plus, RefreshCw, Search, Trash2, X } from "lucide-react-native";
import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import {
  DevsoleResourcesSnapshot,
} from "./types";

type ResourceMode = "localStorage" | "sessionStorage" | "cookies";

type EditorState =
  | { type: "storage"; area: "localStorage" | "sessionStorage"; originalKey?: string; key: string; value: string }
  | { type: "cookie"; originalName?: string; name: string; value: string };

function ResourceEditorSheet({
  editor,
  onClose,
  onChange,
  onSave,
}: {
  editor: EditorState | null;
  onClose: () => void;
  onChange: (editor: EditorState) => void;
  onSave: () => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(windowHeight);

  const hideModal = () => setModalVisible(false);

  useEffect(() => {
    if (editor) {
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
  }, [backdropOpacity, editor, modalVisible, sheetTranslateY, windowHeight]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible || !editor) return null;

  const keyLabel = editor.type === "cookie" ? "Name" : "Key";
  const valueLabel = "Value";
  const currentName = editor.type === "cookie" ? editor.name : editor.key;
  const currentValue = editor.value;

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

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            bottom: 8,
          }}
        >
          <Animated.View
            style={[
              {
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
              }}
            >
              <Text
                style={{
                  color: colors.fg.default,
                  fontSize: 16,
                  fontFamily: fonts.sans.semibold,
                }}
              >
                {editor.type === "cookie" ? "Edit Cookie" : "Edit Storage"}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                activeOpacity={0.85}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.bg.base,
                }}
              >
                <X size={16} color={colors.fg.default} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
              <View style={{ gap: 6 }}>
                <Text
                  style={{
                    color: colors.fg.subtle,
                    fontSize: 9,
                    fontFamily: fonts.sans.medium,
                    textTransform: "uppercase",
                  }}
                >
                  {keyLabel}
                </Text>
                <TextInput
                  value={currentName}
                  onChangeText={(value) => {
                    if (editor.type === "cookie") {
                      onChange({ ...editor, name: value });
                      return;
                    }
                    onChange({ ...editor, key: value });
                  }}
                  placeholder={keyLabel}
                  placeholderTextColor={colors.fg.subtle}
                  style={{
                    height: 38,
                    color: colors.fg.default,
                    fontSize: 11,
                    fontFamily: fonts.mono.regular,
                    paddingHorizontal: 10,
                    borderRadius: radius.md,
                    backgroundColor: colors.bg.base,
                    borderWidth: 1,
                    borderColor: colors.bg.raised,
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View style={{ gap: 6 }}>
                <Text
                  style={{
                    color: colors.fg.subtle,
                    fontSize: 9,
                    fontFamily: fonts.sans.medium,
                    textTransform: "uppercase",
                  }}
                >
                  {valueLabel}
                </Text>
                <TextInput
                  value={currentValue}
                  onChangeText={(value) => onChange({ ...editor, value })}
                  placeholder={valueLabel}
                  placeholderTextColor={colors.fg.subtle}
                  multiline
                  style={{
                    minHeight: 96,
                    color: colors.fg.default,
                    fontSize: 11,
                    lineHeight: 15,
                    fontFamily: fonts.mono.regular,
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    borderRadius: radius.md,
                    backgroundColor: colors.bg.base,
                    borderWidth: 1,
                    borderColor: colors.bg.raised,
                    textAlignVertical: "top",
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <TouchableOpacity
                onPress={onSave}
                activeOpacity={0.85}
                style={{
                  alignSelf: "flex-start",
                  height: 30,
                  paddingHorizontal: 12,
                  borderRadius: radius.full,
                  backgroundColor: colors.accent.default,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Check size={13} color={'#ffffff'} strokeWidth={2} />
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
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

export default function ResourcesSection({
  snapshot,
  listKey,
  onRefresh,
  onSetStorageItem,
  onRemoveStorageItem,
  onClearStorageArea,
  onSetCookie,
  onRemoveCookie,
}: {
  snapshot: DevsoleResourcesSnapshot | null;
  listKey: string;
  onRefresh: () => void;
  onSetStorageItem: (
    area: "localStorage" | "sessionStorage",
    key: string,
    value: string
  ) => void;
  onRemoveStorageItem: (area: "localStorage" | "sessionStorage", key: string) => void;
  onClearStorageArea: (area: "localStorage" | "sessionStorage") => void;
  onSetCookie: (name: string, value: string) => void;
  onRemoveCookie: (name: string) => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const [mode, setMode] = useState<ResourceMode>("localStorage");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    setMode("localStorage");
    setSearchOpen(false);
    setSearchQuery("");
    setEditor(null);
  }, [listKey]);

  const filteredStorageItems = useMemo(() => {
    const storageItems =
      mode === "localStorage"
        ? snapshot?.localStorage || []
        : mode === "sessionStorage"
          ? snapshot?.sessionStorage || []
          : [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return storageItems;
    return storageItems.filter((item) =>
      item.key.toLowerCase().includes(query) || item.value.toLowerCase().includes(query)
    );
  }, [mode, searchQuery, snapshot]);

  const filteredCookies = useMemo(() => {
    const cookieItems = snapshot?.cookies || [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return cookieItems;
    return cookieItems.filter((item) =>
      item.name.toLowerCase().includes(query) || item.value.toLowerCase().includes(query)
    );
  }, [searchQuery, snapshot]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          backgroundColor: colors.bg.raised,
          borderBottomWidth: 0.5,
          borderBottomColor: colors.border.secondary,
        }}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexDirection: "row" }}
        >
          {(["localStorage", "sessionStorage", "cookies"] as ResourceMode[]).map((nextMode) => {
            const active = nextMode === mode;
            return (
              <TouchableOpacity
                key={nextMode}
                onPress={() => setMode(nextMode)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 8,
                  paddingTop: 10,
                  paddingBottom: 10,
                  marginRight: 4,
                  borderBottomWidth: 2,
                  borderBottomColor: active ? colors.fg.muted : "transparent",
                  marginBottom: -0.5,
                }}
              >
                <Text
                  style={{
                    color: active ? colors.fg.default : colors.fg.muted,
                    fontSize: 11,
                    fontFamily: active ? fonts.sans.semibold : fonts.sans.medium,
                  }}
                >
                  {nextMode === "localStorage"
                    ? "Local"
                    : nextMode === "sessionStorage"
                      ? "Session"
                      : "Cookies"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={{ flexDirection: "row", gap: 4, marginLeft: 6 }}>
          <TouchableOpacity
            onPress={() => setSearchOpen((current) => !current)}
            activeOpacity={0.85}
            style={{
              width: 28,
              height: 28,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.full,
              backgroundColor: searchOpen ? colors.accent.default : colors.bg.base,
              borderWidth: 0.5,
              borderColor: searchOpen ? colors.accent.default : colors.border.secondary,
            }}
          >
            <Search size={14} color={searchOpen ? "#ffffff" : colors.fg.default} strokeWidth={2} />
          </TouchableOpacity>

          {mode !== "cookies" ? (
            <TouchableOpacity
              onPress={() => onClearStorageArea(mode)}
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
              <Trash2 size={14} color={colors.fg.default} strokeWidth={2} />
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            onPress={() => {
              if (mode === "cookies") {
                setEditor({ type: "cookie", name: "", value: "" });
                return;
              }
              setEditor({ type: "storage", area: mode, key: "", value: "" });
            }}
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
            <Plus size={14} color={colors.fg.default} strokeWidth={2} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onRefresh}
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
            <RefreshCw size={14} color={colors.fg.default} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {searchOpen ? (
        <View style={{ paddingHorizontal: 10, marginTop: 10 }}>
          <View
            style={{
              minHeight: 32,
              paddingHorizontal: 10,
              backgroundColor: colors.bg.raised,
              borderRadius: 8,
              borderWidth: 0.5,
              borderColor: colors.border.secondary,
              justifyContent: "center",
            }}
          >
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={mode === "cookies" ? "Search cookies" : "Search storage"}
              placeholderTextColor={colors.fg.subtle}
              style={{
                color: colors.fg.default,
                fontSize: 11,
                fontFamily: fonts.mono.regular,
                paddingVertical: 0,
              }}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
          </View>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {mode === "cookies" ? (
          <FlashList
            key={`${listKey}-cookies`}
            data={filteredCookies}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: 16 }}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => {
                  setEditor({
                    type: "cookie",
                    originalName: item.name,
                    name: item.name,
                    value: item.value,
                  });
                }}
                activeOpacity={0.85}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  gap: 10,
                }}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: colors.accent.default,
                      fontSize: 11,
                      fontFamily: fonts.mono.medium,
                    }}
                  >
                    {item.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: item.value ? colors.fg.default : colors.fg.muted,
                      fontSize: 10,
                      lineHeight: 15,
                      fontFamily: fonts.mono.regular,
                    }}
                  >
                    {item.value || "empty"}
                  </Text>
                </View>

                <View style={{ flexDirection: "row", gap: 2 }}>
                  <TouchableOpacity
                    onPress={() => Clipboard.setStringAsync(`${item.name}=${item.value}`)}
                    activeOpacity={0.7}
                    style={{ padding: 6 }}
                  >
                    <Copy size={13} color={colors.fg.subtle} strokeWidth={2} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onRemoveCookie(item.name)}
                    activeOpacity={0.7}
                    style={{ padding: 6 }}
                  >
                    <Trash2 size={13} color={colors.fg.subtle} strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => (
              <View style={{ height: 0.5, backgroundColor: colors.border.secondary, marginHorizontal: 14 }} />
            )}
            ListEmptyComponent={
              <View style={{ paddingTop: 32, alignItems: "center" }}>
                <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular }}>
                  No cookies
                </Text>
              </View>
            }
          />
        ) : (
          <FlashList
            key={`${listKey}-${mode}`}
            data={filteredStorageItems}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: 16 }}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => {
                  setEditor({
                    type: "storage",
                    area: item.area,
                    originalKey: item.key,
                    key: item.key,
                    value: item.value,
                  });
                }}
                activeOpacity={0.85}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  gap: 10,
                }}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: colors.accent.default,
                      fontSize: 11,
                      fontFamily: fonts.mono.medium,
                    }}
                  >
                    {item.key}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={{
                      color: item.value ? colors.fg.default : colors.fg.muted,
                      fontSize: 10,
                      lineHeight: 15,
                      fontFamily: fonts.mono.regular,
                    }}
                  >
                    {item.value || "empty"}
                  </Text>
                </View>

                <View style={{ flexDirection: "row", gap: 2 }}>
                  <TouchableOpacity
                    onPress={() => Clipboard.setStringAsync(item.value)}
                    activeOpacity={0.7}
                    style={{ padding: 6 }}
                  >
                    <Copy size={13} color={colors.fg.subtle} strokeWidth={2} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onRemoveStorageItem(item.area, item.key)}
                    activeOpacity={0.7}
                    style={{ padding: 6 }}
                  >
                    <Trash2 size={13} color={colors.fg.subtle} strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => (
              <View style={{ height: 0.5, backgroundColor: colors.border.secondary, marginHorizontal: 14 }} />
            )}
            ListEmptyComponent={
              <View style={{ paddingTop: 32, alignItems: "center" }}>
                <Text style={{ color: colors.fg.muted, fontSize: 12, fontFamily: fonts.sans.regular }}>
                  No entries
                </Text>
              </View>
            }
          />
        )}
      </View>

      <ResourceEditorSheet
        editor={editor}
        onClose={() => {
          setEditor(null);
        }}
        onChange={setEditor}
        onSave={() => {
          if (!editor) return;
          if (editor.type === "cookie") {
            const name = editor.name.trim();
            if (!name) return;
            if (editor.originalName && editor.originalName !== name) {
              onRemoveCookie(editor.originalName);
            }
            onSetCookie(name, editor.value);
          } else {
            const key = editor.key.trim();
            if (!key) return;
            if (editor.originalKey && editor.originalKey !== key) {
              onRemoveStorageItem(editor.area, editor.originalKey);
            }
            onSetStorageItem(editor.area, key, editor.value);
          }
          setEditor(null);
        }}
      />
    </View>
  );
}
