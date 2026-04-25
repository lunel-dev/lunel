import { useTheme } from "@/contexts/ThemeContext";
import Toast from "@/components/Toast";
import InfoSheet from "@/components/InfoSheet";
import InputModal from "@/components/InputModal";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { AlertCircle, ArrowLeft, ArrowRight, Info, LoaderCircle, QrCode, Terminal, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import ReAnimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS } from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useKeyboardHandler } from "react-native-keyboard-controller";


const TABLET_BREAKPOINT = 768;
const WHITE = "#FFFFFF";
const BLACK = "#000000";
const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const AnimatedRect = Animated.createAnimatedComponent(Rect);

function CopyableCommand({ command, fonts, colors }: { command: string; fonts: ReturnType<typeof useTheme>["fonts"]; colors: ReturnType<typeof useTheme>["colors"] }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <View style={{ backgroundColor: colors.bg.raised, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Terminal size={14} color={colors.fg.muted} strokeWidth={2} />
      <Text style={{ fontFamily: fonts.mono.regular, fontSize: 12, color: colors.fg.default, flex: 1 }}>
        {command}
      </Text>
      <Pressable onPress={handleCopy} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
        {copied
          ? <Ionicons name="checkmark" size={14} color={colors.fg.muted} />
          : <Ionicons name="copy-outline" size={14} color={colors.fg.muted} />
        }
      </Pressable>
    </View>
  );
}

const LunelConnect = () => {
  const router = useRouter();
  const { colors, fonts, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const {
    connect,
    status,
    capabilities,
  } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [manualCode, setManualCode] = useState("");
  const [hasRequestedPermission, setHasRequestedPermission] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [learnButtonFrame, setLearnButtonFrame] = useState({ width: 0, height: 0 });
  const keyboardHeight = useSharedValue(0);
  const bottomInset = insets.bottom;
  const learnBorderProgress = useRef(new Animated.Value(0)).current;

  useKeyboardHandler(
    {
      onMove: e => {
        'worklet'
        keyboardHeight.value = e.height;
      },
      onEnd: e => {
        'worklet'
        keyboardHeight.value = e.height;
      },
    },
    [],
  );

  const lowerAnimatedStyle = useAnimatedStyle(() => ({
    bottom: Math.max(0, keyboardHeight.value - bottomInset),
  }));

  const hasActiveConnectAttemptRef = useRef(false);
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;
  const cornerBeat = useRef(new Animated.Value(0)).current;
  const cornerGap = useRef(new Animated.Value(0)).current;
  const cameraOpacity = useRef(new Animated.Value(0)).current;
  const loaderRotation = useRef(new Animated.Value(0)).current;

  const cornerOut = cornerBeat.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 7],
  });
  const cornerOutNeg = cornerBeat.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -7],
  });
  const cornerScale = cornerBeat.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });

  useEffect(() => {
    if (Platform.OS === "android") {
      NavigationBar.setBackgroundColorAsync(BLACK);
      NavigationBar.setButtonStyleAsync("light");
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
    if (permission && !permission.granted && !hasRequestedPermission) {
      requestPermission();
      setHasRequestedPermission(true);
    }
  }, [permission, requestPermission, hasRequestedPermission]);

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
        })
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
      })
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
  const learnBorderRadius = learnButtonFrame.height > 0 ? learnButtonFrame.height / 2 : 999;
  const learnSweepWidth = Math.max(1, learnButtonFrame.width - (learnBorderInset * 2));
  const learnSweepHeight = Math.max(1, learnButtonFrame.height - (learnBorderInset * 2));
  const learnSweepRadius = Math.max(0, Math.min(learnBorderRadius - learnBorderInset, learnSweepWidth / 2, learnSweepHeight / 2));
  const learnBorderPerimeter = learnButtonFrame.width > 0 && learnButtonFrame.height > 0
    ? (() => {
      const r = learnSweepRadius;
      const straightW = Math.max(0, learnSweepWidth - (2 * r));
      const straightH = Math.max(0, learnSweepHeight - (2 * r));
      return (2 * (straightW + straightH)) + (2 * Math.PI * r);
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
    setManualCode(data);
    handleConnectWithCode(data);
  };

  const handleConnectWithCode = async (code: string) => {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setToastMessage("Please enter a connection code.");
      setToastVisible(true);
      return;
    }
    hasActiveConnectAttemptRef.current = true;
    setIsConnecting(true);
    setError(null);
    try {
      await connect(trimmedCode);
      hasActiveConnectAttemptRef.current = false;
    } catch (err) {
      hasActiveConnectAttemptRef.current = false;
      setError(err instanceof Error ? err.message : "Connection failed");
      setToastMessage("Something went wrong, please try again.");
      setToastVisible(true);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleConnect = () => {
    handleConnectWithCode(manualCode);
  };


  const isButtonDisabled = !manualCode.trim() || isConnecting;

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
    <View style={styles.container}>

      {/* Upper — Camera */}
      <View style={styles.upper}>
        {permission?.granted && (
          <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: cameraOpacity }]}>
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              onCameraReady={() => {
                Animated.timing(cameraOpacity, {
                  toValue: 1,
                  duration: 300,
                  useNativeDriver: true,
                }).start();
              }}
              onBarcodeScanned={isConnecting ? undefined : handleBarCodeScanned}
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
          const scanSize = isTablet ? Math.min(width * 0.35, 280) : width * 0.70;
          const scanTop = insets.top + 130;
          const sideWidth = (width - scanSize) / 2;
          return (
            <>
              <Svg
                width={width}
                height={SCREEN_HEIGHT}
                style={StyleSheet.absoluteFillObject}
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
                { top: scanTop,            left: sideWidth,                       tx: Animated.multiply(cornerGap, -1), ty: Animated.multiply(cornerGap, -1), borderTopLeftRadius: 22,     borderTopWidth: 6, borderLeftWidth: 6,  borderRightWidth: 0, borderBottomWidth: 0 },
                { top: scanTop,            left: sideWidth + scanSize - 58,       tx: cornerGap,                        ty: Animated.multiply(cornerGap, -1), borderTopRightRadius: 22,    borderTopWidth: 6, borderRightWidth: 6, borderLeftWidth: 0,  borderBottomWidth: 0 },
                { top: scanTop + scanSize - 58, left: sideWidth,                  tx: Animated.multiply(cornerGap, -1), ty: cornerGap,                        borderBottomLeftRadius: 22,  borderBottomWidth: 6, borderLeftWidth: 6,  borderTopWidth: 0, borderRightWidth: 0 },
                { top: scanTop + scanSize - 58, left: sideWidth + scanSize - 58,  tx: cornerGap,                        ty: cornerGap,                        borderBottomRightRadius: 22, borderBottomWidth: 6, borderRightWidth: 6, borderTopWidth: 0, borderLeftWidth: 0 },
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

              {/* Enter code button */}
              <TouchableOpacity
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (Platform.OS === "ios") {
                    Alert.prompt(
                      "Enter code",
                      "Type the code shown in your terminal",
                      [
                        { text: "Cancel", style: "cancel" },
                        { text: "Connect", onPress: (code) => { if (code?.trim()) handleConnectWithCode(code.trim()); } },
                      ],
                      "plain-text",
                      "",
                      "default"
                    );
                  } else {
                    setShowCodeInput(true);
                  }
                }}
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
                <Text style={{ color: BLACK, fontSize: 15, fontFamily: fonts.sans.semibold }}>Enter code</Text>
              </TouchableOpacity>

              {/* Overlays inside the scan area */}
              <View style={{ position: "absolute", top: scanTop, left: sideWidth, width: scanSize, height: scanSize }}>
                {permission && !permission.granted && (
                  <View style={styles.permissionOverlay}>
                    <View style={styles.permissionIconWrapper}>
                      <MaterialCommunityIcons name="camera-off" size={28} color={WHITE} />
                    </View>
                    <Text style={styles.permissionOverlayTitle}>
                      Camera Access Required
                    </Text>
                    <Text style={styles.permissionOverlayDesc}>
                      This app uses the camera to scan a QR code to securely connect
                      the app to your development environment or codebase.
                    </Text>
                  </View>
                )}
                {isConnecting && (
                  <View style={styles.scanningOverlay}>
                    <Animated.View style={{ transform: [{ rotate: loaderSpin }] }}>
                      <LoaderCircle size={24} color={WHITE} strokeWidth={2} />
                    </Animated.View>
                    <Text style={styles.connectingText}>Connecting...</Text>
                  </View>
                )}
              </View>
            </>
          );
        })()}

        {/* Learn how to connect button */}
        <View style={[styles.cliHintRow, { bottom: Math.max(insets.bottom + 20, 40) }]}>
          <TouchableOpacity
            style={styles.learnButton}
            onLayout={(event) => {
              const { width: layoutWidth, height: layoutHeight } = event.nativeEvent.layout;
              setLearnButtonFrame({ width: layoutWidth, height: layoutHeight });
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
            <Text style={[styles.learnButtonText, { fontSize: typography.body }]}>Learn how to connect</Text>
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
        title="How to connect"
        description="Run one command, scan a QR, you're in"
      >
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>

          {/* Steps */}
          <View>

            {/* Step 1 */}
            <View style={{ flexDirection: "row", gap: 14 }}>
              <View style={{ alignItems: "center", width: 22 }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: colors.bg.raised, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: fonts.sans.semibold, color: colors.fg.muted }}>1</Text>
                </View>
                <View style={{ width: 1, flex: 1, backgroundColor: colors.fg.default + "12", marginTop: 4, marginBottom: 4 }} />
              </View>
              <View style={{ flex: 1, paddingBottom: 20 }}>
                <Text style={{ fontSize: 14, fontFamily: fonts.sans.semibold, color: colors.fg.default, marginBottom: 4, lineHeight: 22 }}>
                  Open your terminal on your PC
                </Text>
                <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 20 }}>
                  Navigate to the repository where you want Lunel to work
                </Text>
              </View>
            </View>

            {/* Step 2 */}
            <View style={{ flexDirection: "row", gap: 14 }}>
              <View style={{ alignItems: "center", width: 22 }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: colors.bg.raised, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: fonts.sans.semibold, color: colors.fg.muted }}>2</Text>
                </View>
                <View style={{ width: 1, flex: 1, backgroundColor: colors.fg.default + "12", marginTop: 4, marginBottom: 4 }} />
              </View>
              <View style={{ flex: 1, paddingBottom: 20 }}>
                <Text style={{ fontSize: 14, fontFamily: fonts.sans.semibold, color: colors.fg.default, marginBottom: 4, lineHeight: 22 }}>
                  Run the command
                </Text>
                <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 18, marginBottom: 8 }}>
                  First time in a repo it gives you a QR code to connect. Run it again and it just resumes the last session without a new QR. To reconnect, tap the previous session in the app
                </Text>
                <CopyableCommand command="npx lunel-cli" fonts={fonts} colors={colors} />
                <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 18, marginTop: 8, marginBottom: 6 }}>
                  Need a fresh code?
                </Text>
                <CopyableCommand command="npx lunel-cli -n" fonts={fonts} colors={colors} />
              </View>
            </View>

            {/* Step 3 */}
            <View style={{ flexDirection: "row", gap: 14 }}>
              <View style={{ alignItems: "center", width: 22 }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: colors.bg.raised, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 11, fontFamily: fonts.sans.semibold, color: colors.fg.muted }}>3</Text>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontFamily: fonts.sans.semibold, color: colors.fg.default, marginBottom: 4, lineHeight: 22 }}>
                  Scan or type the code
                </Text>
                <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 20 }}>
                  A QR code and a short code appear in your terminal. Scan with your camera or type the code in the input field and you are in
                </Text>
              </View>
            </View>

          </View>

          {/* Done */}
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 20 }}>
              Once connected, your whole machine lives in your pocket. Ship from the couch, the toilet, anywhere
            </Text>
          </View>

          {/* YouTube */}
          <Pressable
            onPress={() => Linking.openURL("https://youtu.be/LKQ8L98BE20?si=tKmrHR_32jkl0FxJ")}
            style={({ pressed }) => ({
              marginHorizontal: 0,
              marginTop: 20,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <FontAwesome name="youtube-play" size={15} color={colors.fg.muted} />
            <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
              Watch the tutorial on YouTube
            </Text>
            <Ionicons name="chevron-forward" size={13} color={colors.fg.muted} style={{ marginLeft: -4 } as any} />
          </Pressable>

        </ScrollView>
      </InfoSheet>

      <InputModal
        visible={showCodeInput}
        title="Enter code"
        description="Type the code shown in your terminal"
        placeholder="e.g. abc-123-xyz"
        acceptLabel="Connect"
        cancelLabel="Cancel"
        onCancel={() => setShowCodeInput(false)}
        onAccept={(code) => {
          setShowCodeInput(false);
          if (code.trim()) handleConnectWithCode(code.trim());
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
  lower: {
    position: "absolute",
    bottom: 0,
    left: 6,
    right: 6,
    backgroundColor: BLACK,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  arrowButton: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "#4F46E5",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "stretch",
  },
  inputWrapper: {
    flex: 1,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: WHITE,
    borderRadius: 12,
    paddingHorizontal: 18,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: BLACK,
  },
  codeSheetContent: {
    gap: 12,
  },
  codeSheetInput: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  codeSheetButton: {
    height: 48,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
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
  step: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 28,
  },
  stepContent: {
    flex: 1,
    gap: 10,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: WHITE,
  },
  stepDesc: {
    fontSize: 14,
    color: "rgba(255,255,255,0.75)",
    lineHeight: 22,
  },
  codeBlock: {
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 14,
    color: WHITE,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  securityNote: {
    backgroundColor: "rgba(79,70,229,0.15)",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(79,70,229,0.4)",
    marginBottom: 8,
    gap: 6,
  },
  securityNoteText: {
    fontSize: 13,
    color: "rgba(255,255,255,0.7)",
    lineHeight: 20,
  },
  stepNote: {
    fontSize: 13,
    color: "rgba(255,255,255,0.55)",
    lineHeight: 20,
    fontStyle: "italic",
  },
  scanFrame: {
    position: "absolute",
    top: "50%",
    left: "50%",
  },
  corner: {
    position: "absolute",
    width: 50,
    height: 50,
    borderColor: WHITE,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
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

export default LunelConnect;
