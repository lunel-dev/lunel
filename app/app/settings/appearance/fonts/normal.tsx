import { useTheme } from "@/contexts/ThemeContext";
import Header, { useHeaderHeight } from "@/components/Header";
import {
  NormalFamilyId,
  normalFamilies,
  DEFAULT_FONT_SELECTION,
} from "@/constants/themes";
import { Check, Info } from "lucide-react-native";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import React from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface FontOptionProps {
  name: string;
  sampleText: string;
  fontFamily?: string;
  isSelected: boolean;
  isDefault: boolean;
  onSelect: () => void;
}

function FontOption({ name, sampleText, fontFamily, isSelected, isDefault, onSelect }: FontOptionProps) {
  const { colors, fonts, spacing, radius, typography } = useTheme();

  return (
    <TouchableOpacity
      onPress={onSelect}
      style={[
        styles.fontOption,
        {
          backgroundColor: isSelected ? colors.accent.default + '20' : colors.bg.raised,
          borderRadius: 10,
          padding: spacing[3],
          marginBottom: spacing[2],
        },
      ]}
    >
      <View style={styles.fontOptionHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
          <Text
            style={{
              fontSize: typography.body,
              fontFamily: fonts.sans.medium,
              color: isSelected ? colors.accent.default : colors.fg.default,
            }}
          >
            {name}
          </Text>
          {isDefault && (
            <View style={{ backgroundColor: colors.accent.default + '30', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: colors.accent.default }}>
                Default
              </Text>
            </View>
          )}
        </View>
        {isSelected && (
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: radius.full,
              backgroundColor: colors.accent.default,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Check size={16} color={'#ffffff'} strokeWidth={3} />
          </View>
        )}
      </View>
      <Text
        style={{
          fontSize: typography.caption,
          fontFamily: fontFamily,
          color: colors.fg.muted,
          marginTop: spacing[2],
        }}
      >
        {sampleText}
      </Text>
    </TouchableOpacity>
  );
}

export default function NormalFontPage() {
  const {
    colors,
    fonts,
    spacing,
    radius,
    fontSelection,
    setNormalFont,
  } = useTheme();
  const router = useRouter();
  const headerHeight = useHeaderHeight();

  const normalFontIds = Object.keys(normalFamilies) as NormalFamilyId[];

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header
        title="Normal Font"
        colors={colors}
        onBack={() => router.back()}
        rightAccessory={(
          <TouchableOpacity
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              Alert.alert(
                "Normal Font",
                "Used for UI text, labels, and most readable content.\n\nChoose a clean, balanced font for long reading sessions.\nIt has the biggest impact on overall app readability."
              );
            }}
            style={{ padding: 8 }}
            activeOpacity={0.7}
          >
            <Info size={18} color={colors.fg.muted} strokeWidth={2} />
          </TouchableOpacity>
        )}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: spacing[3] }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: spacing[3] }}>
          {normalFontIds.map((id) => {
            const family = normalFamilies[id];
            return (
              <FontOption
                key={id}
                name={family.name}
                sampleText="The quick brown fox jumps over the lazy dog"
                fontFamily={family.regular}
                isSelected={fontSelection.normal === id}
                isDefault={id === DEFAULT_FONT_SELECTION.normal}
                onSelect={() => setNormalFont(id)}
              />
            );
          })}
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
  fontOption: {
    flexDirection: "column",
  },
  fontOptionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
