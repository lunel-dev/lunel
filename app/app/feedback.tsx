import { useTheme } from "@/contexts/ThemeContext";
import { ChevronLeft, Info } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function FeedbackPage() {
  const { colors, fonts, radius, spacing } = useTheme();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg.base }]} edges={["top"]}>
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
            Support
          </Text>
        </View>
        <View style={[styles.placeholder, { opacity: 0 }]} />
      </View>

      <View style={[styles.content, { paddingHorizontal: 16 }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.bg.raised,
              borderColor: colors.border.secondary,
              borderRadius: radius.xl,
              padding: spacing[5],
            },
          ]}
        >
          <View style={[styles.iconWrap, { backgroundColor: colors.accent.default + "20" }]}>
            <Info size={24} color={colors.accent.default} strokeWidth={2} />
          </View>
          <Text style={[styles.title, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            No external feedback endpoint configured
          </Text>
          <Text style={[styles.body, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
            The old Lunel feedback API was removed from this app. Use your own GitHub issues, notes, or support workflow outside the app.
          </Text>
        </View>
      </View>
    </SafeAreaView>
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
    justifyContent: "center",
  },
  card: {
    borderWidth: 1,
    gap: 14,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 18,
  },
  body: {
    fontSize: 14,
    lineHeight: 21,
  },
});
