import { useTheme } from "@/contexts/ThemeContext";
import { ChevronLeft } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface FaqItemProps {
  question: string;
  answer: string;
}

function FaqItem({ question, answer }: FaqItemProps) {
  const { colors, fonts, spacing } = useTheme();

  return (
    <View style={[styles.faqCard, { backgroundColor: colors.bg.raised, borderColor: colors.bg.raised, borderRadius: 12, padding: spacing[4] }]}>
      <Text style={[styles.faqQuestion, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
        {question}
      </Text>
      <Text style={[styles.faqAnswer, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
        {answer}
      </Text>
    </View>
  );
}

export default function HelpPage() {
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
            Help & Information
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
        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          GETTING STARTED
        </Text>
        <View style={[styles.faqList, { marginHorizontal: 16 }]}>
          <FaqItem
            question="How do I connect to a session?"
            answer="Open Settings, choose either GitHub Codespaces or Hetzner, save your manager URL, then start your session CLI on that server and scan the generated QR code."
          />
          <FaqItem
            question="What if I get disconnected?"
            answer="Go back to Home and attach again with a fresh one-time code from your current server session."
          />
        </View>

        <Text style={[styles.sectionHeader, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
          TROUBLESHOOTING
        </Text>
        <View style={[styles.faqList, { marginHorizontal: 16 }]}>
          <FaqItem
            question="Why is the scanner not working?"
            answer="Enable camera permission in iOS Settings and make sure the QR code is fully visible."
          />
          <FaqItem
            question="Why am I not connecting?"
            answer="Verify the selected backend points to your self-hosted manager, confirm the server-side CLI is already running, and scan the newest QR code."
          />
          <FaqItem
            question="Which parts do I still need to host?"
            answer="This app is now configured to use your own endpoints, but the transport still expects a compatible manager and gateway backend unless you replace that protocol as well."
          />
        </View>

        <View style={{ height: spacing[8] }} />
      </ScrollView>
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
  },
  sectionHeader: {
    fontSize: 12,
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  faqList: {
    gap: 10,
  },
  faqCard: {
    borderWidth: 1,
  },
  faqQuestion: {
    fontSize: 16,
    marginBottom: 6,
  },
  faqAnswer: {
    fontSize: 14,
    lineHeight: 20,
  },
});
