import { useAppSettings } from "@/contexts/AppSettingsContext";
import {
  CONNECTION_TARGET_LABELS,
  ConnectionProfilesSettings,
  DeploymentTarget,
  normalizeGatewayUrl,
  normalizeManagerUrl,
  sanitizeConnectionProfiles,
} from "@/lib/connectionProfiles";
import { useTheme } from "@/contexts/ThemeContext";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft } from "lucide-react-native";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

interface TargetChipProps {
  active: boolean;
  label: string;
  onPress: () => void;
}

function TargetChip({ active, label, onPress }: TargetChipProps) {
  const { colors, fonts, radius } = useTheme();

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      style={[
        styles.targetChip,
        {
          borderRadius: radius.full,
          backgroundColor: active ? colors.fg.default : colors.bg.base,
          borderColor: active ? colors.fg.default : colors.border.secondary,
        },
      ]}
    >
      <Text
        style={[
          styles.targetChipText,
          {
            color: active ? colors.bg.base : colors.fg.default,
            fontFamily: active ? fonts.sans.semibold : fonts.sans.medium,
          },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

interface InputRowProps {
  label: string;
  description: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  autoCapitalize?: "none" | "sentences";
}

function InputRow({
  label,
  description,
  placeholder,
  value,
  onChangeText,
  autoCapitalize = "none",
}: InputRowProps) {
  const { colors, fonts, radius, spacing } = useTheme();

  return (
    <View style={[styles.inputRow, { paddingVertical: spacing[3], paddingHorizontal: spacing[4] }]}>
      <Text style={[styles.inputLabel, { color: colors.fg.default, fontFamily: fonts.sans.medium }]}>
        {label}
      </Text>
      <Text style={[styles.inputDescription, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
        {description}
      </Text>
      <TextInput
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType="url"
        placeholder={placeholder}
        placeholderTextColor={colors.fg.subtle}
        value={value}
        onChangeText={onChangeText}
        style={[
          styles.input,
          {
            color: colors.fg.default,
            fontFamily: fonts.mono.regular,
            borderRadius: radius.lg,
            borderColor: colors.border.secondary,
            backgroundColor: colors.bg.base,
          },
        ]}
      />
    </View>
  );
}

export default function ConnectionSettingsPage() {
  const { colors, fonts, radius, spacing } = useTheme();
  const { settings, updateSetting } = useAppSettings();
  const router = useRouter();
  const [draft, setDraft] = useState<ConnectionProfilesSettings>(() => sanitizeConnectionProfiles(settings.connectionProfiles));

  useEffect(() => {
    setDraft(sanitizeConnectionProfiles(settings.connectionProfiles));
  }, [settings.connectionProfiles]);

  const activeTarget = draft.activeTarget;
  const activeProfile = draft.profiles[activeTarget];
  const cliEnvHint = useMemo(() => {
    const manager = activeProfile.managerUrl.trim() || "<manager-url>";
    const gateway = activeProfile.gatewayUrl.trim() || "<gateway-url>";
    return `MANAGER_URL=${manager}\nGATEWAY_URL=${gateway}`;
  }, [activeProfile.gatewayUrl, activeProfile.managerUrl]);

  const setActiveTarget = (target: DeploymentTarget) => {
    setDraft((current) => ({ ...current, activeTarget: target }));
  };

  const updateProfileField = (target: DeploymentTarget, field: "managerUrl" | "gatewayUrl", value: string) => {
    setDraft((current) => ({
      ...current,
      profiles: {
        ...current.profiles,
        [target]: {
          ...current.profiles[target],
          [field]: value,
        },
      },
    }));
  };

  const handleSave = async () => {
    try {
      const next = sanitizeConnectionProfiles(draft);
      const profile = next.profiles[next.activeTarget];

      if (!profile.managerUrl.trim()) {
        throw new Error("Manager URL is required.");
      }

      next.profiles[next.activeTarget] = {
        managerUrl: normalizeManagerUrl(profile.managerUrl),
        gatewayUrl: profile.gatewayUrl.trim() ? normalizeGatewayUrl(profile.gatewayUrl) : "",
      };

      await updateSetting("connectionProfiles", next);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save connection settings.";
      Alert.alert("Invalid Connection Settings", message);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <Stack.Screen options={{ headerShown: false }} />

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
            Connection
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void handleSave();
          }}
          activeOpacity={0.75}
          style={[
            styles.saveButton,
            {
              borderRadius: radius.full,
              backgroundColor: colors.fg.default,
            },
          ]}
        >
          <Text style={[styles.saveButtonText, { color: colors.bg.base, fontFamily: fonts.sans.semibold }]}>
            Save
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          TARGET
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18, padding: 14 }]}>
          <Text style={[styles.sectionTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            Active deployment
          </Text>
          <Text style={[styles.sectionText, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
            Choose the backend this app should use right now.
          </Text>
          <View style={styles.targetRow}>
            <TargetChip
              active={activeTarget === "codespaces"}
              label={CONNECTION_TARGET_LABELS.codespaces}
              onPress={() => setActiveTarget("codespaces")}
            />
            <TargetChip
              active={activeTarget === "hetzner"}
              label={CONNECTION_TARGET_LABELS.hetzner}
              onPress={() => setActiveTarget("hetzner")}
            />
          </View>
        </View>

        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          ENDPOINTS
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18 }]}>
          <InputRow
            label="Manager URL"
            description="Required. The app uses this for assemble, reconnect and session lookup."
            placeholder="https://your-manager-host"
            value={activeProfile.managerUrl}
            onChangeText={(value) => updateProfileField(activeTarget, "managerUrl", value)}
          />
          <View style={[styles.divider, { backgroundColor: colors.border.tertiary }]} />
          <InputRow
            label="Gateway URL"
            description="Optional fallback. Useful when your self-hosted manager and gateway are on separate hosts."
            placeholder="wss://your-gateway-host"
            value={activeProfile.gatewayUrl}
            onChangeText={(value) => updateProfileField(activeTarget, "gatewayUrl", value)}
          />
        </View>

        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          CLI
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bg.raised, borderRadius: 18, padding: 16 }]}>
          <Text style={[styles.sectionTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            Run your session CLI with the same endpoints
          </Text>
          <Text style={[styles.sectionText, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
            Set these environment variables in your Hetzner box or GitHub Codespace before you start the CLI session.
          </Text>
          <View
            style={[
              styles.codeBlock,
              {
                borderRadius: radius.lg,
                borderColor: colors.border.secondary,
                backgroundColor: colors.bg.base,
              },
            ]}
          >
            <Text style={[styles.codeText, { color: colors.fg.default, fontFamily: fonts.mono.regular }]}>
              {cliEnvHint}
            </Text>
          </View>
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
  saveButton: {
    minWidth: 64,
    height: 45,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  saveButtonText: {
    fontSize: 14,
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
  sectionTitle: {
    fontSize: 16,
  },
  sectionText: {
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  targetRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
    flexWrap: "wrap",
  },
  targetChip: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  targetChipText: {
    fontSize: 14,
  },
  inputRow: {},
  inputLabel: {
    fontSize: 15,
  },
  inputDescription: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 13,
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
  codeBlock: {
    marginTop: 12,
    borderWidth: 1,
    padding: 12,
  },
  codeText: {
    fontSize: 12,
    lineHeight: 18,
  },
});
