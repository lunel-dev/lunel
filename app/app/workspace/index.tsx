import Loading from "@/components/Loading";
import PluginBottomBar from "@/components/PluginBottomBar";
import PluginRenderer from "@/components/PluginRenderer";
import { useConnection } from "@/contexts/ConnectionContext";
import { useSessionRegistry } from "@/contexts/SessionRegistry";
import { useTheme } from "@/contexts/ThemeContext";
import { logger } from "@/lib/logger";
import { usePlugins } from "@/plugins";
import { useFocusEffect, useRouter } from "expo-router";
import { useDrawerStatus } from "expo-router/drawer";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, BackHandler, Platform, Text, View } from "react-native";

export default function WorkspaceScreen() {
  const { colors } = useTheme();
  const { isLoading, openTab, openTabs, activeTabId, setActiveTab } =
    usePlugins();
  const { registry } = useSessionRegistry();
  const {
    status,
    error,
    isReconnecting,
    disconnect,
  } = useConnection();
  const router = useRouter();
  const drawerStatus = useDrawerStatus();
  const { t } = useTranslation();

  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  const prevStatusRef = useRef(status);
  const reconnectAttemptVisibleRef = useRef(false);
  const reconnectFailureAlertVisibleRef = useRef(false);
  const reconnectRefreshRunningRef = useRef(false);
  const shouldRefreshAfterReconnectRef = useRef(false);
  const hasConnectedOnceRef = useRef(false);
  const showConnectionNotice =
    status === "connecting" ||
    isReconnecting ||
    status === "disconnected";

  const handleGoHome = useCallback(() => {
    logger.info("workspace", "navigating back to auth after disconnect");
    router.replace("/auth");
    disconnect();
  }, [disconnect, router]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    logger.info("workspace", "screen state updated", {
      prevStatus: prev,
      status,
      error,
      isLoading,
      drawerStatus,
    });

    const lostConnection =
      status === "disconnected" && (prev === "connected" || prev === "connecting");
    if (lostConnection) {
      Alert.alert(
        t("workspace.connectionLostTitle"),
        t("workspace.connectionLostDesc"),
        [
          {
            text: t("workspace.goHome"),
            style: "destructive",
            onPress: handleGoHome,
          },
        ],
        { cancelable: false },
      );
    }
  }, [drawerStatus, error, handleGoHome, isLoading, status]);

  useEffect(() => {
    if (isLoading) {
      logger.info("workspace", "rendering loading spinner", { status, error });
      return;
    }

    logger.info("workspace", "workspace shell ready", { status, error });
  }, [isLoading, status, error]);

  useEffect(() => {
    const isReconnectingNow =
      status === "connecting" ||
      isReconnecting ||
      status === "disconnected";
    if (isReconnectingNow) {
      if (hasConnectedOnceRef.current) {
        shouldRefreshAfterReconnectRef.current = true;
      }
      reconnectAttemptVisibleRef.current = true;
      reconnectFailureAlertVisibleRef.current = false;
      return;
    }

    if (status === "connected") {
      hasConnectedOnceRef.current = true;
    }

    if (
      reconnectAttemptVisibleRef.current &&
      status !== "connected" &&
      error &&
      !reconnectFailureAlertVisibleRef.current
    ) {
      reconnectFailureAlertVisibleRef.current = true;
      Alert.alert(
        t("workspace.sessionDisconnectedTitle"),
        t("workspace.sessionDisconnectedDesc"),
        [
          {
            text: t("workspace.goHome"),
            style: "destructive",
            onPress: handleGoHome,
          },
        ],
        { cancelable: false },
      );
    }

    if (!isReconnectingNow) {
      reconnectAttemptVisibleRef.current = false;
    }
  }, [error, handleGoHome, isReconnecting, status]);

  useEffect(() => {
    if (
      status !== "connected" ||
      !shouldRefreshAfterReconnectRef.current ||
      reconnectRefreshRunningRef.current
    ) {
      return;
    }

    const activePluginId =
      openTabs.find((tab) => tab.id === activeTabId)?.pluginId ?? null;
    shouldRefreshAfterReconnectRef.current = false;
    reconnectRefreshRunningRef.current = true;

    const runRefresh = async () => {
      const refreshSession = async (pluginId: string, sessionId: string) => {
        const registration = registry[pluginId];
        if (!registration?.onReconnectRefreshSession) return;
        try {
          await registration.onReconnectRefreshSession(sessionId);
        } catch (refreshError) {
          logger.warn("workspace", "reconnect session refresh failed", {
            pluginId,
            sessionId,
            error:
              refreshError instanceof Error
                ? refreshError.message
                : String(refreshError),
          });
        }
      };

      const refreshPlugin = async (pluginId: string) => {
        const registration = registry[pluginId];
        if (!registration?.onReconnectRefreshAll) return;
        try {
          await registration.onReconnectRefreshAll();
        } catch (refreshError) {
          logger.warn("workspace", "reconnect plugin refresh failed", {
            pluginId,
            error:
              refreshError instanceof Error
                ? refreshError.message
                : String(refreshError),
          });
        }
      };

      const refreshPluginSessions = async (
        pluginId: string,
        skipSessionId?: string | null,
      ) => {
        const registration = registry[pluginId];
        if (!registration) return;
        for (const session of registration.sessions) {
          if (session.id === skipSessionId) continue;
          await refreshSession(pluginId, session.id);
        }
      };

      logger.info("workspace", "running reconnect refresh queue", {
        activePluginId,
      });

      if (activePluginId) {
        const activeRegistration = registry[activePluginId];
        const activeSessionId = activeRegistration?.activeSessionId ?? null;
        if (activeSessionId) {
          await refreshSession(activePluginId, activeSessionId);
        }
        await refreshPluginSessions(activePluginId, activeSessionId);
        await refreshPlugin(activePluginId);
      }

      for (const tab of openTabs) {
        if (tab.pluginId === activePluginId) continue;
        await refreshPluginSessions(tab.pluginId);
        await refreshPlugin(tab.pluginId);
      }
    };

    void runRefresh().finally(() => {
      reconnectRefreshRunningRef.current = false;
    });
  }, [activeTabId, openTabs, registry, status]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;

      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        // Keep users in workspace; let default behavior close the drawer if open.
        if (drawerStatus === "open") return false;
        return true;
      });

      return () => sub.remove();
    }, [drawerStatus]),
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
        <PluginBottomBar openTab={openTab} setActiveTab={setActiveTab} />
      </View>
      {showConnectionNotice ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            minHeight: 24,
            paddingHorizontal: 12,
            paddingVertical: 4,
            backgroundColor: colors.bg.raised,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.main,
            alignItems: "center",
            justifyContent: "center",
            zIndex: 20,
            elevation: 20,
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
            {status === "disconnected"
              ? t("workspace.offline")
              : t("workspace.reconnecting")}
          </Text>
          <Text
            style={{
              color: colors.fg.muted,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {status === "disconnected"
              ? t("workspace.waitingConnection")
              : t("workspace.restoringSession")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
