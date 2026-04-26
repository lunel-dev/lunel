import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useConnection } from "@/contexts/ConnectionContext";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

const PUSH_PHONE_ID_STORAGE_KEY = "lunel_push_phone_id";

async function getOrCreatePhoneId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(PUSH_PHONE_ID_STORAGE_KEY);
  if (existing) return existing;

  const generated = Crypto.randomUUID();
  await SecureStore.setItemAsync(PUSH_PHONE_ID_STORAGE_KEY, generated);
  return generated;
}

function getExpoProjectId(): string | null {
  const constants = Constants as typeof Constants & {
    easConfig?: { projectId?: string };
  };
  const projectId = constants.expoConfig?.extra?.eas?.projectId || constants.easConfig?.projectId;
  return typeof projectId === "string" && projectId ? projectId : null;
}

async function resolveExpoPushToken(enabled: boolean): Promise<string | null> {
  if (!enabled) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("ai-completion", {
      name: "AI completion",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const currentPermission = await Notifications.getPermissionsAsync();
  const finalPermission = currentPermission.status === "granted"
    ? currentPermission
    : await Notifications.requestPermissionsAsync();
  if (finalPermission.status !== "granted") return null;

  const projectId = getExpoProjectId();
  if (!projectId) return null;

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data || null;
}

export default function PushNotificationSync() {
  const { status, capabilities, sendControl } = useConnection();
  const { settings } = useAppSettings();
  const lastSentSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "connected" || !capabilities) return;

    let cancelled = false;
    const syncPushToken = async () => {
      const phoneId = await getOrCreatePhoneId();
      const enabled = settings.aiCompletionNotificationsEnabled;
      const expoPushToken = await resolveExpoPushToken(enabled).catch(() => null);
      if (cancelled) return;

      const signature = JSON.stringify({
        phoneId,
        expoPushToken,
        enabled,
        platform: Platform.OS,
      });
      if (lastSentSignatureRef.current === signature) return;

      const response = await sendControl("system", "setPushToken", {
        phoneId,
        expoPushToken,
        notificationsEnabled: enabled,
        platform: Platform.OS,
      }, 10000);
      if (response.ok) {
        lastSentSignatureRef.current = signature;
      }
    };

    void syncPushToken();
    return () => {
      cancelled = true;
    };
  }, [capabilities, sendControl, settings.aiCompletionNotificationsEnabled, status]);

  return null;
}
