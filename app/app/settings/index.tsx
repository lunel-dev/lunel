import { useTheme } from "@/contexts/ThemeContext";
import { ChevronRight, ChevronLeft, LucideIcon, Palette, Type, Code, Sparkles, MoonStar, Server } from "lucide-react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface SettingsRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}

function SettingsRow({ icon: Icon, label, onPress }: SettingsRowProps) {
  const { colors, fonts, radius, spacing } = useTheme();

  return (
    <TouchableOpacity
      style={[styles.settingsRow, { paddingVertical: spacing[3], paddingHorizontal: spacing[4] }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowLeft}>
        <View style={[styles.iconContainer, { backgroundColor: colors.accent.default + '20', borderRadius: radius.md }]}>
          <Icon size={18} color={colors.accent.default} strokeWidth={2} />
        </View>
        <Text style={[styles.rowLabel, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}>
          {label}
        </Text>
      </View>
      <ChevronRight size={20} color={colors.fg.subtle} strokeWidth={2} />
    </TouchableOpacity>
  );
}

export default function SettingsPage() {
  const { colors, fonts, radius, spacing } = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>

      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.bg.base }]}>
        <TouchableOpacity
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.back();
          }}
          style={[
            styles.backButton,
            {
              borderRadius: radius.full,
              backgroundColor: colors.bg.raised,
              borderColor: colors.border.secondary,
              borderWidth: 0.5,
            },
          ]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ChevronLeft size={24} color={colors.fg.default} strokeWidth={2} />
        </TouchableOpacity>
        <View
          style={[
            styles.titlePill,
            {
              borderRadius: radius.full,
              backgroundColor: colors.bg.raised,
              borderColor: colors.border.secondary,
              borderWidth: 0.5,
            },
          ]}
        >
          <Text style={[styles.headerTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            Settings
          </Text>
        </View>
        <View
          style={[
            styles.placeholder,
            {
              opacity: 0,
            },
          ]}
        />
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
        {/* Appearance Section */}
        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          APPEARANCE
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18 }]}>
          <SettingsRow
            icon={Palette}
            label="Theme"
            onPress={() => router.push("/settings/appearance/theme")}
          />
          <View style={[styles.divider, { backgroundColor: colors.border.tertiary }]} />
          <SettingsRow
            icon={Type}
            label="Fonts"
            onPress={() => router.push("/settings/appearance/fonts")}
          />
          {/* <View style={[styles.divider, { backgroundColor: colors.border.tertiary }]} />
          <SettingsRow
            icon={Grid3x3}
            label="Customize Bottom Bar"
            onPress={() => router.push("/settings/bottom-bar")}
          /> */}
        </View>

        {/* Editor Section */}
        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          EDITOR
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18 }]}>
          <SettingsRow
            icon={Code}
            label="Editor Settings"
            onPress={() => router.push("/settings/editor")}
          />
        </View>

        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          APP
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18 }]}>
          <SettingsRow
            icon={Server}
            label="Connection"
            onPress={() => router.push("/settings/connection")}
          />
          <View style={[styles.divider, { backgroundColor: colors.border.tertiary }]} />
          <SettingsRow
            icon={MoonStar}
            label="App Settings"
            onPress={() => router.push("/settings/app")}
          />
        </View>

        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          AI
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18 }]}>
          <SettingsRow
            icon={Sparkles}
            label="AI Settings"
            onPress={() => router.push("/settings/ai")}
          />
        </View>

        {/* Bottom padding */}
        <View style={{ height: spacing[8] }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    height: 64,
    paddingBottom: 10,
  },
  backButton: {
    width: 45,
    height: 45,
    alignItems: "center",
    justifyContent: "center",
  },
  titlePill: {
    minHeight: 45,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  headerTitle: {
    fontSize: 16,
  },
  placeholder: {
    width: 45,
    height: 45,
  },
  content: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 12,
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  section: {
    marginHorizontal: 16,
    overflow: "hidden",
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconContainer: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontSize: 16,
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
});
