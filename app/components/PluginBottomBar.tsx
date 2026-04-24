import { useTheme } from "@/contexts/ThemeContext";
import { innerApi } from "@/plugins/innerApi";
import { PluginInstance } from "@/plugins/types";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import {
  Sparkles,
  Globe,
  Code2,
  Terminal,
  LayoutGrid,
  X,
  Folder,
  Plug,
  ChartNoAxesColumn,
  Shield,
  GitBranch,
} from "lucide-react-native";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePlugins } from "@/plugins";

const WORKSPACE_STORAGE_KEY = "@lunel_workspace";

interface PluginBottomBarProps {
  openTab: (pluginId: string) => string;
  setActiveTab: (instanceId: string) => void;
}

interface BottomBarState {
  openTabs: PluginInstance[];
  activeTabId: string;
}

const NAV_ITEMS = [
  { id: "ai", label: "AI", Icon: Sparkles },
  { id: "browser", label: "Browser", Icon: Globe },
  { id: "editor", label: "Editor", Icon: Code2 },
  { id: "terminal", label: "Terminal", Icon: Terminal },
  { id: "git", label: "Git", Icon: GitBranch },
  { id: "tabs", label: "Tabs", Icon: LayoutGrid },
];

const EXTRA_PLUGIN_ORDER = [
  "explorer",
  "ports",
  "processes",
  "http",
  "monitor",
  "tools",
  "brainrot",
] as const;

const EXTRA_ICON_OVERRIDES = {
  explorer: Folder,
  ports: Plug,
  processes: ChartNoAxesColumn,
  http: Shield,
} as const;

const NavItem = memo(function NavItem({
  item,
  isActive,
  onPress,
  activeColor,
  inactiveColor,
  activeBg,
  activeBorder,
  labelStyle,
}: {
  item: typeof NAV_ITEMS[number];
  isActive: boolean;
  onPress: () => void;
  activeColor: string;
  inactiveColor: string;
  activeBg: string;
  activeBorder: string;
  labelStyle: object;
}) {
  const { Icon } = item;
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.navItem, { opacity: isActive ? 1 : 0.75 }]}
      activeOpacity={0.7}
    >
      <Icon size={23} color={isActive ? activeColor : inactiveColor} strokeWidth={1.75} />
      <Text style={[styles.label, labelStyle, { color: isActive ? activeColor : inactiveColor }]}>
        {item.label}
      </Text>
    </TouchableOpacity>
  );
});

