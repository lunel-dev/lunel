import { FlashList } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "@/contexts/ThemeContext";
import { Copy, Network, Search, Trash2, X } from "lucide-react-native";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { DevsoleNetworkEntry } from "./types";

function formatDuration(durationMs: number | null) {
  if (durationMs == null) return "Pending";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function compactUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function getStatusColor(entry: DevsoleNetworkEntry, colors: any) {
  if (entry.error) return '#ef4444';
  if (entry.status == null) return colors.fg.muted;
  if (entry.status >= 200 && entry.status < 300) return '#22c55e';
  if (entry.status >= 400) return '#ef4444';
  if (entry.status >= 300) return '#f59e0b';
  return colors.fg.default;
}

const NetworkRow = memo(function NetworkRow({
  item,
  expanded,
  onPress,
  onReadAllResponse,
}: {
  item: DevsoleNetworkEntry;
  expanded: boolean;
  onPress: () => void;
  onReadAllResponse: () => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const statusColor = getStatusColor(item, colors);
  const hasLongResponse =
    !!item.responseBody &&
    item.responseBody.length > (item.responsePreview?.length || 0);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 14,
        gap: 4,
        backgroundColor: expanded ? colors.bg.raised : "transparent",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: colors.accent.default, fontSize: 10, fontFamily: fonts.sans.semibold, minWidth: 28 }}>
          {item.method}
        </Text>
        <Text style={{
          fontSize: 10,
          fontFamily: fonts.sans.semibold,
          color: statusColor,
        }}>
          {item.status == null ? "···" : String(item.status)}
        </Text>
        <Text style={{ color: colors.fg.muted, fontSize: 10, fontFamily: fonts.sans.regular }}>
          {item.type || "xhr"}
        </Text>
        <Text style={{ color: colors.fg.muted, fontSize: 10, fontFamily: fonts.sans.regular, marginLeft: "auto" }}>
          {formatDuration(item.durationMs)}
        </Text>
      </View>

      <Text
        numberOfLines={expanded ? 2 : 1}
        style={{
          color: colors.fg.default,
          fontSize: 11,
          lineHeight: 16,
          fontFamily: fonts.mono.regular,
        }}
      >
        {compactUrl(item.url)}
      </Text>

      {item.error && !expanded ? (
        <Text numberOfLines={1} style={{ color: '#ef4444', fontSize: 10, fontFamily: fonts.sans.regular }}>
          {item.error}
        </Text>
      ) : null}

      {expanded ? (
        <View style={{ gap: 6, paddingTop: 4 }}>
          <Text style={{ color: colors.fg.muted, fontSize: 10, lineHeight: 15, fontFamily: fonts.mono.regular }}>
            {item.url}
          </Text>

          {item.requestBody ? (
            <View style={{ borderRadius: radius.md, backgroundColor: colors.bg.base, overflow: "hidden" }}>
              <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: colors.border.secondary }}>
                <Text style={{ color: colors.fg.subtle, fontSize: 9, fontFamily: fonts.sans.semibold, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Request
                </Text>
              </View>
              <Text style={{ color: colors.fg.default, fontSize: 10, lineHeight: 15, fontFamily: fonts.mono.regular, padding: 10 }}>
                {item.requestBody}
              </Text>
            </View>
          ) : null}

          {item.responsePreview ? (
            <View style={{ borderRadius: radius.md, backgroundColor: colors.bg.base, overflow: "hidden" }}>
              <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: colors.border.secondary }}>
                <Text style={{ color: colors.fg.subtle, fontSize: 9, fontFamily: fonts.sans.semibold, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Response
                </Text>
              </View>
              <Text numberOfLines={6} style={{ color: colors.fg.default, fontSize: 10, lineHeight: 15, fontFamily: fonts.mono.regular, padding: 10 }}>
                {item.responsePreview}
              </Text>
              {hasLongResponse ? (
                <TouchableOpacity onPress={onReadAllResponse} activeOpacity={0.85} style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
                  <Text style={{ color: colors.accent.default, fontSize: 10, fontFamily: fonts.sans.medium }}>
                    Read full response →
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {item.error ? (
            <View style={{ borderRadius: radius.md, backgroundColor: '#ef444412', overflow: "hidden" }}>
              <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: '#ef444430' }}>
                <Text style={{ color: '#ef4444', fontSize: 9, fontFamily: fonts.sans.semibold, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Error
                </Text>
              </View>
              <Text style={{ color: '#ef4444', fontSize: 10, lineHeight: 15, fontFamily: fonts.mono.regular, padding: 10 }}>
                {item.error}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

function ResponseSheet({
  entry,
  onClose,
}: {
  entry: DevsoleNetworkEntry | null;
  onClose: () => void;
}) {
  const { colors, fonts, radius } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(windowHeight);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (entry) {
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
  }, [entry, modalVisible, backdropOpacity, sheetTranslateY, hideModal, windowHeight]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

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
              height: "72%",
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
              Response
            </Text>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <TouchableOpacity
                onPress={async () => {
                  if (!entry?.responseBody) return;
                  await Clipboard.setStringAsync(entry.responseBody);
                }}
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
                <Copy size={16} color={colors.fg.default} strokeWidth={2} />
              </TouchableOpacity>

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
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
          >
            <Text
              style={{
                color: colors.fg.muted,
                fontSize: 11,
                lineHeight: 17,
                fontFamily: fonts.sans.regular,
              }}
            >
              {entry?.responseBody || ""}
            </Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export default function NetworkSection({
  entries,
  onClear,
  listKey,
}: {
  entries: DevsoleNetworkEntry[];
  onClear: () => void;
  listKey: string;
}) {
  const { colors, fonts, radius } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fullResponseEntry, setFullResponseEntry] = useState<DevsoleNetworkEntry | null>(null);
  const searchInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [searchOpen]);

  useEffect(() => {
    if (expandedId && !entries.some((entry) => entry.id === expandedId)) {
      setExpandedId(null);
    }
  }, [entries, expandedId]);

  useEffect(() => {
    if (fullResponseEntry && !entries.some((entry) => entry.id === fullResponseEntry.id)) {
      setFullResponseEntry(null);
    }
  }, [entries, fullResponseEntry]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      return (
        entry.url.toLowerCase().includes(query) ||
        entry.method.toLowerCase().includes(query) ||
        (entry.type || "").toLowerCase().includes(query) ||
        String(entry.status || "").includes(query) ||
        (entry.error || "").toLowerCase().includes(query)
      );
    });
  }, [entries, searchQuery]);

  return (
    <View style={{ flex: 1, gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 4,
          backgroundColor: colors.bg.raised,
          borderBottomWidth: 0.5,
          borderBottomColor: colors.border.secondary,
        }}
      >
        <View style={{ flex: 1 }} />

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
            <Search size={14} color={searchOpen ? '#ffffff' : colors.fg.default} strokeWidth={2} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onClear}
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
        </View>
      </View>

      {searchOpen ? (
        <View style={{ paddingHorizontal: 10 }}>
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
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search requests"
              placeholderTextColor={colors.fg.subtle}
              style={{
                color: colors.fg.default,
                fontSize: 11,
                fontFamily: fonts.mono.regular,
                paddingVertical: 0,
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {filteredEntries.length === 0 ? (
          <View
            style={{
              flex: 1,
              minHeight: 160,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 20,
              marginBottom: 46,
              gap: 10,
            }}
          >
            <Network size={35} color={colors.fg.muted} strokeWidth={1.4} />
            <Text style={{ color: colors.fg.default, fontSize: 14, fontFamily: fonts.sans.semibold }}>
              No network events yet
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
              Requests triggered from the active page will appear here.
            </Text>
          </View>
        ) : (
          <FlashList
            key={`${listKey}:${searchQuery}`}
            data={filteredEntries}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <NetworkRow
                item={item}
                expanded={expandedId === item.id}
                onPress={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                onReadAllResponse={() => setFullResponseEntry(item)}
              />
            )}
            contentContainerStyle={{ paddingBottom: 8 }}
            ItemSeparatorComponent={() => (
              <View style={{ height: 0.5, backgroundColor: colors.border.secondary, marginHorizontal: 14 }} />
            )}
          />
        )}
      </View>

      <ResponseSheet entry={fullResponseEntry} onClose={() => setFullResponseEntry(null)} />
    </View>
  );
}
