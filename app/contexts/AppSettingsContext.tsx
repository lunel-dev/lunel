import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ConnectionProfilesSettings,
  DEFAULT_CONNECTION_PROFILES,
  sanitizeConnectionProfiles,
} from "@/lib/connectionProfiles";
import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

const APP_SETTINGS_STORAGE_KEY = "@lunel_app_settings";

interface AppSettings {
  keepAwakeEnabled: boolean;
  brainrotSource: "youtube" | "instagram" | "x" | "tiktok";
  brainrotAiChatIntegration: boolean;
  connectionProfiles: ConnectionProfilesSettings;
}

interface AppSettingsContextType {
  settings: AppSettings;
  updateSettings: (nextSettings: AppSettings) => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  keepAwakeEnabled: true,
  brainrotSource: "youtube",
  brainrotAiChatIntegration: false,
  connectionProfiles: DEFAULT_CONNECTION_PROFILES,
};

const AppSettingsContext = createContext<AppSettingsContextType | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const saved = await AsyncStorage.getItem(APP_SETTINGS_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Partial<AppSettings>;
          setSettingsState({
            ...DEFAULT_APP_SETTINGS,
            ...parsed,
            connectionProfiles: sanitizeConnectionProfiles(parsed.connectionProfiles),
          });
        }
      } catch (error) {
        console.error("Failed to load app settings:", error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadSettings();
  }, []);

  const updateSettings = async (nextSettings: AppSettings) => {
    setSettingsState(nextSettings);
    try {
      await AsyncStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
    } catch (error) {
      console.error("Failed to save app settings:", error);
    }
  };

  const updateSetting = async <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    await updateSettings({ ...settings, [key]: value });
  };

  if (isLoading) {
    return null;
  }

  return (
    <AppSettingsContext.Provider value={{ settings, updateSettings, updateSetting }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error("useAppSettings must be used within an AppSettingsProvider");
  }
  return context;
}

export type { AppSettings };