export default function PluginBottomBar({
  openTab,
  setActiveTab,
}: PluginBottomBarProps) {
  const { colors, fonts } = useTheme();
  const { getPlugin } = usePlugins();
  const { bottom: bottomInset } = useSafeAreaInsets();

  const [renderKey, setRenderKey] = useState(0);
  const [isTabsModalVisible, setIsTabsModalVisible] = useState(false);
  const [isTabsModalMounted, setIsTabsModalMounted] = useState(false);
  const stateRef = useRef<BottomBarState>({
    openTabs: [],
    activeTabId: "",
  });
  const tabsBackdropOpacity = useRef(new Animated.Value(0)).current;

  const loadState = useCallback(async () => {
    try {
      const workspaceStr = await AsyncStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (workspaceStr) {
        const workspace = JSON.parse(workspaceStr);
        stateRef.current.openTabs = workspace.openTabs || [];
        stateRef.current.activeTabId = workspace.activeTabId || "";
      }
    } catch {
      // ignore
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadState();
    setRenderKey((k) => k + 1);
  }, [loadState]);

  useEffect(() => {
    innerApi.registerBottomBar(refresh);
    loadState().then(() => setRenderKey((k) => k + 1));
    return () => innerApi.unregisterBottomBar();
  }, [refresh, loadState]);

  useEffect(() => {
    if (isTabsModalVisible) {
      setIsTabsModalMounted(true);
      tabsBackdropOpacity.setValue(0);
      Animated.timing(tabsBackdropOpacity, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (!isTabsModalMounted) return;
    Animated.timing(tabsBackdropOpacity, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setIsTabsModalMounted(false);
      }
    });
  }, [isTabsModalMounted, isTabsModalVisible, tabsBackdropOpacity]);

  const openTabsModal = useCallback(() => {
    setIsTabsModalVisible(true);
  }, []);

  const closeTabsModal = useCallback(() => {
    setIsTabsModalVisible(false);
  }, []);

  const handlePress = useCallback((pluginId: string) => {
    if (pluginId === "tabs") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      openTabsModal();
      return;
    }

    const { openTabs, activeTabId } = stateRef.current;
    const activePluginId = openTabs.find((t) => t.id === activeTabId)?.pluginId;
    if (activePluginId !== pluginId) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    const existingTab = openTabs.find((t) => t.pluginId === pluginId);
    if (existingTab) {
      stateRef.current.activeTabId = existingTab.id;
      setRenderKey((k) => k + 1);
      setActiveTab(existingTab.id);
    } else {
      openTab(pluginId);
    }
  }, [openTab, openTabsModal, setActiveTab]);

  const { openTabs, activeTabId } = stateRef.current;
  const activePluginId = openTabs.find((t) => t.id === activeTabId)?.pluginId ?? "";

  const activeColor = colors.fg.default;
  const inactiveColor = colors.fg.muted;

  const labelStyle = { fontFamily: fonts.sans.regular };
  const extraTabs = EXTRA_PLUGIN_ORDER
    .map((id) => getPlugin(id))
    .filter((plugin): plugin is NonNullable<typeof plugin> => Boolean(plugin));
  const openExtraTab = useCallback((pluginId: string) => {
    const { openTabs, activeTabId } = stateRef.current;
    const activePluginId = openTabs.find((t) => t.id === activeTabId)?.pluginId;
    if (activePluginId !== pluginId) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    const existingTab = openTabs.find((t) => t.pluginId === pluginId);
    if (existingTab) {
      stateRef.current.activeTabId = existingTab.id;
      setRenderKey((k) => k + 1);
      setActiveTab(existingTab.id);
    } else {
      openTab(pluginId);
    }
    setIsTabsModalVisible(false);
    setIsTabsModalMounted(false);
  }, [openTab, setActiveTab]);

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: bottomInset,
          backgroundColor: colors.bg.base,
          borderTopColor: colors.border.secondary,
        },
      ]}
      key={renderKey}
    >
      {NAV_ITEMS.map((item) => (
        <NavItem
          key={item.id}
          item={item}
          isActive={activePluginId === item.id}
          onPress={() => handlePress(item.id)}
          activeColor={activeColor}
          inactiveColor={inactiveColor}
          activeBg="transparent"
          activeBorder="transparent"
          labelStyle={labelStyle}
        />
      ))}

      <Modal
        visible={isTabsModalMounted}
        transparent
        animationType="none"
        onRequestClose={closeTabsModal}
      >
        <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            styles.modalBackdrop,
            { backgroundColor: 'rgba(0,0,0,0.45)', opacity: tabsBackdropOpacity },
          ]}
        />
          <Pressable style={StyleSheet.absoluteFill} onPress={closeTabsModal} />
          <View style={styles.sheetContainer} pointerEvents="box-none">
            <Pressable
              style={[
                styles.launcherSheet,
                {
                  borderColor: colors.bg.raised,
                  backgroundColor: colors.bg.base,
                  paddingBottom: bottomInset,
                },
              ]}
              onPress={(e) => e.stopPropagation()}
            >
              {extraTabs.map((plugin) => {
                const Icon = EXTRA_ICON_OVERRIDES[plugin.id as keyof typeof EXTRA_ICON_OVERRIDES] ?? plugin.icon;
                const isActive = activePluginId === plugin.id;
                return (
                  <TouchableOpacity
                    key={plugin.id}
                    onPress={() => openExtraTab(plugin.id)}
                    activeOpacity={0.75}
                    style={[styles.listItem, { opacity: isActive ? 1 : 0.8 }]}
                  >
                    <Icon
                      size={20}
                      color={isActive ? colors.fg.default : colors.fg.muted}
                      strokeWidth={1.75}
                    />
                    <Text
                      style={[
                        styles.listItemLabel,
                        { fontFamily: fonts.sans.medium, color: isActive ? colors.fg.default : colors.fg.muted },
                      ]}
                    >
                      {plugin.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <View style={styles.closeRow}>
                <TouchableOpacity
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setIsTabsModalVisible(false);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.closeCircle, { backgroundColor: colors.bg.raised }]}>
                    <X size={20} color={colors.fg.muted} strokeWidth={1.75} />
                  </View>
                </TouchableOpacity>
              </View>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    paddingTop: 10,
    paddingHorizontal: 8,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    gap: 3,
  },
  label: {
    fontSize: 10,
    textAlign: "center",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheetContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  launcherSheet: {
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 9,
    paddingHorizontal: 4,
  },
  listItemLabel: {
    fontSize: 15,
  },
  closeRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingTop: 4,
    paddingBottom: 10,
    paddingRight: 6,
  },
  closeCircle: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
});
