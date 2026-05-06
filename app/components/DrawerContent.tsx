import { radius, typography } from "@/constants/themes";
import { useConnection } from "@/contexts/ConnectionContext";
import { useSessionRegistry } from "@/contexts/SessionRegistry";
import type { SessionItem } from "@/contexts/SessionRegistry";
import { useTheme } from "@/contexts/ThemeContext";
import { useApi, FileEntry } from "@/hooks/useApi";
import { gPI } from "@/plugins";
import { usePlugins } from "@/plugins/context";
import InfoSheet from "@/components/InfoSheet";
import InputModal from "@/components/InputModal";
import { DrawerContentComponentProps, useDrawerStatus } from "@react-navigation/drawer";
import * as Haptics from "expo-haptics";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import {
  ChevronDown,
  ChevronRight,
  CopyMinus,
  File,
  Folder,
  FolderOpen,
  HelpCircle,
  Home,
  LoaderCircle,
  MessageCircle,
  PencilLine,
  RefreshCw,
  Search,
  Settings,
  Trash,
  X,
} from "lucide-react-native";
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Alert,
  Animated,
  Easing,
  Image,
  InteractionManager,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

function SpinningLoader({ color, opacity = 1, size = 18 }: { color: string; opacity?: number; size?: number }) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    ).start();
  }, [rotation]);

  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View style={{ transform: [{ rotate }], opacity }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  );
}

const HIDE_SIDEBAR_SESSION_PLUGIN_IDS = new Set([
  "git",
  "ports",
  "processes",
  "http",
  "monitor",
  "tools",
]);

type EditorTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: EditorTreeNode[];
};

type TreeListItem = {
  node: EditorTreeNode;
  depth: number;
};

const sortEntries = (entries: FileEntry[]) => {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
};

const toEditorTreeNodes = (entries: FileEntry[], parentPath: string): EditorTreeNode[] => {
  return sortEntries(entries).map((entry) => ({
    name: entry.name,
    type: entry.type,
    path: parentPath === "." ? entry.name : `${parentPath}/${entry.name}`,
    children: entry.type === "directory" ? [] : undefined,
  }));
};

const attachChildrenAtPath = (
  nodes: EditorTreeNode[],
  targetPath: string,
  children: EditorTreeNode[]
): EditorTreeNode[] => {
  return nodes.map((node) => {
    if (node.path === targetPath && node.type === "directory") {
      return { ...node, children };
    }

    if (!node.children || node.children.length === 0) {
      return node;
    }

    return {
      ...node,
      children: attachChildrenAtPath(node.children, targetPath, children),
    };
  });
};

const flattenTree = (
  nodes: EditorTreeNode[],
  expandedPaths: Set<string>,
  depth = 0
): TreeListItem[] => {
  const result: TreeListItem[] = [];

  for (const node of nodes) {
    result.push({ node, depth });
    if (node.type === "directory" && expandedPaths.has(node.path) && node.children?.length) {
      result.push(...flattenTree(node.children, expandedPaths, depth + 1));
    }
  }

  return result;
};

function TreeIcon({
  node,
  isExpanded,
  colors,
}: {
  node: EditorTreeNode;
  isExpanded: boolean;
  colors: any;
}) {
  if (node.type === "directory") {
    return isExpanded
      ? <FolderOpen size={16} color={colors.accent.default} strokeWidth={2} />
      : <Folder size={16} color={colors.accent.default} strokeWidth={2} />;
  }

  return <File size={16} color={colors.fg.muted} strokeWidth={2} />;
}

function SessionFileIcon({
  fileName: _fileName,
  colors,
}: {
  fileName: string;
  colors: any;
}) {
  return <File size={15} color={colors.fg.muted} strokeWidth={2} />;
}

