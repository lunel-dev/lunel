import Loading from "@/components/Loading";
import PluginBottomBar from "@/components/PluginBottomBar";
import PluginRenderer from "@/components/PluginRenderer";
import { useConnection } from "@/contexts/ConnectionContext";
import { useTheme } from "@/contexts/ThemeContext";
import { logger } from "@/lib/logger";
import { usePlugins } from "@/plugins";
import { useFocusEffect, useRouter } from "expo-router";
import { useDrawerStatus } from "@react-navigation/drawer";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  Platform,
  Text,
  View,
} from "react-native";


export default function WorkspaceScreen() {
  const { colors } = useTheme();
  const { isLoading, openTab, setActiveTab } = usePlugins();
  const { status, sessionState, error, isReconnecting, interactionBlockReason, disconnect } = useConnection();
  const router = useRouter();
  const drawerStatus = useDrawerStatus();

  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  const prevSessionStateRef = useRef(sessionState);
  const reconnectAttemptVisibleRef = useRef(false);
  const reconnectFailureAlertVisibleRef = useRef(false);

  const handleGoHome = useCallback(() => {
    logger.info("workspace", "navigating back to auth after disconnect");
    router.replace("/auth");
    disconnect();
  }, [disconnect, router]);

  useEffect(() => {
    const prev = prevSessionStateRef.current;
    prevSessionStateRef.current = sessionState;

    logger.info("workspace", "screen state updated", {
      prevSessionState: prev,
      status,
      sessionState,
      error,
      isLoading,
      drawerStatus,
    });

    if (prev !== sessionState && (sessionState === "ended" || sessionState === "expired" || sessionState === "cli_offline_grace")) {
      Alert.alert(
        'Connection Lost',
        'Your session was disconnected. Run npx lunel-cli again to reconnect.',
        [{ text: 'Home', style: 'destructive', onPress: handleGoHome }],
        { cancelable: false }
      );
    }
  }, [drawerStatus, error, handleGoHome, isLoading, sessionState, status]);

  useEffect(() => {
    if (isLoading) {
      logger.info("workspace", "rendering loading spinner", { status, error });
      return;
    }

    logger.info("workspace", "workspace shell ready", { status, error });
  }, [isLoading, status, error]);

  useEffect(() => {
    const isReconnectingNow = status === "connecting" || isReconnecting || interactionBlockReason !== null;
    if (isReconnectingNow) {
      reconnectAttemptVisibleRef.current = true;
      reconnectFailureAlertVisibleRef.current = false;
      return;
    }

    if (reconnectAttemptVisibleRef.current && status !== "connected" && error && !reconnectFailureAlertVisibleRef.current) {
      reconnectFailureAlertVisibleRef.current = true;
      Alert.alert(
        "Session Disconnected",
        "Automatic reconnect failed. Go home and reconnect to your session.",
        [
          { text: "Go Home", style: "destructive", onPress: handleGoHome },
        ],
        { cancelable: false }
      );
    }

    if (!isReconnectingNow) {
      reconnectAttemptVisibleRef.current = false;
    }
  }, [error, handleGoHome, interactionBlockReason, isReconnecting, status]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;

      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        // Keep users in workspace; let default behavior close the drawer if open.
        if (drawerStatus === "open") return false;
        return true;
      });

      return () => sub.remove();
    }, [drawerStatus])
  );

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Loading color={colors.accent.default} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <PluginRenderer paddingBottom={0} bottomBarHeight={bottomBarHeight} />
      <View onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}>
        <PluginBottomBar
          openTab={openTab}
          setActiveTab={setActiveTab}
        />
      </View>
      {(status === "connecting" || isReconnecting || interactionBlockReason !== null) ? (
        <View
          pointerEvents="auto"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(10, 10, 10, 0.16)",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <View
            style={{
              minWidth: 160,
              borderRadius: 10,
              paddingHorizontal: 16,
              paddingVertical: 14,
              backgroundColor: colors.bg.raised,
              borderWidth: 1,
              borderColor: colors.border.main,
              alignItems: "center",
              gap: 8,
            }}
          >
            <View style={{ width: 20, height: 20 }}>
              <Loading color={colors.fg.default} />
            </View>
            <Text
              style={{
                color: colors.fg.default,
                fontSize: 16,
                fontWeight: "600",
                textAlign: "center",
              }}
            >
              {interactionBlockReason === "offline" ? "Offline" : "Reconnecting"}
            </Text>
            <Text
              style={{
                color: colors.fg.muted,
                fontSize: 13,
                textAlign: "center",
              }}
            >
              {interactionBlockReason === "offline"
                ? "Waiting for internet connection..."
                : "Restoring your session..."}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
