import { useTheme } from "@/contexts/ThemeContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import Toast from "@/components/Toast";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { resolveConnectionProfile } from "@/lib/connectionProfiles";
import { AlertCircle, ArrowLeft, ArrowRight, Info, LoaderCircle, QrCode, Server, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from "react-native";
import * as NavigationBar from "expo-navigation-bar";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "../contexts/ConnectionContext";
import ReAnimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useKeyboardHandler } from "react-native-keyboard-controller";


const TABLET_BREAKPOINT = 768;
const WHITE = "#FFFFFF";
const BLACK = "#000000";

const LunelConnect = () => {
  const router = useRouter();
  const { fonts, typography } = useTheme();
  const { settings } = useAppSettings();
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
  const keyboardHeight = useSharedValue(0);
  const bottomInset = insets.bottom;
  const activeConnectionProfile = resolveConnectionProfile(settings.connectionProfiles);

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

  const loaderSpin = loaderRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (isConnecting || hasActiveConnectAttemptRef.current) return;
    setManualCode(data);
    handleConnectWithCode(data);
  };

  const handleConnectWithCode = async (code: string) => {
    if (!activeConnectionProfile.isConfigured) {
      setToastMessage(`Configure ${activeConnectionProfile.label} first.`);
      setToastVisible(true);
      return;
    }
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

  if (!permission) {
    return <View style={{ flex: 1, backgroundColor: BLACK }} />;
  }

  const isButtonDisabled = !manualCode.trim() || isConnecting || !activeConnectionProfile.isConfigured;

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
    <View style={styles.container}>

      {/* Upper — Camera */}
      <View style={styles.upper}>
        {permission.granted && (
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            onBarcodeScanned={
              isConnecting ? undefined : handleBarCodeScanned
            }
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          />
        )}

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.back();
            }}
            style={styles.backButton}
          >
            <ArrowLeft size={26} color={WHITE} strokeWidth={2} />
          </TouchableOpacity>
        </View>

        {/* Learn how to connect button */}
        <View style={styles.cliHintRow}>
          <TouchableOpacity
            style={styles.learnButton}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setShowGuide(true);
            }}
            activeOpacity={0.8}
          >
            <Info size={16} color={WHITE} strokeWidth={2} />
            <Text style={[styles.learnButtonText, { fontSize: typography.body }]}>Learn how to connect</Text>
          </TouchableOpacity>
        </View>

        {/* Scan frame */}
        {(() => {
          const scanSize = isTablet ? Math.min(width * 0.35, 280) : width * 0.6;
          const scanOffset = scanSize / 2;
          return (
            <View style={[styles.scanFrame, { width: scanSize, height: scanSize, marginTop: -scanOffset, marginLeft: -scanOffset }]}>
              <Animated.View
                style={[
                  styles.corner,
                  styles.cornerTopLeft,
                  { transform: [{ translateX: cornerOutNeg }, { translateY: cornerOutNeg }, { scale: cornerScale }] },
                ]}
              >
                <Svg width="100%" height="100%" viewBox="0 0 50 50">
                  <Path d="M 47 3 H 23 Q 3 3 3 23 V 47" stroke={WHITE} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  styles.corner,
                  styles.cornerTopRight,
                  { transform: [{ translateX: cornerOut }, { translateY: cornerOutNeg }, { scale: cornerScale }] },
                ]}
              >
                <Svg width="100%" height="100%" viewBox="0 0 50 50">
                  <Path d="M 3 3 H 27 Q 47 3 47 23 V 47" stroke={WHITE} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  styles.corner,
                  styles.cornerBottomLeft,
                  { transform: [{ translateX: cornerOutNeg }, { translateY: cornerOut }, { scale: cornerScale }] },
                ]}
              >
                <Svg width="100%" height="100%" viewBox="0 0 50 50">
                  <Path d="M 47 47 H 23 Q 3 47 3 27 V 3" stroke={WHITE} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  styles.corner,
                  styles.cornerBottomRight,
                  { transform: [{ translateX: cornerOut }, { translateY: cornerOut }, { scale: cornerScale }] },
                ]}
              >
                <Svg width="100%" height="100%" viewBox="0 0 50 50">
                  <Path d="M 3 47 H 27 Q 47 47 47 27 V 3" stroke={WHITE} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              </Animated.View>

              {!permission.granted && (
                <View style={styles.permissionOverlay}>
                  <View style={styles.permissionIconWrapper}>
                    <AlertCircle size={28} color={WHITE} strokeWidth={1.5} />
                  </View>
                  <Text style={styles.permissionOverlayTitle}>
                    Camera Access Required
                  </Text>
                  <Text style={styles.permissionOverlayDesc}>
                    This app uses the camera to scan a QR code to securely connect
                    the app to your development environment or codebase. You can
                    also manually enter the code if you prefer not to use the
                    camera.
                  </Text>
                </View>
              )}

              {isConnecting && (
                <View style={styles.scanningOverlay}>
                  <ActivityIndicator size={40} color={WHITE} />
                  <Text style={styles.connectingText}>
                    {isConnecting ? "Connecting..." : "Processing..."}
                  </Text>
                </View>
              )}
            </View>
          );
        })()}
      </View>

      {/* Lower */}
      <ReAnimated.View style={[styles.lower, lowerAnimatedStyle, { backgroundColor: BLACK }]}>
        <View style={styles.connectionBanner}>
          <View style={styles.connectionBannerText}>
            <Text style={[styles.connectionBannerLabel, { fontFamily: fonts.sans.medium }]}>
              {activeConnectionProfile.label}
            </Text>
            <Text style={[styles.connectionBannerHost, { fontFamily: fonts.mono.regular }]}>
              {activeConnectionProfile.managerUrl || "Manager URL not configured"}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push("/settings/connection")}
            activeOpacity={0.75}
            style={styles.connectionBannerButton}
          >
            <Server size={16} color={WHITE} strokeWidth={2} />
          </TouchableOpacity>
        </View>
        <View style={styles.inputRow}>
          <View style={styles.inputWrapper}>
            <QrCode size={18} color={BLACK} strokeWidth={2} />
            <TextInput
              style={[styles.input, { fontFamily: fonts.sans.regular }]}
              placeholder="Enter connection code"
              placeholderTextColor="rgba(0,0,0,0.9)"
              value={manualCode}
              onChangeText={(text) => { setManualCode(text); setError(null); }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isConnecting}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              returnKeyType="go"
              onSubmitEditing={handleConnect}
            />
          </View>
          <TouchableOpacity
            onPress={handleConnect}
            style={[styles.arrowButton, {
              backgroundColor: manualCode.trim() ? "#4F46E5" : "rgba(255,255,255,0.15)",
              borderColor: manualCode.trim() ? "#4F46E5" : "transparent",
            }]}
            disabled={isButtonDisabled}
            activeOpacity={0.75}
          >
            {isConnecting ? (
              <Animated.View style={{ transform: [{ rotate: loaderSpin }] }}>
                <LoaderCircle size={18} color={manualCode.trim() ? WHITE : "#aaaaaa"} strokeWidth={2} />
              </Animated.View>
            ) : (
              <ArrowRight size={18} color={manualCode.trim() ? WHITE : "#aaaaaa"} strokeWidth={1.5} />
            )}
          </TouchableOpacity>
        </View>
      </ReAnimated.View>

      <Toast
        visible={toastVisible}
        message={toastMessage}
        onHide={() => setToastVisible(false)}
      />

      {/* How to connect guide */}
      <Modal visible={showGuide} animationType="slide" transparent onRequestClose={() => setShowGuide(false)}>
        <TouchableWithoutFeedback onPress={() => setShowGuide(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalTitle, { fontFamily: fonts.sans.regular, fontSize: typography.heading }]}>How to connect</Text>
                <Text style={[styles.modalSubtitle, { fontSize: typography.body }]}>Two steps, under a minute</Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowGuide(false);
                }}
                style={styles.modalClose}
              >
                <X size={18} color={WHITE} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Step 1 */}
              <View style={styles.step}>
                <View style={styles.stepContent}>
                  <Text style={[styles.stepTitle, { fontFamily: fonts.sans.regular, fontSize: typography.body }]}>1. Run one command in your project</Text>
                  <Text style={[styles.stepDesc, { fontSize: typography.body }]}>Open your terminal inside your project directory or remote workspace and run your session CLI:</Text>
                  <View style={styles.codeBlock}>
                    <Text style={styles.codeText}>npx lunel-cli</Text>
                  </View>
                  <Text style={[styles.stepDesc, { fontSize: typography.body }]}>A QR code and a short code will appear instantly. Start it on your selected Hetzner host or GitHub Codespace.</Text>
                </View>
              </View>

              {/* Step 2 */}
              <View style={styles.step}>
                <View style={styles.stepContent}>
                  <Text style={[styles.stepTitle, { fontFamily: fonts.sans.regular, fontSize: typography.body }]}>2. Scan and you're in</Text>
                  <Text style={[styles.stepDesc, { fontSize: typography.body }]}>Point your camera at the QR code or type the short code manually in the input below. The mobile app attaches to the active session on your own backend.</Text>
                  <Text style={[styles.stepNote, { fontSize: typography.body }]}>Keep that server session alive while you work.</Text>
                </View>
              </View>
              {/* Security note */}
              <View style={styles.securityNote}>
