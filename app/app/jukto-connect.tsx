import { useTheme } from "@/contexts/ThemeContext";
import Toast from "@/components/Toast";
import InfoSheet from "@/components/InfoSheet";
import InputModal from "@/components/InputModal";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { LoaderCircle, Terminal, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Entypo from "@expo/vector-icons/Entypo";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import * as NavigationBar from "expo-navigation-bar";
import Svg, { Path, Rect } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "../contexts/ConnectionContext";
import { useTranslation } from "react-i18next";

const TABLET_BREAKPOINT = 768;
const WHITE = "#FFFFFF";
const BLACK = "#000000";
const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const AnimatedRect = Animated.createAnimatedComponent(Rect);

function CopyableCommand({
  command,
  fonts,
  colors,
}: {
  command: string;
  fonts: ReturnType<typeof useTheme>["fonts"];
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <View
      style={{
        backgroundColor: colors.bg.raised,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Terminal size={14} color={colors.fg.muted} strokeWidth={2} />
      <Text
        style={{
          fontFamily: fonts.mono.regular,
          fontSize: 12,
          color: colors.fg.default,
          flex: 1,
        }}
      >
        {command}
      </Text>
      <Pressable
        onPress={handleCopy}
        hitSlop={8}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        {copied ? (
          <Ionicons name="checkmark" size={14} color={colors.fg.muted} />
        ) : (
          <Ionicons name="copy-outline" size={14} color={colors.fg.muted} />
        )}
      </Pressable>
    </View>
  );
}

const JuktoConnect = () => {
  const router = useRouter();
  const { colors, fonts, typography } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { connect, status, capabilities } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const hasRequestedPermissionRef = useRef(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [learnButtonFrame, setLearnButtonFrame] = useState({
    width: 0,
    height: 0,
  });
  const learnBorderProgress = useMemo(() => new Animated.Value(0), []);

  const hasActiveConnectAttemptRef = useRef(false);
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;
  const cornerBeat = useMemo(() => new Animated.Value(0), []);
  const cornerGap = useMemo(() => new Animated.Value(0), []);
  const cameraOpacity = useMemo(() => new Animated.Value(0), []);
  const loaderRotation = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    if (Platform.OS === "android") {
      NavigationBar.setStyle("dark");
    }
  }, []);

  useEffect(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.spring(cornerGap, {
      toValue: 14,
      useNativeDriver: true,
      tension: 80,
      friction: 7,
    }).start();
  }, []);

  useEffect(() => {
    if (permission && !permission.granted && !hasRequestedPermissionRef.current) {
      hasRequestedPermissionRef.current = true;
      requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    if (status === "connected" && capabilities) {
      router.replace("/workspace");
    }
  }, [status, capabilities, router]);

  useEffect(() => {
    const beatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(cornerBeat, {
          toValue: 1,
          duration: 650,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(cornerBeat, {
          toValue: 0,
          duration: 650,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );
    beatLoop.start();
    return () => beatLoop.stop();
  }, [cornerBeat]);

  useEffect(() => {
    if (isConnecting) {
      const loop = Animated.loop(
        Animated.timing(loaderRotation, {
          toValue: 1,
          duration: 800,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      loop.start();
      return () => loop.stop();
    } else {
      loaderRotation.setValue(0);
    }
  }, [isConnecting, loaderRotation]);

  useEffect(() => {
    learnBorderProgress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(learnBorderProgress, {
        toValue: 1,
        duration: 2400,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [learnBorderProgress]);

  const loaderSpin = loaderRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  const learnBorderInset = 1;
  const learnSweepStrokeWidth = 1.2;
  const learnBorderRadius =
    learnButtonFrame.height > 0 ? learnButtonFrame.height / 2 : 999;
  const learnSweepWidth = Math.max(
    1,
    learnButtonFrame.width - learnBorderInset * 2,
  );
  const learnSweepHeight = Math.max(
    1,
    learnButtonFrame.height - learnBorderInset * 2,
  );
  const learnSweepRadius = Math.max(
    0,
    Math.min(
      learnBorderRadius - learnBorderInset,
      learnSweepWidth / 2,
      learnSweepHeight / 2,
    ),
  );
  const learnBorderPerimeter =
    learnButtonFrame.width > 0 && learnButtonFrame.height > 0
      ? (() => {
          const r = learnSweepRadius;
          const straightW = Math.max(0, learnSweepWidth - 2 * r);
          const straightH = Math.max(0, learnSweepHeight - 2 * r);
          return 2 * (straightW + straightH) + 2 * Math.PI * r;
        })()
      : 0;
  const learnBorderSegment = Math.max(32, learnBorderPerimeter * 0.18);
  const learnBorderGap = Math.max(1, learnBorderPerimeter - learnBorderSegment);
  const learnBorderOffset = learnBorderProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -learnBorderPerimeter],
  });

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (isConnecting || hasActiveConnectAttemptRef.current) return;
    console.log("[jukto-connect] scanned:", JSON.stringify(data));
    handleConnectWithCode(data);
  };

  const handleConnectWithCode = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setToastMessage(t("juktoConnect.errorEmptyCode"));
      setToastVisible(true);
      return;
    }

    hasActiveConnectAttemptRef.current = true;
    setIsConnecting(true);

    try {
      if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
        throw new Error("Invalid connection URL. Scan a QR code from the CLI.");
      }

      const afterProto = trimmed.slice(trimmed.indexOf("://") + 3);
      const slashIdx = afterProto.indexOf("/");
      if (slashIdx === -1) {
        throw new Error("Invalid connection URL (missing secret).");
      }

      const host = afterProto.slice(0, slashIdx);
      const secret = afterProto.slice(slashIdx + 1).split("/")[0];
      if (!secret) {
        throw new Error("Invalid connection URL (missing secret).");
      }

      const protocol = trimmed.startsWith("wss") ? "wss" : "ws";
      await connect(`${protocol}://${host}`, secret);
      hasActiveConnectAttemptRef.current = false;
    } catch (err) {
      hasActiveConnectAttemptRef.current = false;
      const message =
        err instanceof Error
          ? err.message
          : t("juktoConnect.errorConnectionFailed");
      setToastMessage(message);
      setToastVisible(true);
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={styles.container}>
        {/* Upper — Camera */}
        <View style={styles.upper}>
          {permission?.granted && (
            <Animated.View
              style={[StyleSheet.absoluteFill, { opacity: cameraOpacity }]}
            >
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                onCameraReady={() => {
                  Animated.timing(cameraOpacity, {
                    toValue: 1,
                    duration: 300,
                    useNativeDriver: true,
                  }).start();
                }}
                onBarcodeScanned={
                  isConnecting ? undefined : handleBarCodeScanned
                }
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              />
            </Animated.View>
          )}

          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
            <TouchableOpacity
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.back();
              }}
              style={styles.backButton}
            >
              <X size={28} color={WHITE} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Overlay with scan cutout */}
          {(() => {
            const scanSize = isTablet
              ? Math.min(width * 0.35, 280)
              : width * 0.7;
            const scanTop = insets.top + 130;
            const sideWidth = (width - scanSize) / 2;
            return (
              <>
                <Svg
                  width={width}
                  height={SCREEN_HEIGHT}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                >
                  <Path
                    fillRule="evenodd"
                    d={[
                      `M 0 0 H ${width} V ${SCREEN_HEIGHT} H 0 Z`,
                      `M ${sideWidth + 12} ${scanTop}`,
                      `H ${sideWidth + scanSize - 12}`,
                      `A 12 12 0 0 1 ${sideWidth + scanSize} ${scanTop + 12}`,
                      `V ${scanTop + scanSize - 12}`,
                      `A 12 12 0 0 1 ${sideWidth + scanSize - 12} ${scanTop + scanSize}`,
                      `H ${sideWidth + 12}`,
                      `A 12 12 0 0 1 ${sideWidth} ${scanTop + scanSize - 12}`,
                      `V ${scanTop + 12}`,
                      `A 12 12 0 0 1 ${sideWidth + 12} ${scanTop}`,
                      `Z`,
                    ].join(" ")}
                    fill="rgba(0,0,0,0.55)"
                  />
                </Svg>

                {/* Corner brackets */}
                {[
                  {
                    top: scanTop,
                    left: sideWidth,
                    tx: Animated.multiply(cornerGap, -1),
                    ty: Animated.multiply(cornerGap, -1),
                    borderTopLeftRadius: 22,
                    borderTopWidth: 6,
                    borderLeftWidth: 6,
                    borderRightWidth: 0,
                    borderBottomWidth: 0,
                  },
                  {
                    top: scanTop,
                    left: sideWidth + scanSize - 58,
                    tx: cornerGap,
                    ty: Animated.multiply(cornerGap, -1),
                    borderTopRightRadius: 22,
                    borderTopWidth: 6,
                    borderRightWidth: 6,
                    borderLeftWidth: 0,
                    borderBottomWidth: 0,
                  },
                  {
                    top: scanTop + scanSize - 58,
                    left: sideWidth,
                    tx: Animated.multiply(cornerGap, -1),
                    ty: cornerGap,
                    borderBottomLeftRadius: 22,
                    borderBottomWidth: 6,
                    borderLeftWidth: 6,
                    borderTopWidth: 0,
                    borderRightWidth: 0,
                  },
                  {
                    top: scanTop + scanSize - 58,
                    left: sideWidth + scanSize - 58,
                    tx: cornerGap,
                    ty: cornerGap,
                    borderBottomRightRadius: 22,
                    borderBottomWidth: 6,
                    borderRightWidth: 6,
                    borderTopWidth: 0,
                    borderLeftWidth: 0,
                  },
                ].map(({ tx, ty, ...corner }, i) => (
                  <Animated.View
                    key={i}
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      width: 58,
                      height: 58,
                      borderColor: WHITE,
                      transform: [{ translateX: tx }, { translateY: ty }],
                      ...corner,
                    }}
                  />
                ))}

                {/* Enter URL button */}
                <TouchableOpacity
                  onPress={() => setShowUrlInput(true)}
                  activeOpacity={0.8}
                  style={{
                    position: "absolute",
                    top: scanTop + scanSize + 70,
                    left: sideWidth + 32,
                    right: width - sideWidth - scanSize + 32,
                    backgroundColor: WHITE,
                    borderRadius: 999,
                    paddingVertical: 14,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: BLACK,
                      fontSize: 15,
                      fontFamily: fonts.sans.semibold,
                    }}
                  >
                    {t("juktoConnect.enterUrl")}
                  </Text>
                </TouchableOpacity>

                {/* Overlays inside the scan area */}
                <View
                  style={{
                    position: "absolute",
                    top: scanTop,
                    left: sideWidth,
                    width: scanSize,
                    height: scanSize,
                  }}
                >
                  {permission && !permission.granted && (
                    <View style={styles.permissionOverlay}>
                      <View style={styles.permissionIconWrapper}>
                        <MaterialCommunityIcons
                          name="camera-off"
                          size={28}
                          color={WHITE}
                        />
                      </View>
                      <Text style={styles.permissionOverlayTitle}>
                        {t("juktoConnect.cameraAccessTitle")}
                      </Text>
                      <Text style={styles.permissionOverlayDesc}>
                        {t("juktoConnect.cameraAccessDesc")}
                      </Text>
                    </View>
                  )}
                  {isConnecting && (
                    <View style={styles.scanningOverlay}>
                      <Animated.View
                        style={{ transform: [{ rotate: loaderSpin }] }}
                      >
                        <LoaderCircle size={24} color={WHITE} strokeWidth={2} />
                      </Animated.View>
                      <Text style={styles.connectingText}>
                        {t("juktoConnect.connecting")}
                      </Text>
                    </View>
                  )}
                </View>
              </>
            );
          })()}

          {/* Learn how to connect button */}
          <View
            style={[
              styles.cliHintRow,
              { bottom: Math.max(insets.bottom + 20, 40) },
            ]}
          >
            <TouchableOpacity
              style={styles.learnButton}
              onLayout={(event) => {
                const { width: layoutWidth, height: layoutHeight } =
                  event.nativeEvent.layout;
                setLearnButtonFrame({
                  width: layoutWidth,
                  height: layoutHeight,
                });
              }}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setShowGuide(true);
              }}
              activeOpacity={0.8}
            >
              {learnButtonFrame.width > 0 && learnButtonFrame.height > 0 && (
                <Svg
                  pointerEvents="none"
                  width={learnButtonFrame.width}
                  height={learnButtonFrame.height}
                  style={styles.learnButtonBorderOverlay}
                >
                  <AnimatedRect
                    x={learnBorderInset}
                    y={learnBorderInset}
                    width={learnSweepWidth}
                    height={learnSweepHeight}
                    rx={learnSweepRadius}
                    ry={learnSweepRadius}
                    fill="none"
                    stroke="rgba(255,255,255,0.95)"
                    strokeWidth={learnSweepStrokeWidth}
                    strokeLinecap="butt"
                    strokeLinejoin="round"
                    strokeDasharray={`${learnBorderSegment} ${learnBorderGap}`}
                    strokeDashoffset={learnBorderOffset as any}
                  />
                </Svg>
              )}
              <Entypo name="info-with-circle" size={17} color={WHITE} />
              <Text
                style={[styles.learnButtonText, { fontSize: typography.body }]}
              >
                {t("juktoConnect.learnHow")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <Toast
          visible={toastVisible}
          message={toastMessage}
          onHide={() => setToastVisible(false)}
        />

        {/* How to connect guide */}
        <InfoSheet
          visible={showGuide}
          onClose={() => setShowGuide(false)}
          title={t("juktoConnect.howToConnectTitle")}
          description={t("juktoConnect.howToConnectSubtitle")}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 100 }}
          >
            {/* Steps */}
            <View>
              {/* Step 1 */}
              <View style={{ flexDirection: "row", gap: 14 }}>
                <View style={{ alignItems: "center", width: 22 }}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      backgroundColor: colors.bg.raised,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontFamily: fonts.sans.semibold,
                        color: colors.fg.muted,
                      }}
                    >
                      1
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 1,
                      flex: 1,
                      backgroundColor: colors.fg.default + "12",
                      marginTop: 4,
                      marginBottom: 4,
                    }}
                  />
                </View>
                <View style={{ flex: 1, paddingBottom: 20 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontFamily: fonts.sans.semibold,
                      color: colors.fg.default,
                      marginBottom: 4,
                      lineHeight: 22,
                    }}
                  >
                    {t("juktoConnect.step1Title")}
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      fontFamily: fonts.sans.regular,
                      color: colors.fg.muted,
                      lineHeight: 20,
                    }}
                  >
                    {t("juktoConnect.step1Desc")}
                  </Text>
                </View>
              </View>

              {/* Step 2 */}
              <View style={{ flexDirection: "row", gap: 14 }}>
                <View style={{ alignItems: "center", width: 22 }}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      backgroundColor: colors.bg.raised,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontFamily: fonts.sans.semibold,
                        color: colors.fg.muted,
                      }}
                    >
                      2
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 1,
                      flex: 1,
                      backgroundColor: colors.fg.default + "12",
                      marginTop: 4,
                      marginBottom: 4,
                    }}
                  />
                </View>
                <View style={{ flex: 1, paddingBottom: 20 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontFamily: fonts.sans.semibold,
                      color: colors.fg.default,
                      marginBottom: 4,
                      lineHeight: 22,
                    }}
                  >
                    {t("juktoConnect.step2Title")}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      fontFamily: fonts.sans.regular,
                      color: colors.fg.muted,
                      lineHeight: 18,
                      marginBottom: 8,
                    }}
                  >
                    {t("juktoConnect.step2Desc")}
                  </Text>
                  <CopyableCommand
                    command="npx jukto-cli"
                    fonts={fonts}
                    colors={colors}
                  />
                  <Text
                    style={{
                      fontSize: 12,
                      fontFamily: fonts.sans.regular,
                      color: colors.fg.muted,
                      lineHeight: 18,
                      marginTop: 8,
                      marginBottom: 6,
                    }}
                  >
                    {t("juktoConnect.needFreshCode")}
                  </Text>
                  <CopyableCommand
                    command="npx jukto-cli -n"
                    fonts={fonts}
                    colors={colors}
                  />
                </View>
              </View>

              {/* Step 3 */}
              <View style={{ flexDirection: "row", gap: 14 }}>
                <View style={{ alignItems: "center", width: 22 }}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      backgroundColor: colors.bg.raised,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontFamily: fonts.sans.semibold,
                        color: colors.fg.muted,
                      }}
                    >
                      3
                    </Text>
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontFamily: fonts.sans.semibold,
                      color: colors.fg.default,
                      marginBottom: 4,
                      lineHeight: 22,
                    }}
                  >
                    {t("juktoConnect.step3Title")}
                  </Text>
                  <Text
                    style={{
                      fontSize: 13,
                      fontFamily: fonts.sans.regular,
                      color: colors.fg.muted,
                      lineHeight: 20,
                    }}
                  >
                    {t("juktoConnect.step3Desc")}
                  </Text>
                </View>
              </View>
            </View>

            {/* Done */}
            <View style={{ marginTop: 24 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontFamily: fonts.sans.regular,
                  color: colors.fg.muted,
                  lineHeight: 20,
                }}
              >
                {t("juktoConnect.onceConnected")}
              </Text>
            </View>

            {/* YouTube */}
            <Pressable
              onPress={() =>
                Linking.openURL(
                  "https://youtu.be/LKQ8L98BE20?si=tKmrHR_32jkl0FxJ",
                )
              }
              style={({ pressed }) => ({
                marginHorizontal: 0,
                marginTop: 20,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <FontAwesome
                name="youtube-play"
                size={15}
                color={colors.fg.muted}
              />
              <Text
                style={{
                  fontSize: 13,
                  fontFamily: fonts.sans.regular,
                  color: colors.fg.muted,
                }}
              >
                {t("juktoConnect.watchTutorial")}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={13}
                color={colors.fg.muted}
                style={{ marginLeft: -4 } as any}
              />
            </Pressable>
          </ScrollView>
        </InfoSheet>

        <InputModal
          visible={showUrlInput}
          title={t("juktoConnect.enterUrl")}
          description={t("juktoConnect.enterUrlDesc")}
          placeholder={t("juktoConnect.enterUrlPlaceholder")}
          acceptLabel={t("juktoConnect.connect")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setShowUrlInput(false)}
          onAccept={(url) => {
            setShowUrlInput(false);
            if (url.trim()) handleConnectWithCode(url.trim());
          }}
        />
      </View>
    </TouchableWithoutFeedback>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  upper: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  cliHintRow: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  learnButton: {
    position: "relative",
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  learnButtonBorderOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  learnButtonText: {
    fontSize: 15,
    color: WHITE,
    fontWeight: "600",
    letterSpacing: 0.2,
  },

  permissionOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    gap: 10,
  },
  permissionIconWrapper: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  permissionOverlayTitle: {
    color: WHITE,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: 0.2,
  },
  permissionOverlayDesc: {
    color: WHITE,
    fontSize: 12,
    textAlign: "center",
    opacity: 0.5,
    lineHeight: 18,
  },
  scanningOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  connectingText: {
    color: WHITE,
    fontSize: 14,
    marginTop: 12,
    opacity: 0.9,
  },
});

export default JuktoConnect;
