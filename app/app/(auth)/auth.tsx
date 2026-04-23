import { useTheme } from "@/contexts/ThemeContext";
import { PairedSession, useConnection } from "@/contexts/ConnectionContext";
import { logger } from "@/lib/logger";
import InfoSheet from "@/components/InfoSheet";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronRight, History, ScanLine, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Dimensions, Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, TouchableWithoutFeedback, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import Svg, { Path } from "react-native-svg";

const TABLET_BREAKPOINT = 768;
const TERMS_URL = "https://app.lunel.dev/terms";
const PRIVACY_URL = "https://app.lunel.dev/privacy";
const UPDATE_CHECK_URL = "https://internal-api.lunel.dev/updateNeeded?version=1.0.1";
const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const LOGO_SOURCE_DARK = require("@/assets/images/icon-bg.png");
const LOGO_SOURCE_LIGHT = require("@/assets/images/icon-bg-light.png");

type UpdateCheckResponse = {
  updateNeeded: true;
  ios: string;
  android: string;
};

function isUpdateCheckResponse(value: unknown): value is UpdateCheckResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.updateNeeded === true &&
    typeof candidate.ios === "string" &&
    typeof candidate.android === "string"
  );
}

function getPreferredUpdateUrl(update: UpdateCheckResponse): string {
  if (Platform.OS === "ios") return update.ios;
  if (Platform.OS === "android") return update.android;
  return update.android;
}

