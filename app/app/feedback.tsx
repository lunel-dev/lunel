import { useTheme } from "@/contexts/ThemeContext";
import Header, { useHeaderHeight } from "@/components/Header";
import { Check, Star } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import React, { useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const FEEDBACK_ENDPOINT = process.env.EXPO_PUBLIC_LUNEL_FEEDBACK_URL || "https://internal-api.lunel.dev/app/feedback";

function RatingStars({
  rating,
  onChange,
}: {
  rating: number;
  onChange: (nextRating: number) => void;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View style={styles.starsRow}>
      {[1, 2, 3, 4, 5].map((value) => {
        const isActive = value <= rating;

        return (
          <TouchableOpacity
            key={value}
            activeOpacity={0.7}
            onPress={() => onChange(value)}
            style={[
              styles.starButton,
              {
                backgroundColor: isActive ? colors.accent.default : colors.bg.raised,
                borderColor: isActive ? colors.accent.default : colors.bg.raised,
                borderRadius: 10,
                marginRight: value === 5 ? 0 : spacing[2],
              },
            ]}
          >
            <Star
              size={18}
              strokeWidth={2}
              color={isActive ? colors.bg.base : colors.fg.muted}
              fill={isActive ? colors.bg.base : "transparent"}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function FeedbackPage() {
  const { colors, fonts, radius, spacing, typography } = useTheme();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [content, setContent] = useState("");
  const [rating, setRating] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [error, setError] = useState("");

  const canSend = !isSubmitting && rating > 0 && content.trim().length > 0;

  async function handleSend() {
    if (!canSend) {
      if (rating === 0) {
        setError(t('feedback.errorRating'));
        return;
      }

      if (content.trim().length === 0) {
        setError(t('feedback.errorMessage'));
      }

      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rating,
          content: content.trim(),
          email: email.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Feedback request failed: ${response.status}`);
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setIsSent(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('feedback.errorSend'));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleRatingChange(nextRating: number) {
    setRating(nextRating);
    if (error) {
      setError("");
    }
  }

  function handleContentChange(value: string) {
    setContent(value);
    if (error) {
      setError("");
    }
  }

  function handleEmailChange(value: string) {
    setEmail(value);
    if (error) {
      setError("");
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header title={t('feedback.title')} colors={colors} onBack={() => router.back()} />

      {isSent ? (
        <View style={styles.sentState}>
          <View
            style={[
              styles.sentIconWrap,
              {
                backgroundColor: colors.accent.default,
                borderRadius: radius.full,
              },
            ]}
          >
            <Check size={34} color={colors.bg.base} strokeWidth={2.5} />
          </View>
          <Text style={[styles.sentTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            {t('feedback.sent')}
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
          <View style={[styles.pageSection, { marginHorizontal: 16 }]}>
            <View style={styles.introBlock}>
              <Text style={[styles.introTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                {t('feedback.subtitle')}
              </Text>
            </View>

            <View style={styles.fieldGroup}>
              <View
                style={[
                  styles.fieldCard,
                  {
                    backgroundColor: colors.bg.raised,
                    borderColor: colors.bg.raised,
                    borderRadius: 10,
                  },
                ]}
              >
                <TextInput
                  value={email}
                  onChangeText={handleEmailChange}
                  placeholder={t('feedback.emailPlaceholder')}
                  placeholderTextColor={colors.fg.subtle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  style={[styles.input, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <View
                style={[
                  styles.fieldCard,
                  {
                    backgroundColor: colors.bg.raised,
                    borderColor: colors.bg.raised,
                    borderRadius: 10,
                  },
                ]}
              >
                <TextInput
                  value={content}
                  onChangeText={handleContentChange}
                  placeholder={t('feedback.messagePlaceholder')}
                  placeholderTextColor={colors.fg.subtle}
                  multiline
                  textAlignVertical="top"
                  style={[styles.textarea, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <RatingStars rating={rating} onChange={handleRatingChange} />
            </View>
          </View>

          {error ? (
            <Text style={[styles.errorText, { color: colors.git.deleted, fontFamily: fonts.sans.regular }]}>
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            activeOpacity={0.7}
            disabled={!canSend}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void handleSend();
            }}
            style={[
              styles.sendButton,
              {
                backgroundColor: canSend ? colors.accent.default : colors.bg.raised,
                borderColor: canSend ? colors.accent.default : colors.bg.raised,
                borderRadius: 10,
                marginHorizontal: 16,
                marginTop: spacing[4],
                opacity: isSubmitting ? 0.8 : 1,
              },
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color={colors.bg.base} />
            ) : (
              <Text
                style={[
                  styles.sendButtonLabel,
                  {
                    color: canSend ? colors.bg.base : colors.fg.subtle,
                    fontFamily: fonts.sans.semibold,
                    fontSize: typography.body,
                  },
                ]}
              >
                {t('feedback.send')}
              </Text>
            )}
          </TouchableOpacity>

          <View style={{ height: spacing[8] }} />
        </ScrollView>
      )}
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
  pageSection: {
    paddingTop: 24,
  },
  introBlock: {
    marginBottom: 8,
  },
  introTitle: {
    fontSize: 15,
  },
  fieldGroup: {
    marginTop: 10,
  },
  fieldCard: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  input: {
    fontSize: 15,
    minHeight: 20,
    paddingVertical: 0,
  },
  textarea: {
    fontSize: 15,
    minHeight: 132,
    paddingVertical: 0,
  },
  starsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  starButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  errorText: {
    fontSize: 13,
    marginHorizontal: 16,
    marginTop: 14,
  },
  sendButton: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  sendButtonLabel: {},
  sentState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  sentIconWrap: {
    width: 84,
    height: 84,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  sentTitle: {
    fontSize: 24,
  },
});