export default function DrawerContent(props: DrawerContentComponentProps) {
  const { colors, fonts, isDark } = useTheme();
  const { status, disconnect } = useConnection();
  const { fs } = useApi();
  const {
    activeTabId: activePluginTabId,
    openTabs,
    getPlugin,
    openTab,
    drawerContentVariant,
    setDrawerContentVariant,
  } = usePlugins();
  const { registry } = useSessionRegistry();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [expandedBackends, setExpandedBackends] = useState<Set<string>>(new Set());
  const [loadingBackends, setLoadingBackends] = useState<Set<string>>(new Set());
  const [editorTree, setEditorTree] = useState<EditorTreeNode[]>([]);
  const [expandedEditorDirs, setExpandedEditorDirs] = useState<Set<string>>(new Set());
  const [loadedEditorDirs, setLoadedEditorDirs] = useState<Set<string>>(new Set());
  const [loadingEditorDirs, setLoadingEditorDirs] = useState<Set<string>>(new Set());
  const [editorTreeError, setEditorTreeError] = useState<string | null>(null);
  const [selectedSessionAction, setSelectedSessionAction] = useState<SessionItem | null>(null);
  const [renameSessionTarget, setRenameSessionTarget] = useState<SessionItem | null>(null);
  const [pendingRenameSessionTarget, setPendingRenameSessionTarget] = useState<SessionItem | null>(null);
  const inputRef = useRef<TextInput>(null);
  const pendingNavigationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionHandleRef = useRef<{ cancel?: () => void } | null>(null);

  const SESSIONS_LIMIT = 5;

  const handleViewAll = useCallback((backend: string) => {
    setLoadingBackends((prev) => new Set(prev).add(backend));
    setTimeout(() => {
      setLoadingBackends((prev) => { const next = new Set(prev); next.delete(backend); return next; });
      setExpandedBackends((prev) => new Set(prev).add(backend));
    }, 400);
  }, []);

  const isConnected = status === "connected";
  const drawerStatus = useDrawerStatus();

  const handleCancelSearch = () => {
    setSearch("");
    setSearchFocused(false);
    Keyboard.dismiss();
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (drawerStatus === "closed") {
      handleCancelSearch();
      setExpandedBackends(new Set());
      setLoadingBackends(new Set());
      setDrawerContentVariant("default");
    }
  }, [drawerStatus, setDrawerContentVariant]);

  useEffect(() => {
    return () => {
      if (pendingNavigationRef.current) {
        clearTimeout(pendingNavigationRef.current);
      }
      interactionHandleRef.current?.cancel?.();
    };
  }, []);

  // Find active plugin id
  const activePlugin = openTabs.find((t) => t.id === activePluginTabId);
  const activePluginId = activePlugin?.pluginId ?? null;

  // Get sessions for the active plugin — reads live from useState registry
  // For explorer, show editor's open files instead (explorer has no sessions)
  const effectivePluginId = activePluginId === 'explorer' ? 'editor' : activePluginId;
  const reg = effectivePluginId ? (registry[effectivePluginId] ?? null) : null;
  const sessions = reg?.sessions ?? [];
  const activeSessionId = reg?.activeSessionId ?? null;

  const filteredSessions = [...sessions].reverse().filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  // Group sessions by backend for AI plugin; flat list for other plugins
  const isAiPlugin = effectivePluginId === 'ai';
  type SessionGroup = { backend: string; label: string; sessions: SessionItem[] };
  const sessionGroups: SessionGroup[] = isAiPlugin
    ? (() => {
        const opencode = filteredSessions.filter((s) => !s.backend || s.backend === 'opencode');
        const codex = filteredSessions.filter((s) => s.backend === 'codex');
        const groups: SessionGroup[] = [];
        if (opencode.length > 0) groups.push({ backend: 'opencode', label: 'OpenCode', sessions: opencode });
        if (codex.length > 0) groups.push({ backend: 'codex', label: 'Codex', sessions: codex });
        return groups;
      })()
    : filteredSessions.length > 0
    ? [{ backend: '', label: '', sessions: filteredSessions }]
    : [];

  const pluginDef = effectivePluginId ? getPlugin(effectivePluginId) : null;
  const pluginName = pluginDef?.name ?? "Sessions";
  const shouldHideSearchAndSessions = effectivePluginId
    ? HIDE_SIDEBAR_SESSION_PLUGIN_IDS.has(effectivePluginId)
    : false;

  const handleSessionPress = (id: string) => {
    // If viewing editor sessions from explorer tab, switch to editor first
    if (activePluginId === 'explorer') {
      openTab('editor');
    }
    reg?.onSessionPress(id);
    props.navigation.closeDrawer();
  };

  const handleSessionClose = (id: string) => {
    if (effectivePluginId !== "ai") {
      reg?.onSessionClose(id);
      return;
    }

    Alert.alert(
      "Delete Session",
      "Are you sure you want to delete this session?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => reg?.onSessionClose(id),
        },
      ],
    );
  };

  const handleSessionRenameStart = (id: string, currentTitle: string) => {
    if (!reg?.onSessionRename) return;
    const target = sessions.find((session) => session.id === id);
    if (!target) return;
    setRenameSessionTarget({ ...target, title: currentTitle });
  };

  const hideCreateButton = activePluginId === 'editor' || activePluginId === 'explorer';

  const handleCreate = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    reg?.onCreateSession();
    props.navigation.closeDrawer();
  };

  const closeDrawerThen = useCallback((action: () => void) => {
    if (pendingNavigationRef.current) {
      clearTimeout(pendingNavigationRef.current);
      pendingNavigationRef.current = null;
    }
    interactionHandleRef.current?.cancel?.();

    props.navigation.closeDrawer();
    interactionHandleRef.current = InteractionManager.runAfterInteractions(() => {
      pendingNavigationRef.current = setTimeout(() => {
        pendingNavigationRef.current = null;
        action();
      }, 0);
    });
  }, [props.navigation]);

  const handleHomePress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      'Go Home',
      'Are you sure you want to leave this session?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Home',
          style: 'destructive',
          onPress: () => {
            closeDrawerThen(() => {
              router.replace("/auth");
              if (isConnected) disconnect();
            });
          },
        },
      ]
    );
  };

  const handleSettings = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeDrawerThen(() => {
      router.push("/settings" as any);
    });
  };

  const handleHelp = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeDrawerThen(() => {
      router.push("/help" as any);
    });
  };

  const handleFeedback = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closeDrawerThen(() => {
      router.push("/feedback" as any);
    });
  };

  const loadEditorDirectory = useCallback(async (dirPath: string) => {
    setLoadingEditorDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });

    try {
      const entries = await fs.list(dirPath);
      const children = toEditorTreeNodes(entries, dirPath);

      if (dirPath === ".") {
        setEditorTree(children);
      } else {
        setEditorTree((prev) => attachChildrenAtPath(prev, dirPath, children));
      }

      setLoadedEditorDirs((prev) => {
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });
      setEditorTreeError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load files";
      setEditorTreeError(message);
    } finally {
      setLoadingEditorDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [fs]);

  useEffect(() => {
    if (drawerStatus !== "open" || drawerContentVariant !== "editor-files") {
      return;
    }
    if (loadedEditorDirs.has(".")) {
      return;
    }
    void loadEditorDirectory(".");
  }, [drawerContentVariant, drawerStatus, loadEditorDirectory, loadedEditorDirs]);

  const handleEditorDirectoryToggle = useCallback((dirPath: string) => {
    const isExpanded = expandedEditorDirs.has(dirPath);
    if (isExpanded) {
      setExpandedEditorDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
      return;
    }

    setExpandedEditorDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });

    if (!loadedEditorDirs.has(dirPath) && !loadingEditorDirs.has(dirPath)) {
      void loadEditorDirectory(dirPath);
    }
  }, [expandedEditorDirs, loadedEditorDirs, loadingEditorDirs, loadEditorDirectory]);

  const handleEditorFileOpen = useCallback(async (filePath: string) => {
    setDrawerContentVariant("default");
    openTab("editor");
    props.navigation.closeDrawer();
    void gPI.editor.openFile(filePath).catch((error) => {
      const message = error instanceof Error ? error.message : "Failed to open file";
      Alert.alert("Error", message);
    });
  }, [openTab, props.navigation, setDrawerContentVariant]);

  const visibleEditorTree = flattenTree(editorTree, expandedEditorDirs);

  if (drawerContentVariant === "editor-files") {
    const isRootLoading = loadingEditorDirs.has(".") && editorTree.length === 0;
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          <View style={styles.editorFilesHeader}>
            <Text style={[styles.editorFilesTitle, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
              Files
            </Text>
            <View style={styles.editorFilesHeaderActions}>
              <TouchableOpacity
                onPress={() => {
                  setDrawerContentVariant("default");
                  openTab("explorer");
                  props.navigation.closeDrawer();
                }}
                activeOpacity={0.7}
                style={styles.editorFilesHeaderButton}
              >
                <Folder size={16} color={colors.fg.muted} strokeWidth={2} style={{ opacity: 0.9 }} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setLoadedEditorDirs(new Set());
                  setExpandedEditorDirs(new Set());
                  setEditorTree([]);
                  void loadEditorDirectory(".");
                }}
                activeOpacity={0.7}
                style={styles.editorFilesHeaderButton}
              >
                <RefreshCw size={16} color={colors.fg.muted} strokeWidth={2} style={{ opacity: 0.9 }} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setExpandedEditorDirs(new Set())}
                activeOpacity={0.7}
                style={styles.editorFilesHeaderButton}
              >
                <CopyMinus size={16} color={colors.fg.muted} strokeWidth={2} style={{ opacity: 0.9 }} />
              </TouchableOpacity>
            </View>
          </View>
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: colors.border.secondary,
              marginTop: 3,
              marginBottom: 8,
            }}
          />

          {isRootLoading ? (
            <View style={[styles.emptyState, { paddingTop: 32 }]}>
              <SpinningLoader color={colors.fg.muted} opacity={0.6} />
              <Text style={[styles.emptyText, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>
                Loading files...
              </Text>
            </View>
          ) : editorTreeError ? (
            <View style={[styles.emptyState, { paddingTop: 32 }]}>
              <Text style={[styles.emptyText, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>
                {editorTreeError}
              </Text>
            </View>
          ) : visibleEditorTree.length === 0 ? (
            <View style={[styles.emptyState, { paddingTop: 32 }]}>
              <Text style={[styles.emptyText, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>
                No files found
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator keyboardDismissMode="on-drag">
              {visibleEditorTree.map(({ node, depth }) => {
                const isDir = node.type === "directory";
                const isExpanded = expandedEditorDirs.has(node.path);
                const isLoading = loadingEditorDirs.has(node.path);
                return (
                  <TouchableOpacity
                    key={node.path}
                    onPress={() => {
                      if (isDir) {
                        handleEditorDirectoryToggle(node.path);
                        return;
                      }
                      void handleEditorFileOpen(node.path);
                    }}
                    activeOpacity={0.7}
                    style={[
                      styles.editorTreeRow,
                      {
                        paddingLeft: 14 + depth * 14,
                      },
                    ]}
                  >
                    {isDir ? (
                      <View style={styles.editorTreeChevron}>
                        {isExpanded
                          ? <ChevronDown size={14} color={colors.fg.subtle} strokeWidth={2} />
                          : <ChevronRight size={14} color={colors.fg.subtle} strokeWidth={2} />
                        }
                      </View>
                    ) : (
                      <View style={styles.editorTreeChevron} />
                    )}

                    <View style={styles.editorTreeIcon}>
                      <TreeIcon node={node} isExpanded={isExpanded} colors={colors} />
                    </View>

                    <Text
                      numberOfLines={1}
                      style={[styles.editorTreeLabel, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                    >
                      {node.name}
                    </Text>

                    {isLoading ? <SpinningLoader color={colors.fg.subtle} opacity={0.7} size={12} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

        {!shouldHideSearchAndSessions ? (
          <>
            {/* Top: Search + Create/Cancel */}
            <View style={styles.topRow}>
              <View style={[styles.searchWrap, { backgroundColor: colors.bg.raised }]}>
                <Search size={18} color={colors.fg.muted} strokeWidth={2} />
                <TextInput
                  ref={inputRef}
                  style={[styles.searchInput, { color: colors.fg.default, fontFamily: fonts.sans.regular }]}
                  placeholder="Search sessions..."
                  placeholderTextColor={colors.fg.subtle}
                  value={search}
                  onChangeText={setSearch}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                />
              </View>
              {(searchFocused || !hideCreateButton) && (
                <TouchableOpacity
                  onPress={searchFocused ? handleCancelSearch : handleCreate}
                  activeOpacity={0.7}
                  style={[styles.createBtn, { backgroundColor: colors.bg.raised }]}
                >
                  {searchFocused
                    ? <X size={18} color={colors.fg.default} strokeWidth={2} />
                    : <PencilLine size={18} color={colors.fg.default} strokeWidth={2} />
                  }
                </TouchableOpacity>
              )}
            </View>

            {/* Sessions */}
            <View style={styles.sessionsSection}>
              {effectivePluginId === 'ai' ? null : (
                <Text style={[styles.sessionsLabel, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
                  {pluginName} Sessions
                </Text>
              )}

              {reg?.loading ? (
                <View style={styles.emptyState}>
                  <SpinningLoader color={colors.fg.muted} opacity={0.6} />
                  <Text style={[styles.emptyText, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>
                    Loading sessions...
                  </Text>
                </View>
              ) : filteredSessions.length === 0 ? (
                <View style={[styles.emptyState, { paddingTop: 50 }]}>
                  <Ionicons name="chatbox-ellipses" size={26} color={colors.fg.muted} />
                  <Text style={[styles.emptyText, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>
                    No sessions yet
                  </Text>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator keyboardDismissMode="on-drag">
                  {sessionGroups.map((group) => (
                    <View key={group.backend || 'default'} style={styles.sessionGroup}>
                      {group.label ? (
                        <Text style={[styles.groupLabel, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
                          {group.label}
                        </Text>
                      ) : null}
                      {(() => {
                        const isExpanded = expandedBackends.has(group.backend);
                        const isLoading = loadingBackends.has(group.backend);
                        const limited = isAiPlugin && !isExpanded && !search
                          ? group.sessions.slice(0, SESSIONS_LIMIT)
                          : group.sessions;
                        const hasMore = isAiPlugin && !isExpanded && !search && group.sessions.length > SESSIONS_LIMIT;
                        return (
                          <>
                            {limited.map((item) => {
                              const isActive = item.id === activeSessionId;
                              const rawFileName = item.title.endsWith(" *")
                                ? item.title.slice(0, -2)
                                : item.title;
                              const showEditorFileIcon = effectivePluginId === "editor";
                              return (
                                <TouchableOpacity
                                  key={item.id}
                                  onPress={() => handleSessionPress(item.id)}
                                  onLongPress={() => setSelectedSessionAction(item)}
                                  activeOpacity={0.7}
                                  style={[
                                    styles.sessionItem,
                                    {
                                      backgroundColor: isActive ? colors.bg.raised : "transparent",
                                    },
                                  ]}
                                >
                                  {showEditorFileIcon ? (
                                    <View style={styles.sessionFileIconWrap}>
                                      <SessionFileIcon fileName={rawFileName} colors={colors} />
                                    </View>
                                  ) : null}
                                  <Text
                                    style={[styles.sessionTitle, { color: colors.fg.default, fontFamily: fonts.sans.regular, flex: 1, opacity: isActive ? 1 : 0.8 }]}
                                    numberOfLines={1}
                                  >
                                    {item.title}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                            {isLoading && (
                              <View style={styles.viewAllRow}>
                                <SpinningLoader color={colors.fg.muted} opacity={0.6} size={14} />
                                <Text style={[styles.viewAllText, { color: colors.fg.muted, fontFamily: fonts.sans.regular, opacity: 0.6 }]}>
                                  Loading...
                                </Text>
                              </View>
                            )}
                            {hasMore && !isLoading && (
                              <TouchableOpacity
                                onPress={() => handleViewAll(group.backend)}
                                activeOpacity={0.7}
                                style={styles.viewAllRow}
                              >
                                <Text style={[styles.viewAllText, { color: colors.fg.muted, fontFamily: fonts.sans.regular, opacity: 0.6 }]}>
                                  View all ({group.sessions.length - SESSIONS_LIMIT} more)
                                </Text>
                                <ChevronDown size={17} color={colors.fg.muted} strokeWidth={2} style={{ opacity: 0.8 }} />
                              </TouchableOpacity>
                            )}
                          </>
                        );
                      })()}
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </>
        ) : (
          <View style={[styles.sessionsSection, { justifyContent: 'flex-start' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 12 }}>
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  backgroundColor: isDark ? "#FFFFFF" : "#000000",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                }}
              >
                <Image
                  source={require('@/assets/images/icon-bg.png')}
                  style={{ width: 56, height: 56, borderRadius: 14 }}
                  resizeMode="contain"
                />
              </View>
              <View style={{ justifyContent: 'center' }}>
                <Text style={{ fontSize: 20, fontFamily: 'PublicSans_700Bold', color: colors.fg.default, lineHeight: 26 }}>
                  Lunel
                </Text>
                <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.subtle, lineHeight: 17 }}>
                  Ship from Anywhere
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Bottom bar */}
        <View style={[styles.bottomBar, { borderTopColor: colors.border.secondary }]}>
          <TouchableOpacity onPress={handleHomePress} style={styles.bottomBtn} activeOpacity={0.7}>
            <Home size={22} color={colors.fg.muted} strokeWidth={1.6} />
            <Text style={[styles.bottomBtnLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>Home</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSettings} style={styles.bottomBtn} activeOpacity={0.7}>
            <Settings size={22} color={colors.fg.muted} strokeWidth={1.6} />
            <Text style={[styles.bottomBtnLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleHelp} style={styles.bottomBtn} activeOpacity={0.7}>
            <HelpCircle size={22} color={colors.fg.muted} strokeWidth={1.6} />
            <Text style={[styles.bottomBtnLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>Help</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleFeedback} style={styles.bottomBtn} activeOpacity={0.7}>
            <MessageCircle size={22} color={colors.fg.muted} strokeWidth={1.6} />
            <Text style={[styles.bottomBtnLabel, { color: colors.fg.subtle, fontFamily: fonts.sans.regular }]}>Feedback</Text>
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          <View style={[styles.statusDot, { backgroundColor: isConnected ? '#22c55e' : colors.fg.subtle }]} />
        </View>

        <InfoSheet
          visible={selectedSessionAction !== null}
          onClose={() => {
            setSelectedSessionAction(null);
            setPendingRenameSessionTarget(null);
          }}
          onAfterClose={() => {
            if (!pendingRenameSessionTarget) return;
            handleSessionRenameStart(pendingRenameSessionTarget.id, pendingRenameSessionTarget.title);
            setPendingRenameSessionTarget(null);
          }}
          title={selectedSessionAction?.title ?? "Session"}
          description="Session actions"
        >
          <View style={{ gap: 8, paddingBottom: 8 }}>
            {reg?.onSessionRename ? (
              <TouchableOpacity
                onPress={() => {
                  if (!selectedSessionAction) return;
                  setPendingRenameSessionTarget(selectedSessionAction);
                  setSelectedSessionAction(null);
                }}
                activeOpacity={0.7}
                style={[styles.sheetRow, { backgroundColor: colors.bg.raised, borderRadius: 10, marginBottom: 0 }]}
              >
                <PencilLine size={18} color={colors.fg.default} strokeWidth={2} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                  Rename
                </Text>
                <ChevronRight size={18} color={colors.fg.subtle} strokeWidth={2} />
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              onPress={() => {
                if (!selectedSessionAction) return;
                const id = selectedSessionAction.id;
                setSelectedSessionAction(null);
                handleSessionClose(id);
              }}
              activeOpacity={0.7}
              style={[styles.sheetRow, { backgroundColor: colors.bg.raised, borderRadius: 10, marginBottom: 0 }]}
            >
              <Trash size={18} color={colors.git.deleted} strokeWidth={2} />
              <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.git.deleted }}>
                Delete
              </Text>
              <ChevronRight size={18} color={colors.git.deleted} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </InfoSheet>

        <InputModal
          visible={renameSessionTarget !== null}
          onCancel={() => setRenameSessionTarget(null)}
          onAccept={(value) => {
            const trimmed = value.trim();
            if (!trimmed || !renameSessionTarget || !reg?.onSessionRename) {
              setRenameSessionTarget(null);
              return;
            }
            reg.onSessionRename(renameSessionTarget.id, trimmed);
            setRenameSessionTarget(null);
          }}
          title="Rename Session"
          description="Enter a new title"
          placeholder="Session title"
          acceptLabel="Rename"
          cancelLabel="Cancel"
          initialValue={renameSessionTarget?.title ?? ""}
        />

      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 12,
  },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    height: 44,
    borderRadius: radius.lg,
  },
  searchInput: {
    flex: 1,
    fontSize: typography.body,
    height: 44,
  },
  createBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
  },
  sessionsSection: {
    flex: 1,
    paddingHorizontal: 0,
    paddingTop: 0,
    gap: 4,
  },
  sessionsLabel: {
    fontSize: typography.subHeading,
    marginBottom: 8,
    paddingHorizontal: 14,
    opacity: 0.65,
  },
  groupLabel: {
    fontSize: typography.subHeading,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    opacity: 0.65,
  },
  sessionGroup: {
    gap: 2,
  },
  sessionItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 9,
    paddingLeft: 20,
    paddingRight: 14,
  },
  sessionTitle: {
    fontSize: typography.body,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  sessionFileIconWrap: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  viewAllRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    marginBottom: 3,
  },
  viewAllText: {
    fontSize: typography.body,
  },
  emptyState: {
    paddingTop: 20,
    paddingHorizontal: 14,
    alignItems: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: typography.body,
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 4,
  },
  bottomBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 2,
  },
  bottomBtnLabel: {
    fontSize: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 14,
  },
  editorFilesHeader: {
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  editorFilesHeaderButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  editorFilesHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  editorTreeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 14,
    height: 28,
    gap: 2,
  },
  editorTreeChevron: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  editorTreeIcon: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  editorTreeLabel: {
    flex: 1,
    fontSize: typography.body,
  },
  editorFilesTitle: {
    fontSize: typography.heading,
    opacity: 0.65,
  },
});
