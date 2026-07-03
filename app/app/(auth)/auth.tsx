import { useTheme } from "@/contexts/ThemeContext";
import { useTranslation } from "react-i18next";
import { useConnection } from "@/contexts/ConnectionContext";
import { logger } from "@/lib/logger";
import { useRouter } from "expo-router";
import { ScanLine } from "lucide-react-native";
import { useCallback, useEffect } from "react";
import {
  Alert,
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TABLET_BREAKPOINT = 768;
const TERMS_URL = "https://jukto.pw/terms";
const PRIVACY_URL = "https://jukto.pw/privacy";
const LOGO_SOURCE_DARK = require("@/assets/images/icon.png");
const LOGO_SOURCE_LIGHT = require("@/assets/images/icon.png");

export default function Auth() {
  const { colors, fonts, isDark } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const ctaRadius = 16;
  const router = useRouter();
  const {
    status,
    capabilities,
  } = useConnection();
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert(
          t("auth.unableOpenLinkTitle"),
          t("auth.unableOpenLinkDesc"),
        );
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert(t("auth.unableOpenLinkTitle"), t("auth.unableOpenLinkDesc"));
    }
  }, []);

  useEffect(() => {
    if (status === "connected" && capabilities) {
      logger.info("auth", "connection ready; routing to workspace", {
        rootDir: capabilities.rootDir,
        hostname: capabilities.hostname,
      });
      router.replace("/workspace");
    }
  }, [status, capabilities, router]);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.bg.base, paddingTop: insets.top },
      ]}
    >
      <View
        style={[
          styles.page,
          isTablet && styles.pageTablet,
          { paddingBottom: Math.max(insets.bottom, 28) },
        ]}
      >
        <View style={styles.hero}>
          <View style={styles.centerContent}>
            <View style={styles.brand}>
              <Image
                source={isDark ? LOGO_SOURCE_DARK : LOGO_SOURCE_LIGHT}
                style={{
                  width: isTablet ? 300 : 170,
                  height: isTablet ? 300 : 170,
                  borderRadius: 15,
                }}
                resizeMode="cover"
              />
              <View style={styles.brandText}>
                <Text
                  style={[
                    styles.appName,
                    {
                      color: colors.fg.default,
                      fontFamily: fonts.sans.semibold,
                    },
                  ]}
                >
                  {t("auth.appName")}
                </Text>
                <Text
                  style={[
                    styles.tagline,
                    { color: colors.fg.muted, fontFamily: fonts.sans.regular },
                  ]}
                >
                  {t("auth.tagline")}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.actionsSection}>
          <View style={styles.buttons}>
            <TouchableOpacity
              onPress={() => router.push("/jukto-connect")}
              activeOpacity={0.75}
              style={[
                styles.btn,
                {
                  backgroundColor: colors.fg.default,
                  borderColor: colors.fg.default,
                  borderRadius: ctaRadius,
                },
              ]}
            >
              <ScanLine size={20} color={colors.bg.base} strokeWidth={2} />
              <Text
                style={[
                  styles.btnText,
                  isTablet && styles.btnTextTablet,
                  { color: colors.bg.base, fontFamily: fonts.sans.medium },
                ]}
              >
                {t("auth.scanConnect")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text
          style={[
            styles.legal,
            isTablet && styles.legalTablet,
            { color: colors.fg.muted, fontFamily: fonts.sans.regular },
          ]}
        >
          {t("auth.legal")}{" "}
          <Text
            style={[
              styles.legalLink,
              { color: colors.fg.default, fontFamily: fonts.sans.regular },
            ]}
            onPress={() => openExternalUrl(TERMS_URL)}
          >
            {t("auth.termsOfService")}
          </Text>{" "}
          {t("auth.and")}{" "}
          <Text
            style={[
              styles.legalLink,
              { color: colors.fg.default, fontFamily: fonts.sans.regular },
            ]}
            onPress={() => openExternalUrl(PRIVACY_URL)}
          >
            {t("auth.privacyPolicy")}
          </Text>
          .
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  page: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 28,
    justifyContent: "space-between",
  },
  pageTablet: {
    paddingHorizontal: 48,
    paddingBottom: 36,
    alignItems: "center",
  },
  hero: {
    flex: 1,
    width: "100%",
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: {
    alignItems: "center",
    gap: 10,
  },
  brandText: {
    alignItems: "center",
    gap: 2,
    marginTop: 6,
  },
  actionsSection: {
    width: "100%",
    paddingBottom: 52,
  },
  buttons: {
    gap: 12,
    alignSelf: "stretch",
    paddingHorizontal: 16,
  },
  appName: {
    fontSize: 30,
    letterSpacing: 0.3,
    textAlign: "center",
  },
  tagline: {
    fontSize: 13,
    letterSpacing: 0.2,
    textAlign: "center",
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 15,
    borderRadius: 0,
    borderWidth: 0.5,
  },
  btnTablet: {
    paddingVertical: 13,
  },
  btnText: {
    fontSize: 15,
  },
  btnTextTablet: {
    fontSize: 15,
  },
  legal: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  legalTablet: {
    fontSize: 13,
    lineHeight: 20,
  },
  legalLink: {
    textDecorationLine: "underline",
  },
});