function OpenActionIcon({ size = 18, color = "#111111" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15 3h6v6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M10 14 21 3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function DeleteActionIcon({ size = 18, color = "#C62828" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M3 6h18" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function SessionActionsSheet({
  visible,
  session,
  colors,
  fonts,
  radius,
  onOpen,
  onDelete,
  onClose,
}: {
  visible: boolean;
  session: PairedSession | null;
  colors: any;
  fonts: any;
  radius: any;
  onOpen: (session: PairedSession) => void;
  onDelete: (session: PairedSession) => void;
  onClose: () => void;
}) {
  const pastSheetRadius = Math.max(Number(radius?.["2xl"] ?? 24), 36);
  const [modalVisible, setModalVisible] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTranslateY = useSharedValue(SCREEN_HEIGHT);

  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      backdropOpacity.value = 0;
      sheetTranslateY.value = SCREEN_HEIGHT;
      backdropOpacity.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      backdropOpacity.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
      });
      sheetTranslateY.value = withTiming(
        SCREEN_HEIGHT,
        {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (finished) runOnJS(hideModal)();
        }
      );
    }
  }, [visible, backdropOpacity, hideModal, sheetTranslateY]);

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  if (!modalVisible || !session) return null;

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <Animated.View style={[styles.sheetBackdrop, backdropAnimatedStyle]} pointerEvents="box-none">
            <Pressable style={{ flex: 1 }} onPress={onClose} />
          </Animated.View>
          <Animated.View
            style={[
              styles.sheetContainer,
              {
                backgroundColor: colors.bg.raised,
                borderTopLeftRadius: pastSheetRadius,
                borderTopRightRadius: pastSheetRadius,
              },
              sheetAnimatedStyle,
            ]}
          >
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.sheetTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                  {session.hostname}
                </Text>
                <Text style={[styles.sheetSubtitle, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]} numberOfLines={1}>
                  {session.root}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onClose();
                }}
                activeOpacity={0.7}
                style={[styles.sheetCloseButton, { backgroundColor: colors.bg.base }]}
              >
                <X size={18} color={colors.fg.default} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <View style={styles.sheetActions}>
              <TouchableOpacity
                onPress={() => onOpen(session)}
                activeOpacity={0.75}
                style={[styles.sheetRow, { backgroundColor: colors.bg.raised, borderRadius: radius.lg }]}
              >
                <OpenActionIcon color={colors.fg.default} />
                <Text style={[styles.sheetRowLabel, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                  Open
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onDelete(session)}
                activeOpacity={0.75}
                style={[styles.sheetRow, { backgroundColor: colors.bg.raised, borderRadius: radius.lg }]}
              >
                <DeleteActionIcon color={'#ef4444'} />
                <Text style={[styles.sheetDeleteLabel, { color: '#ef4444', fontFamily: fonts.sans.semibold }]}>
                  Delete
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function PastSessionsSheet({
  visible,
  sessions,
  fonts,
  onOpen,
  onDelete,
  onClose,
}: {
  visible: boolean;
  sessions: PairedSession[];
  fonts: any;
  onOpen: (session: PairedSession) => void;
  onDelete: (session: PairedSession) => void;
  onClose: () => void;
}) {
  const { typography, colors } = useTheme();

  return (
    <InfoSheet
      visible={visible}
      onClose={onClose}
      title="Past Sessions"
      description="Tap to open · Long press to delete"
    >
      {sessions.length === 0 ? (
        <View style={pastSessionsSheetStyles.emptyContainer}>
          <MaterialCommunityIcons name="clock-alert-outline" size={36} color={colors.fg.subtle} style={{ marginBottom: 12 }} />
          <Text style={[pastSessionsSheetStyles.emptyText, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
            No past sessions
          </Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 48 }}>
          {sessions.map((session) => (
            <TouchableOpacity
              key={session.sessionPassword}
              onPress={() => onOpen(session)}
              onLongPress={() => onDelete(session)}
              delayLongPress={250}
              activeOpacity={0.75}
              style={pastSessionsSheetStyles.sessionRow}
            >
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[pastSessionsSheetStyles.sessionHostname, { color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.body }]}>
                  {session.hostname}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 }}>
                  <FontAwesome name="folder" size={11} color={colors.fg.subtle} />
                  <Text numberOfLines={1} style={[pastSessionsSheetStyles.sessionRoot, { color: colors.fg.muted, fontFamily: fonts.sans.regular, flex: 1, fontSize: typography.caption }]}>
                    {session.root.startsWith("/") ? session.root.slice(1) : session.root}
                  </Text>
                </View>
              </View>
              <ChevronRight size={18} color={colors.fg.subtle} strokeWidth={2} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </InfoSheet>
  );
}

export default function Auth() {
  const { colors, fonts, radius, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const ctaRadius = 16;
  const router = useRouter();
  const { getPairedSessions, removePairedSession, resumeSession, revokePairedSession, status, capabilities, disconnect } = useConnection();
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;
  const [pairedSessions, setPairedSessions] = useState<PairedSession[]>([]);
  const [isContinuing, setIsContinuing] = useState(false);
  const [connectingHostname, setConnectingHostname] = useState<string | null>(null);
  const [showPastSessionsSheet, setShowPastSessionsSheet] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResponse | null>(null);
  const cancelledContinueRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        BackHandler.exitApp();
        return true;
      });
      return () => sub.remove();
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const paired = await getPairedSessions();
        logger.info("auth", "loaded past sessions for auth screen", {
          count: paired.length,
          hosts: paired.map((session) => session.hostname),
          roots: paired.map((session) => session.root),
        });
        if (!cancelled) {
          setPairedSessions(paired);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [getPairedSessions])
  );

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert("Unable to open link", "Please try again later.");
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert("Unable to open link", "Please try again later.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    void (async () => {
      try {
        const response = await fetch(UPDATE_CHECK_URL, {
          method: "GET",
          signal: controller.signal,
        });
        if (!response.ok || response.status !== 200) return;
        const payload: unknown = await response.json();
        if (!isUpdateCheckResponse(payload)) return;
        setAvailableUpdate(payload);
      } catch {
        // Ignore update check failures and timeouts.
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (status === "connected" && capabilities) {
      logger.info("auth", "connection ready; routing to workspace", {
        rootDir: capabilities.rootDir,
        hostname: capabilities.hostname,
      });
      setIsContinuing(false);
      setConnectingHostname(null);
      router.replace("/workspace");
    }
  }, [status, capabilities, router]);

  const handlePairedSession = useCallback(async (session: PairedSession) => {
    if (isContinuing) return;
    cancelledContinueRef.current = false;
    setIsContinuing(true);
    setConnectingHostname(session.hostname);
    try {
      await resumeSession(session);
    } catch (error) {
      if (cancelledContinueRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      const isExpiredSession = /invalid stored session|failed \(404\)|expired|revoked|password revoked|connection closed during setup|session unavailable/i.test(message);
      logger.error("auth", "resume paired session failed", {
        error: message,
        hostname: session.hostname,
        root: session.root,
        isExpiredSession,
      });
      if (isExpiredSession) {
        await removePairedSession(session.sessionPassword);
        setPairedSessions((current) => current.filter((entry) => entry.sessionPassword !== session.sessionPassword));
        Alert.alert("Session Unavailable", "That saved connection is no longer available. Please scan again.");
      } else {
        Alert.alert("Unable to Connect", "Could not reach the session right now. Please try again.");
      }
    } finally {
      setIsContinuing(false);
      setConnectingHostname(null);
    }
  }, [isContinuing, removePairedSession, resumeSession]);

  const handleCancelContinue = useCallback(() => {
    if (!isContinuing) return;
    cancelledContinueRef.current = true;
    setIsContinuing(false);
    setConnectingHostname(null);
    disconnect();
  }, [disconnect, isContinuing]);

  const handleDeleteSession = useCallback(async (session: PairedSession) => {
    try {
      await revokePairedSession(session.sessionPassword);
      await removePairedSession(session.sessionPassword);
      setPairedSessions((current) => current.filter((entry) => entry.sessionPassword !== session.sessionPassword));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete saved session.";
      Alert.alert("Unable to Delete", message);
    }
  }, [removePairedSession, revokePairedSession]);


  const handleSessionPress = useCallback((session: PairedSession) => {
    setShowPastSessionsSheet(false);
    setTimeout(() => {
      Alert.alert(
        'Connect to Session',
        `${session.hostname}\n${session.root}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Connect',
            onPress: () => {
              setTimeout(() => {
                void handlePairedSession(session);
              }, 100);
            },
          },
        ]
      );
    }, 280);
  }, [handlePairedSession]);

  const handleSessionLongPress = useCallback((session: PairedSession) => {
    Alert.alert(
      "Delete saved session?",
      `${session.hostname}\n${session.root}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void handleDeleteSession(session);
          },
        },
      ]
    );
  }, [handleDeleteSession]);

  useEffect(() => {
    logger.info("auth", "rendering past sessions list", {
      count: pairedSessions.length,
      hosts: pairedSessions.map((session) => session.hostname),
      roots: pairedSessions.map((session) => session.root),
    });
  }, [pairedSessions]);



  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base, paddingTop: insets.top }]}>
      {availableUpdate ? (
        <View
          style={[
            styles.updateBannerOverlay,
            {
              backgroundColor: colors.bg.base,
            },
          ]}
        >
          <Text style={[styles.updateBannerTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
            Oops, your app is too outdated and needs to be updated
          </Text>
          <TouchableOpacity
            onPress={() => openExternalUrl(getPreferredUpdateUrl(availableUpdate))}
            activeOpacity={0.75}
            style={[
              styles.updateBannerButton,
              {
                backgroundColor: colors.fg.default,
                borderRadius: ctaRadius,
              },
            ]}
          >
            <Text style={[styles.updateBannerButtonText, { color: colors.bg.base, fontFamily: fonts.sans.semibold }]}>
              Click here to update
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={[styles.page, isTablet && styles.pageTablet, { paddingBottom: Math.max(insets.bottom, 28) }]}>
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
                <Text style={[styles.appName, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                  Lunel
                </Text>
                <Text style={[styles.tagline, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
                  ship from anywhere
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.actionsSection}>
          <View style={styles.buttons}>
            <TouchableOpacity
              onPress={() => router.push("/lunel-connect")}
              activeOpacity={0.75}
              style={[styles.btn, { backgroundColor: colors.fg.default, borderColor: colors.fg.default, borderRadius: ctaRadius }]}
            >
              <ScanLine size={20} color={colors.bg.base} strokeWidth={2} />
              <Text style={[styles.btnText, isTablet && styles.btnTextTablet, { color: colors.bg.base, fontFamily: fonts.sans.medium }]}>
                Scan with Lunel Connect
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowPastSessionsSheet(true)}
              activeOpacity={0.75}
              style={[styles.pastSessionsButton, { backgroundColor: colors.bg.raised, borderRadius: ctaRadius }]}
            >
              <History size={21} color={colors.fg.default} strokeWidth={2} />
              <Text style={[styles.pastSessionsButtonText, { color: colors.fg.default, fontFamily: fonts.sans.medium }]}>
                Past Sessions
              </Text>
            </TouchableOpacity>
          </View>
        </View>

<Text style={[styles.legal, isTablet && styles.legalTablet, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
          By continuing, you agree to our{" "}
          <Text style={[styles.legalLink, { color: colors.fg.default, fontFamily: fonts.sans.regular }]} onPress={() => openExternalUrl(TERMS_URL)}>
            Terms of Service
          </Text>
          {" "}and{" "}
          <Text style={[styles.legalLink, { color: colors.fg.default, fontFamily: fonts.sans.regular }]} onPress={() => openExternalUrl(PRIVACY_URL)}>
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
      <PastSessionsSheet
        visible={showPastSessionsSheet}
        sessions={pairedSessions}
        fonts={fonts}
        onOpen={handleSessionPress}
        onDelete={handleSessionLongPress}
        onClose={() => setShowPastSessionsSheet(false)}
      />
      {isContinuing && connectingHostname && (
        <View style={styles.loadingOverlay}>
          <View style={[styles.loadingCard, { backgroundColor: colors.bg.raised }]}>
            <Text style={[styles.loadingTitle, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
              Connecting
            </Text>
            <Text style={[styles.loadingSubtitle, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
              {`Connecting to ${connectingHostname}...`}
            </Text>
            <TouchableOpacity
              onPress={handleCancelContinue}
              activeOpacity={0.75}
              style={[styles.loadingCancelButton, { backgroundColor: isDark ? "#FFFFFF" : "#000000" }]}
            >
              <Text style={[styles.loadingCancelText, { color: isDark ? "#000000" : "#FFFFFF", fontFamily: fonts.sans.semibold }]}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  updateBannerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  page: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 28,
    justifyContent: "space-between",
  },
  updateBannerTitle: {
    fontSize: 20,
    lineHeight: 28,
    textAlign: "center",
    maxWidth: 420,
  },
  updateBannerButton: {
    minWidth: 220,
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  updateBannerButtonText: {
    fontSize: 15,
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
  appIconWrapper: {
    marginBottom: 8,
    overflow: "hidden",
  },
  appName: {
    fontSize: 24,
    letterSpacing: 0.3,
    textAlign: "center",
  },
  appNameTablet: {
    fontSize: 24,
  },
  tagline: {
    fontSize: 13,
    letterSpacing: 0.2,
    textAlign: "center",
  },
  taglineTablet: {
    fontSize: 17,
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
  btnSecondary: {
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.2)",
    backgroundColor: "rgba(0,0,0,0.04)",
    marginTop: 12,
  },
  btnSecondaryText: {
    fontSize: 13,
    color: "#111111",
  },
  pastSessionsButton: {
    borderWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 15,
  },
  pastSessionsButtonText: {
    fontSize: 15,
  },
  emptySessionsContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  emptySessionsText: {
    fontSize: 14,
    textAlign: "center",
  },
  savedSessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
  },
  savedSessionLine: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  savedSessionLineMeta: {
    fontSize: 12,
  },
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheetContainer: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 0,
    minHeight: 220,
  },
  pastSessionsSheetContainer: {
    height: "55%",
  },
  sheetSessionsScroll: {
    flexGrow: 0,
  },
  sheetSessionsContent: {
    paddingHorizontal: 8,
    paddingBottom: 56,
    gap: 10,
  },
  pastSessionsHeader: {
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 14,
    gap: 12,
  },
  sheetTitle: {
    fontSize: 20,
  },
  sheetSubtitle: {
    marginTop: 2,
    fontSize: 12,
  },
  sheetCloseButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetActions: {
    paddingHorizontal: 8,
    paddingBottom: 20,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 4,
    gap: 10,
  },
  sheetRowLabel: {
    fontSize: 15,
  },
  sheetDeleteLabel: {
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
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  loadingCard: {
    width: "88%",
    maxWidth: 330,
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 20,
    borderRadius: 15,
  },
  loadingTitle: {
    fontSize: 16,
    textAlign: "center",
  },
  loadingSubtitle: {
    fontSize: 12,
    textAlign: "center",
  },
  loadingCancelButton: {
    marginTop: 2,
    width: "100%",
    minHeight: 50,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
  loadingCancelText: {
    fontSize: 14,
  },
});

const pastSessionsSheetStyles = StyleSheet.create({
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderRadius: 12,
    marginBottom: 8,
  },
  sessionHostname: {
    fontSize: 14,
    lineHeight: 20,
    color: "#FFFFFF",
  },
  sessionRoot: {
    fontSize: 12,
    color: "rgba(255,255,255,0.45)",
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: SCREEN_HEIGHT * 0.32,
    paddingBottom: SCREEN_HEIGHT * 0.1,
  },
  emptyText: {
    fontSize: 14,
    color: "rgba(255,255,255,0.4)",
    textAlign: "center",
  },
});