<Text style={styles.securityNoteText}>
                  For security purposes, each QR code and session code can only be used once. Once scanned, it expires immediately. Run npx lunel-cli again to generate a fresh one.
                </Text>
              </View>
            </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
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
    overflow: "hidden",
    borderRadius: 20,
    marginHorizontal: 4,
    marginTop: 4,
    marginBottom: 80,
  },
  lower: {
    position: "absolute",
    bottom: 0,
    left: 6,
    right: 6,
    backgroundColor: BLACK,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  connectionBanner: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  connectionBannerText: {
    flex: 1,
    marginRight: 12,
  },
  connectionBannerLabel: {
    color: WHITE,
    fontSize: 13,
  },
  connectionBannerHost: {
    color: "rgba(255,255,255,0.62)",
    fontSize: 11,
    marginTop: 2,
  },
  connectionBannerButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  arrowButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
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
    borderRadius: 10,
    paddingHorizontal: 18,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: BLACK,
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
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  learnButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  learnButtonText: {
    fontSize: 13,
    color: WHITE,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  modalSheet: {
    backgroundColor: "#111111",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 48,
    maxHeight: "80%",
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 9999,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignSelf: "center",
    marginBottom: 20,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: WHITE,
  },
  modalSubtitle: {
    fontSize: 13,
    color: "rgba(255,255,255,0.4)",
    marginTop: 3,
  },
  modalClose: {
    width: 34,
    height: 34,
    borderRadius: 9999,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
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
    borderRadius: 14,
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
