import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useTheme } from "@/contexts/ThemeContext";
import Header, { useHeaderHeight } from "@/components/Header";
import { Stack, useRouter } from "expo-router";

import React from "react";
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}

function ToggleRow({ label, description, value, onValueChange }: ToggleRowProps) {
  const { colors, fonts, spacing, typography } = useTheme();

  return (
    <View style={[styles.row, { paddingVertical: spacing[2], paddingHorizontal: spacing[3] }]}>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.body }]}>
          {label}
        </Text>
        {description ? (
          <Text style={[styles.rowDescription, { color: colors.fg.muted, fontFamily: fonts.sans.regular, fontSize: typography.caption }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border.main, true: colors.accent.default }}
        ios_backgroundColor={colors.border.main}
        thumbColor={value ? "#ffffff" : colors.bg.base}
      />
    </View>
  );
}

export default function AppSettingsPage() {
  const { colors, fonts, spacing, typography } = useTheme();
  const { settings, updateSetting } = useAppSettings();
  const router = useRouter();
  const headerHeight = useHeaderHeight();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header title="App" colors={colors} onBack={() => router.back()} />

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: typography.caption }]}>
          DISPLAY
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 10 }]}>
          <ToggleRow
            label="Keep App Awake"
            description="Prevent auto-lock while Lunel is open"
            value={settings.keepAwakeEnabled}
            onValueChange={(value) => {
              void updateSetting("keepAwakeEnabled", value);
            }}
          />
          <ToggleRow
            label="AI Completion Notifications"
            description="Notify this phone when an AI session finishes while the app is disconnected"
            value={settings.aiCompletionNotificationsEnabled}
            onValueChange={(value) => {
              void updateSetting("aiCompletionNotificationsEnabled", value);
            }}
          />
        </View>

        <View style={{ height: spacing[8] }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  sectionHeader: {
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  section: {
    marginHorizontal: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowText: {
    flex: 1,
    marginRight: 12,
  },
  rowLabel: {},
  rowDescription: {
    marginTop: 2,
  },
});
