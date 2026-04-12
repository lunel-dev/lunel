import { AppSettingsProvider, useAppSettings } from "@/contexts/AppSettingsContext";
import { ConnectionProvider } from "@/contexts/ConnectionContext";
import { EditorProvider } from "@/contexts/EditorContext";
import { ReviewPromptProvider } from "@/contexts/ReviewPromptContext";
import { SessionRegistryProvider } from "@/contexts/SessionRegistry";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { PluginProvider } from "@/plugins";
import "@/plugins/load"; // Load all plugins
// Sans fonts
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
} from "@expo-google-fonts/ibm-plex-sans";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  Roboto_400Regular,
  Roboto_500Medium,
  Roboto_700Bold,
} from "@expo-google-fonts/roboto";
import {
  SourceSans3_400Regular,
  SourceSans3_500Medium,
  SourceSans3_600SemiBold,
  SourceSans3_700Bold,
} from "@expo-google-fonts/source-sans-3";
// Mono fonts
import {
  DMMono_400Regular,
  DMMono_500Medium,
} from "@expo-google-fonts/dm-mono";
import {
  FiraCode_400Regular,
  FiraCode_500Medium,
  FiraCode_700Bold,
} from "@expo-google-fonts/fira-code";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
} from "@expo-google-fonts/ibm-plex-mono";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import {
  SourceCodePro_400Regular,
  SourceCodePro_500Medium,
  SourceCodePro_700Bold,
} from "@expo-google-fonts/source-code-pro";
// Serif fonts
import {
  IBMPlexSerif_400Regular,
  IBMPlexSerif_500Medium,
  IBMPlexSerif_600SemiBold,
  IBMPlexSerif_700Bold,
} from "@expo-google-fonts/ibm-plex-serif";
import {
  Lora_400Regular,
  Lora_500Medium,
  Lora_600SemiBold,
  Lora_700Bold,
} from "@expo-google-fonts/lora";
import {
  Merriweather_400Regular,
  Merriweather_700Bold,
  Merriweather_900Black,
} from "@expo-google-fonts/merriweather";
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_500Medium,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from "@expo-google-fonts/playfair-display";
import {
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
  SourceSerif4_600SemiBold,
  SourceSerif4_700Bold,
} from "@expo-google-fonts/source-serif-4";
// Display fonts
import { Khand_600SemiBold, useFonts } from "@expo-google-fonts/khand";
import {
  PublicSans_400Regular,
  PublicSans_500Medium,
  PublicSans_600SemiBold,
  PublicSans_700Bold,
} from "@expo-google-fonts/public-sans";
import { Orbitron_700Bold } from "@expo-google-fonts/orbitron";
import { SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { HotUpdater } from "@hot-updater/react-native";
import { Stack, usePathname } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as NavigationBar from "expo-navigation-bar";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import PolyfillCrypto from "react-native-webview-crypto";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";

SplashScreen.preventAutoHideAsync();

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_KEEP_AWAKE_TAG = "lunel-app-global";

function asUuidOrZero(value: string | null | undefined): string {
  if (!value) return ZERO_UUID;
  return UUID_RE.test(value) ? value : ZERO_UUID;
}

function RootLayoutContent() {
  const { colors, isDark } = useTheme();
  const { settings } = useAppSettings();
  const pathname = usePathname();
  const isWorkspace = pathname.startsWith("/workspace");
  const isSettings = pathname.startsWith("/settings");
  const isHelp = pathname.startsWith("/help");
  const isFeedback = pathname.startsWith("/feedback");
  const useEdgeToEdgeTopInset = isWorkspace || isSettings || isHelp || isFeedback || isOnboarding;
  const isAuth = pathname.startsWith("/auth");
  const isLunelConnect = pathname.startsWith("/lunel-connect");
  const isOnboarding = pathname.startsWith("/onboarding");
  const statusBarBg = isLunelConnect
    ? "#000000"
    : isWorkspace
      ? colors.bg.raised
      : colors.bg.base;
  const statusBarStyle = isLunelConnect || isDark ? "light" : "dark";
  const [isReady, setIsReady] = useState(false);
  const [fontsLoaded] = useFonts({
    // Sans fonts
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Roboto_400Regular,
    Roboto_500Medium,
    Roboto_700Bold,
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSans_700Bold,
    SourceSans3_400Regular,
    SourceSans3_500Medium,
    SourceSans3_600SemiBold,
    SourceSans3_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    // Mono fonts
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
    FiraCode_400Regular,
    FiraCode_500Medium,
    FiraCode_700Bold,
    SourceCodePro_400Regular,
    SourceCodePro_500Medium,
    SourceCodePro_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_700Bold,
    DMMono_400Regular,
    DMMono_500Medium,
    // Nerd font for terminal
    'JetBrainsMonoNerdFontMono-Regular': require('@/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
    'JetBrainsMonoNerdFontMono-Bold': require('@/assets/fonts/JetBrainsMonoNerdFontMono-Bold.ttf'),
    // Serif fonts
    Merriweather_400Regular,
    Merriweather_700Bold,
    Merriweather_900Black,
    Lora_400Regular,
    Lora_500Medium,
    Lora_600SemiBold,
    Lora_700Bold,
    PlayfairDisplay_400Regular,
    PlayfairDisplay_500Medium,
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
    IBMPlexSerif_400Regular,
    IBMPlexSerif_500Medium,
    IBMPlexSerif_600SemiBold,
    IBMPlexSerif_700Bold,
    SourceSerif4_400Regular,
    SourceSerif4_500Medium,
    SourceSerif4_600SemiBold,
    SourceSerif4_700Bold,
    // Display fonts
    Khand_600SemiBold,
    Orbitron_700Bold,
    SpaceGrotesk_700Bold,
    PublicSans_400Regular,
    PublicSans_500Medium,
    PublicSans_600SemiBold,
    PublicSans_700Bold,
  });

  useEffect(() => {
    // Proxy servers start dynamically when CLI reports open ports
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (isReady && fontsLoaded) {
      SplashScreen.hide();
    }
  }, [isReady, fontsLoaded]);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    if (isWorkspace) {
      NavigationBar.setBackgroundColorAsync("transparent");
      NavigationBar.setButtonStyleAsync("light");
      return;
    }

    NavigationBar.setBackgroundColorAsync(statusBarBg);
    NavigationBar.setButtonStyleAsync(statusBarStyle === "light" ? "light" : "dark");
  }, [isWorkspace, statusBarBg, statusBarStyle]);

  useEffect(() => {
    if (!settings.keepAwakeEnabled) {
      void deactivateKeepAwake(APP_KEEP_AWAKE_TAG).catch(() => {
        // Ignore wake lock release failures.
      });
      return;
    }

    void activateKeepAwakeAsync(APP_KEEP_AWAKE_TAG).catch(() => {
      // Ignore wake lock activation failures.
    });

    return () => {
      void deactivateKeepAwake(APP_KEEP_AWAKE_TAG).catch(() => {
        // Ignore wake lock release failures.
      });
    };
  }, [settings.keepAwakeEnabled]);

  if (!isReady || !fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
      <SafeAreaView
        style={{ flex: 1, backgroundColor: useEdgeToEdgeTopInset ? "transparent" : statusBarBg }}
        edges={useEdgeToEdgeTopInset ? [] : undefined}
      >
        <StatusBar
          style={statusBarStyle}
          backgroundColor={useEdgeToEdgeTopInset ? "transparent" : statusBarBg}
          translucent={useEdgeToEdgeTopInset}
        />
        <Stack
          screenOptions={{
            animation: "none",
            gestureEnabled: false,
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg.base },
          }}
          initialRouteName="index"
        >
          <Stack.Screen
            name="settings"
            options={{
              animation: "slide_from_right",
              gestureEnabled: true,
            }}
          />
          <Stack.Screen
            name="help"
            options={{
              animation: "slide_from_right",
              gestureEnabled: true,
            }}
          />
          <Stack.Screen
            name="feedback"
            options={{
              animation: "slide_from_right",
              gestureEnabled: true,
            }}
          />
        </Stack>
      </SafeAreaView>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function RootLayout() {
  return (
    <>
      <PolyfillCrypto />
      <ConnectionProvider>
        <ThemeProvider>
          <AppSettingsProvider>
            <ReviewPromptProvider>
              <EditorProvider>
                <PluginProvider>
                  <SessionRegistryProvider>
                    <RootLayoutContent />
                  </SessionRegistryProvider>
                </PluginProvider>
              </EditorProvider>
            </ReviewPromptProvider>
          </AppSettingsProvider>
        </ThemeProvider>
      </ConnectionProvider>
    </>
  );
}

export default HotUpdater.wrap({
  resolver: {
    checkUpdate: async (params) => {
      const platform = params?.platform ?? "android";
      const appVersion = params?.appVersion ?? HotUpdater.getAppVersion();
      const channel = params?.channel ?? HotUpdater.getChannel();
      const minBundleId = asUuidOrZero(
        params?.minBundleId ?? HotUpdater.getMinBundleId()
      );
      const bundleId = asUuidOrZero(params?.bundleId ?? HotUpdater.getBundleId());
      const url = `https://updates.lunel.dev/hot-updater/app-version/${platform}/${appVersion}/${channel}/${minBundleId}/${bundleId}`;
      const res = await fetch(url, {
        headers: params?.requestHeaders ?? {},
      });
      if (!res.ok) {
        throw new Error(`HotUpdater check failed: ${res.status}`);
      }
      return res.json();
    },
  },
  updateStrategy: "appVersion",
  updateMode: "auto",
})(RootLayout);
