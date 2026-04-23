import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import InfoSheet from '@/components/InfoSheet';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing, runOnJS } from 'react-native-reanimated';
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Modal,
  Pressable,
  ActivityIndicator,
  Alert,
  BackHandler,
  InteractionManager,
  Linking,
  StyleSheet,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { FlashList } from '@shopify/flash-list';
import { SvgUri } from 'react-native-svg';
import {
  CloudOff,
  X,
  ArrowLeft,
  Search,
  Settings2,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  AlertCircle,
  Pencil,
  Trash,
  MoreVertical,
  File,
  ExternalLink,
  Circle,
  CircleDot,
  Copy,
} from 'lucide-react-native';
import Loading from '@/components/Loading';
import Header, { useHeaderHeight } from "@/components/Header";
import { MenuView } from '@react-native-menu/menu';
import { useTheme } from '@/contexts/ThemeContext';
import { typography } from '@/constants/themes';
import * as Clipboard from 'expo-clipboard';
import { useConnection } from '@/contexts/ConnectionContext';
import { useApi, FileEntry, ApiError } from '@/hooks/useApi';
import { gPI, innerApi } from '@/plugins';
import { usePlugins } from '@/plugins/context';
import { PluginPanelProps } from '../../types';
import { resolveMaterialIconUri } from './materialIconTheme';

type SortOption = 'name' | 'size' | 'modified';
type FilterOption = 'all' | 'files' | 'folders';
type ExplorerListItem = FileEntry & { __navParent?: boolean };

// Helper functions (moved outside component to avoid re-creation)
const formatFileSize = (bytes?: number) => {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTime = (mtime?: number) => {
  if (!mtime) return '-';
  const date = new Date(mtime);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

// Memoized file item component
interface FileItemProps {
  item: ExplorerListItem;
  isFirst: boolean;
  onPress: (item: ExplorerListItem) => void;
  colors: any;
  fonts: any;
  spacing: any;
  radius: any;
}


const EntryIcon = memo(function EntryIcon({
  item,
  colors,
  size = 18,
}: {
  item: ExplorerListItem;
  colors: any;
  size?: number;
}) {
  const [iconLoadFailed, setIconLoadFailed] = useState(false);
  const iconUri = item.__navParent ? null : resolveMaterialIconUri(item);

  useEffect(() => {
    setIconLoadFailed(false);
  }, [iconUri]);

  if (item.__navParent) {
    return <ArrowLeft size={size} color="#ffffff" />;
  }

  if (!iconUri || iconLoadFailed) {
    return item.type === 'directory'
      ? <Folder size={size} color={colors.accent.default} />
      : <File size={size} color={colors.fg.muted} />;
  }

  return (
    <SvgUri
      width={size + 2}
      height={size + 2}
      uri={iconUri}
      onError={() => setIconLoadFailed(true)}
    />
  );
});

const FileItem = memo(function FileItem({ item, isFirst, onPress, colors, fonts, spacing, radius }: FileItemProps) {
  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: spacing[3],
        paddingVertical: spacing[1],
        gap: spacing[3],
      }}
    >
      <View style={{
        width: 36,
        height: 36,
        borderRadius: 6,
        backgroundColor: item.type === 'directory' ? colors.accent.default + '20' : colors.bg.raised,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <EntryIcon item={item} colors={colors} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{
          fontSize: typography.body,
          fontFamily: fonts.sans.regular,
          color: colors.fg.default,
        }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{
          fontSize: typography.caption,
          fontFamily: fonts.sans.regular,
          color: colors.fg.muted,
          marginTop: 2,
        }}>
          {item.__navParent ? 'Back' : item.type === 'directory' ? 'Directory' : formatFileSize(item.size)}
          {item.mtime && ` · ${formatTime(item.mtime)}`}
        </Text>
      </View>
      {item.type === 'directory' && !item.__navParent ? (
        <ChevronRight size={18} color={colors.fg.subtle} />
      ) : null}
    </TouchableOpacity>
  );
});


function ExplorerPanel({ instanceId, isActive }: PluginPanelProps) {
  const { colors, fonts, spacing, radius } = useTheme();
  const headerHeight = useHeaderHeight();

  const { status, capabilities } = useConnection();
  const { fs } = useApi();
  const { openTab } = usePlugins();
  const isConnected = status === 'connected';

  const [currentPath, setCurrentPath] = useState('.');
  const [items, setItems] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [filterBy, setFilterBy] = useState<FilterOption>('all');
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [selectedItem, setSelectedItem] = useState<FileEntry | null>(null);
  const [selectedItemIsBinary, setSelectedItemIsBinary] = useState<boolean | null>(null);
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [filtersModalVisible, setFiltersModalVisible] = useState(false);
  const filtersBackdropOpacity = useSharedValue(0);
  const filtersSheetTranslateY = useSharedValue(1000);

  const hideFiltersModal = useCallback(() => setFiltersModalVisible(false), []);

  useEffect(() => {
    if (showFiltersModal) {
      setFiltersModalVisible(true);
      filtersBackdropOpacity.value = 0;
      filtersSheetTranslateY.value = 1000;
      filtersBackdropOpacity.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) });
      filtersSheetTranslateY.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
    } else {
      filtersBackdropOpacity.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) });
      filtersSheetTranslateY.value = withTiming(1000, { duration: 240, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(hideFiltersModal)();
      });
    }
  }, [showFiltersModal]);

  const filtersBackdropStyle = useAnimatedStyle(() => ({ opacity: filtersBackdropOpacity.value }));
  const filtersSheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: filtersSheetTranslateY.value }] }));
  const [uploading, setUploading] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [uploadStage, setUploadStage] = useState<'idle' | 'preparing' | 'writing'>('idle');
  const uploadPickerInFlightRef = useRef(false);
  const uploadCancelRequestedRef = useRef(false);
  const listRef = useRef<FlashList<ExplorerListItem> | null>(null);
  const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024;

  const openWithSystem = async (item: FileEntry) => {
    const filePath = currentPath === '.' ? item.name : `${currentPath}/${item.name}`;

    try {
      const result = await fs.read(filePath);
      if (result.encoding !== 'base64') {
        Alert.alert('Not binary', 'This file can be opened in the editor.');
        return;
      }

      if (!FileSystem.cacheDirectory) {
        Alert.alert('Unavailable', 'Unable to access local storage for opening file.');
        return;
      }

      const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const localUri = `${FileSystem.cacheDirectory}lunel-open-${Date.now()}-${safeName}`;
      await FileSystem.writeAsStringAsync(localUri, result.content, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const canOpen = await Linking.canOpenURL(localUri);
      if (!canOpen) {
        Alert.alert('No app found', 'No installed app can open this file type.');
        return;
      }

      await Linking.openURL(localUri);
      closeModal();
    } catch (err) {
      const apiError = err as ApiError;
      Alert.alert('Error', apiError.message || 'Failed to open file');
    }
  };

  const openInEditor = async (item: FileEntry) => {
    const filePath = currentPath === '.' ? item.name : `${currentPath}/${item.name}`;

    closeModal();
    try {
      openTab('editor');
      await gPI.editor.openFile(filePath);
    } catch (err) {
      const apiError = err as ApiError;
      Alert.alert('Error', apiError.message || 'Failed to open file in editor');
    }
  };

  // Load directory contents
  const loadDirectory = useCallback(async (path: string) => {
    if (!isConnected) return;

    setLoading(true);
    setError(null);
    try {
      const entries = await fs.list(path);
      setItems(entries);
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.message || 'Failed to load directory');
      setItems([]);
    } finally {
      setLoading(false);
      innerApi.refreshBottomBar();
    }
  }, [isConnected, fs]);

  // Load on mount and when path changes
  useEffect(() => {
    if (isConnected) {
      loadDirectory(currentPath);
    }
  }, [currentPath, isConnected, loadDirectory]);

  // Refresh when panel becomes active
  useEffect(() => {
    if (isActive && isConnected) {
      loadDirectory(currentPath);
    }
  }, [isActive, isConnected]);

  useEffect(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [currentPath]);

  // Get filtered and sorted items
  const currentItems = useMemo(() => {
    let result = [...items];

    // Filter
    if (filterBy === 'files') {
      result = result.filter(item => item.type === 'file');
    } else if (filterBy === 'folders') {
      result = result.filter(item => item.type === 'directory');
    }

    if (!showHiddenFiles) {
      result = result.filter(item => !item.name.startsWith('.'));
    }

    // Search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(item => item.name.toLowerCase().includes(query));
    }

    // Sort
    result.sort((a, b) => {
      // Folders always first
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }

      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'size':
          return (b.size || 0) - (a.size || 0);
        case 'modified':
          return (b.mtime || 0) - (a.mtime || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [items, searchQuery, sortBy, filterBy, showHiddenFiles]);

  const navigateUp = useCallback(() => {
    if (currentPath === '.' || currentPath === '') return;
    const segments = currentPath.split('/').filter(Boolean);
    if (segments.length <= 1) {
      setCurrentPath('.');
    } else {
      setCurrentPath(segments.slice(0, -1).join('/'));
    }
  }, [currentPath]);

  // Handle Android hardware back: go up one folder when not at root
  useEffect(() => {
    if (!isActive) return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (currentPath !== '.' && currentPath !== '') {
        navigateUp();
        return true;
      }
      return false;
    });

    return () => sub.remove();
  }, [isActive, currentPath, navigateUp]);

  const openItem = (item: ExplorerListItem) => {
    if (item.__navParent) {
      navigateUp();
      return;
    }

    if (item.type === 'directory') {
      const newPath = currentPath === '.' ? item.name : `${currentPath}/${item.name}`;
      setCurrentPath(newPath);
    } else {
      setSelectedItem(item);
      setSelectedItemIsBinary(null);
      openModal();
    }
  };

  const openModal = () => {};

  const closeModal = () => {
    setSelectedItem(null);
    setSelectedItemIsBinary(null);
  };

  // Detect binary/text for selected file to render the correct primary action.
  useEffect(() => {
    if (!selectedItem || selectedItem.type !== 'file') return;
    let cancelled = false;

    const detectEncoding = async () => {
      const filePath = currentPath === '.' ? selectedItem.name : `${currentPath}/${selectedItem.name}`;
      try {
        const stat = await fs.stat(filePath);
        if (cancelled) return;
        setSelectedItemIsBinary(!!stat.isBinary);
      } catch {
        if (!cancelled) {
          setSelectedItemIsBinary(false);
        }
      }
    };

    detectEncoding();
    return () => {
      cancelled = true;
    };
  }, [selectedItem, currentPath, fs]);

  const promptCreate = (type: 'file' | 'directory') => {
    Alert.prompt(
      `New ${type === 'file' ? 'File' : 'Folder'}`,
      undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async (value) => {
            const name = (value || '').trim();
            if (!name) return;
            const path = currentPath === '.' ? name : `${currentPath}/${name}`;
            try {
              await fs.create(path, type);
              loadDirectory(currentPath);
            } catch (err) {
              const apiError = err as ApiError;
              Alert.alert('Error', apiError.message || 'Failed to create');
            }
          },
        },
      ],
      'plain-text',
      '',
    );
  };

  const handleDelete = async (item: FileEntry) => {
    const path = currentPath === '.' ? item.name : `${currentPath}/${item.name}`;
    Alert.alert(
      'Delete',
      `Are you sure you want to delete "${item.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await fs.remove(path, true);
              await gPI.editor.notifyFileDeleted(path);
              closeModal();
              loadDirectory(currentPath);
            } catch (err) {
              const apiError = err as ApiError;
              Alert.alert('Error', apiError.message || 'Failed to delete');
            }
          },
        },
      ]
    );
  };

  const openRenameModal = () => {
    if (!selectedItem) return;
    const fromPath = currentPath === '.' ? selectedItem.name : `${currentPath}/${selectedItem.name}`;
    const currentName = selectedItem.name;
    closeModal();

    Alert.prompt(
      `Rename ${selectedItem.type === 'directory' ? 'Folder' : 'File'}`,
      undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rename',
          onPress: async (value) => {
            const nextName = (value || '').trim();
            if (!nextName || nextName === currentName) return;
            if (nextName.includes('/') || nextName.includes('\\')) {
              Alert.alert('Invalid name', 'Name cannot contain path separators');
              return;
            }
            const dirPart = fromPath.includes('/')
              ? fromPath.substring(0, fromPath.lastIndexOf('/'))
              : '.';
            const to = dirPart === '.' ? nextName : `${dirPart}/${nextName}`;
            try {
              await fs.move(fromPath, to);
              await gPI.editor.notifyFileRenamed(fromPath, to);
              loadDirectory(currentPath);
            } catch (err) {
              const apiError = err as ApiError;
              Alert.alert('Error', apiError.message || 'Failed to rename');
            }
          },
        },
      ],
      'plain-text',
      currentName,
    );
  };

  const handleUploadFile = async () => {
    if (uploadPickerInFlightRef.current) {
      return;
    }

    try {
      uploadCancelRequestedRef.current = false;
      uploadPickerInFlightRef.current = true;
      await new Promise<void>((resolve) => {
        InteractionManager.runAfterInteractions(() => {
          setTimeout(resolve, 200);
        });
      });

      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) {
        return;
      }

      const asset = result.assets[0];
      const fileName = (asset.name || asset.uri.split('/').pop() || '').trim();
      if (!fileName) {
        Alert.alert('Invalid file', 'Could not determine the selected file name.');
        return;
      }

      const size = typeof asset.size === 'number'
        ? asset.size
        : (await FileSystem.getInfoAsync(asset.uri)).exists
          ? ((await FileSystem.getInfoAsync(asset.uri)) as { size?: number }).size
          : undefined;

      if (typeof size === 'number' && size > MAX_UPLOAD_SIZE_BYTES) {
        Alert.alert('File too large', 'Files must be 15 MB or smaller.');
        return;
      }

      const targetPath = currentPath === '.' ? fileName : `${currentPath}/${fileName}`;
      const fileAlreadyExists = items.some((entry) => entry.name === fileName);

      if (fileAlreadyExists) {
        const shouldOverwrite = await new Promise<boolean>((resolve) => {
          Alert.alert(
            'Replace file?',
            `"${fileName}" already exists in this folder.`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Replace', style: 'destructive', onPress: () => resolve(true) },
            ]
          );
        });
        if (!shouldOverwrite) {
          return;
        }
      }

      setUploading(true);
      setUploadStage('preparing');
      setUploadStatusText(`Preparing ${fileName}...`);
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (uploadCancelRequestedRef.current) {
        return;
      }
      setUploadStage('writing');
      setUploadStatusText(`Uploading ${fileName} to ${currentPath === '.' ? 'the current folder' : currentPath}...`);
      await fs.write(targetPath, base64, 'base64', 120000);
      if (uploadCancelRequestedRef.current) {
        return;
      }
      await loadDirectory(currentPath);
      Alert.alert('Uploaded', `"${fileName}" was added to ${currentPath === '.' ? 'the current folder' : currentPath}.`);
    } catch (err) {
      const apiError = err as ApiError;
      Alert.alert('Upload failed', apiError.message || 'Failed to upload file');
    } finally {
      uploadPickerInFlightRef.current = false;
      setUploading(false);
      setUploadStage('idle');
      setUploadStatusText('');
    }
  };

  const handleCancelUpload = () => {
    uploadCancelRequestedRef.current = true;
    if (uploadStage !== 'writing') {
      setUploading(false);
      setUploadStage('idle');
      setUploadStatusText('');
    }
  };

  const getSortLabel = (option: SortOption) => {
    switch (option) {
      case 'name': return 'Name';
      case 'size': return 'Size';
      case 'modified': return 'Modified';
    }
  };

  const getFilterLabel = (option: FilterOption) => {
    switch (option) {
      case 'all': return 'All';
      case 'files': return 'Files only';
      case 'folders': return 'Folders only';
    }
  };

  const hasActiveFilters = sortBy !== 'name' || filterBy !== 'all';
  const isRootPath = currentPath === '.' || currentPath === '';
  const displayItems = useMemo<ExplorerListItem[]>(() => {
    if (isRootPath) return currentItems;
    return [{ name: '..', type: 'directory', __navParent: true }, ...currentItems];
  }, [isRootPath, currentItems]);
  const selectedItemPath = selectedItem
    ? (currentPath === '.' ? selectedItem.name : `${currentPath}/${selectedItem.name}`)
    : '';
  const getAbsolutePath = useCallback((path: string) => {
    const rootDir = capabilities?.rootDir ?? '';
    const rel = path === '.' || path === '' ? '' : `/${path}`;
    return rootDir ? `${rootDir}${rel}` : (rel || '/');
  }, [capabilities?.rootDir]);

  // Not connected state
  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, justifyContent: 'center', alignItems: 'center' }}>
        <CloudOff size={48} color={colors.fg.muted} />
        <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular, marginTop: spacing[3] }}>
          Not connected to CLI
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <Header
        title="Explorer"
        colors={colors}
        rightAccessory={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => setShowSearch(!showSearch)} style={{ padding: 8 }}>
              {showSearch ? (
                <X size={20} color={colors.fg.muted} strokeWidth={2} />
              ) : (
                <Search size={20} color={colors.fg.muted} strokeWidth={2} />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowFiltersModal(true)} style={{ padding: 8 }}>
              <View>
                <Settings2 size={20} color={colors.fg.muted} strokeWidth={2} />
                {hasActiveFilters && (
                  <View style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    width: 8,
                    height: 8,
                    borderRadius: radius.full,
                    backgroundColor: colors.accent.default,
                  }} />
                )}
              </View>
            </TouchableOpacity>
            <MenuView
              shouldOpenOnLongPress={false}
              preferredMenuAnchorPosition="bottom"
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === 'new-file') {
                  promptCreate('file');
                } else if (nativeEvent.event === 'new-folder') {
                  promptCreate('directory');
                } else if (nativeEvent.event === 'upload-file') {
                  handleUploadFile();
                } else if (nativeEvent.event === 'toggle-hidden-files') {
                  setShowHiddenFiles((prev) => !prev);
                } else if (nativeEvent.event === 'copy-relative-path') {
                  Clipboard.setStringAsync(currentPath);
                } else if (nativeEvent.event === 'copy-path') {
                  Clipboard.setStringAsync(getAbsolutePath(currentPath));
                } else if (nativeEvent.event === 'refresh') {
                  loadDirectory(currentPath);
                }
              }}
              actions={[
                { id: 'new-file', title: 'New File' },
                { id: 'new-folder', title: 'New Folder' },
                { id: 'upload-file', title: 'Upload File' },
                { id: 'copy-relative-path', title: 'Copy Relative Path' },
                { id: 'copy-path', title: 'Copy Path' },
                {
                  id: 'toggle-hidden-files',
                  title: 'Show Hidden Files',
                  state: showHiddenFiles ? 'on' : 'off',
                },
                { id: 'refresh', title: 'Refresh' },
              ]}
            >
              <TouchableOpacity style={{ padding: 8 }} activeOpacity={0.7}>
                <MoreVertical size={20} color={colors.fg.muted} strokeWidth={2} />
              </TouchableOpacity>
            </MenuView>
          </View>
        }
        rightAccessoryWidth={120}
        showBottomBorder={true}
      />

      {/* Search Bar (hidden by default) */}
      {showSearch && (
        <View style={{
          paddingHorizontal: spacing[3],
          paddingTop: spacing[2],
          paddingBottom: spacing[2],
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border.secondary,
        }}>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.bg.raised,
            borderRadius: radius.md,
            height: 40,
            paddingHorizontal: spacing[3],
            gap: spacing[2],
          }}>
            <Search size={16} color={colors.fg.default} strokeWidth={2} />
            <TextInput
              style={{
                flex: 1,
                fontSize: typography.body,
                fontFamily: fonts.sans.regular,
                color: colors.fg.default,
                outline: 'none',
              } as any}
              placeholder="search files..."
              placeholderTextColor={colors.fg.subtle}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
      )}

      {/* File List with Action Buttons as header */}
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
          {loading && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 }}>
              <Loading />
            </View>
          )}
          {!loading && !error && currentItems.length === 0 && isRootPath && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
              <FolderOpen size={48} color={colors.fg.subtle} />
              <Text style={{
                fontSize: 14,
                fontFamily: fonts.sans.medium,
                color: colors.fg.muted,
                marginTop: spacing[3],
              }}>
                {searchQuery ? 'No matching items' : 'This folder is empty'}
              </Text>
            </View>
          )}
          {!loading && error && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 1, paddingHorizontal: spacing[4] }}>
              <AlertCircle size={48} color={'#ef4444'} />
              <Text style={{
                fontSize: 14,
                fontFamily: fonts.sans.medium,
                color: '#ef4444',
                marginTop: spacing[3],
                textAlign: 'center',
              }}>
                {error}
              </Text>
              <TouchableOpacity
                onPress={() => loadDirectory(currentPath)}
                style={{
                  marginTop: spacing[3],
                  paddingHorizontal: spacing[4],
                  paddingVertical: spacing[2],
                  borderRadius: radius.md,
                  backgroundColor: colors.bg.base,
                }}
              >
                <Text style={{ fontSize: 14, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                  Retry
                </Text>
              </TouchableOpacity>
            </View>
          )}
          <FlashList
            ref={listRef}
            data={loading || error ? [] : displayItems}
            estimatedItemSize={44}
            ListEmptyComponent={null}
            ItemSeparatorComponent={null}
            contentContainerStyle={{ paddingTop: spacing[2], paddingBottom: spacing[6] }}
            renderItem={({ item }) => (
              <FileItem
                item={item}
                isFirst={false}
                onPress={openItem}
                colors={colors}
                fonts={fonts}
                spacing={spacing}
                radius={radius}
              />
            )}
            keyExtractor={(item) => (item.__navParent ? '__parent__' : item.name)}
          />
      </View>

      <InfoSheet
        visible={selectedItem !== null}
        onClose={closeModal}
        title={selectedItem?.name ?? ''}
        description={selectedItemPath}
        icon={selectedItem ? <EntryIcon item={selectedItem} colors={colors} size={26} /> : undefined}
      >
        <ScrollView
          contentContainerStyle={{ gap: spacing[4], paddingBottom: spacing[2] }}
          keyboardDismissMode="on-drag"
        >
          <View style={{ flexDirection: 'row', gap: spacing[4] }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                Size
              </Text>
              <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: '#ffffff' }}>
                {selectedItem ? formatFileSize(selectedItem.size) : '-'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                Modified
              </Text>
              <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: '#ffffff' }}>
                {selectedItem ? formatTime(selectedItem.mtime) : '-'}
              </Text>
            </View>
          </View>

          <View style={{ gap: spacing[2] }}>
            {selectedItemIsBinary !== true ? (
              <TouchableOpacity
                style={[styles.sheetRow, { borderRadius: radius.xl, backgroundColor: colors.accent.default, marginBottom: 0 }]}
                onPress={() => { if (selectedItem) openInEditor(selectedItem); }}
                activeOpacity={0.7}
              >
                <FileText size={20} color={'#ffffff'} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.semibold, color: '#ffffff' }}>
                  Open in editor
                </Text>
                <ChevronRight size={18} color={'#ffffff'} />
              </TouchableOpacity>
            ) : null}

            {selectedItemIsBinary === true ? (
              <TouchableOpacity
                style={[styles.sheetRow, { borderRadius: radius.xl, backgroundColor: colors.accent.default, marginBottom: 0 }]}
                onPress={() => { if (selectedItem) openWithSystem(selectedItem); }}
                activeOpacity={0.7}
              >
                <ExternalLink size={20} color={'#ffffff'} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.semibold, color: '#ffffff' }}>
                  Open
                </Text>
                <ChevronRight size={18} color={'#ffffff'} />
              </TouchableOpacity>
            ) : null}

            <View style={{ borderRadius: radius.xl, overflow: 'hidden', backgroundColor: colors.bg.raised }}>
              <TouchableOpacity
                style={[styles.sheetRow, { marginBottom: 0 }]}
                onPress={async () => {
                  if (!selectedItemPath) return;
                  await Clipboard.setStringAsync(selectedItemPath);
                  closeModal();
                }}
                activeOpacity={0.7}
              >
                <Copy size={18} color={colors.fg.default} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                  Copy relative path
                </Text>
                <ChevronRight size={18} color={colors.fg.subtle} />
              </TouchableOpacity>

              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary, marginLeft: 50 }} />

              <TouchableOpacity
                style={[styles.sheetRow, { marginBottom: 0 }]}
                onPress={async () => {
                  if (!selectedItemPath) return;
                  await Clipboard.setStringAsync(getAbsolutePath(selectedItemPath));
                  closeModal();
                }}
                activeOpacity={0.7}
              >
                <Copy size={18} color={colors.fg.default} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                  Copy path
                </Text>
                <ChevronRight size={18} color={colors.fg.subtle} />
              </TouchableOpacity>

              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary, marginLeft: 50 }} />

              <TouchableOpacity
                style={[styles.sheetRow, { marginBottom: 0 }]}
                onPress={openRenameModal}
                activeOpacity={0.7}
              >
                <Pencil size={18} color={colors.fg.default} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                  Rename
                </Text>
                <ChevronRight size={18} color={colors.fg.subtle} />
              </TouchableOpacity>

              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary, marginLeft: 50 }} />

              <TouchableOpacity
                style={[styles.sheetRow, { marginBottom: 0 }]}
                onPress={() => { if (selectedItem) handleDelete(selectedItem); }}
                activeOpacity={0.7}
              >
                <Trash size={18} color={'#ef4444'} />
                <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.sans.medium, color: '#ef4444' }}>
                  Delete
                </Text>
                <ChevronRight size={18} color={'#ef4444'} />
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </InfoSheet>


      <Modal
        visible={uploading}
        transparent
        animationType="fade"
        onRequestClose={handleCancelUpload}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.22)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing[6] }}>
          <View style={{
            width: '100%',
            maxWidth: 320,
            backgroundColor: colors.bg.raised,
            borderRadius: radius['2xl'],
            paddingHorizontal: spacing[5],
            paddingTop: spacing[5],
            paddingBottom: spacing[4],
            borderWidth: 1,
            borderColor: colors.bg.raised,
            gap: spacing[5],
          }}>
            <View style={{ alignItems: 'center', gap: spacing[3] }}>
              <View style={{
                width: 52,
                height: 52,
                borderRadius: radius.full,
                backgroundColor: colors.bg.base,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <ActivityIndicator size="small" color={colors.fg.default} />
              </View>
              <Text style={{
                fontSize: 18,
                fontFamily: fonts.sans.semibold,
                color: colors.fg.default,
                textAlign: 'center',
              }}>
                Uploading File
              </Text>
              <Text style={{
                fontSize: 14,
                fontFamily: fonts.sans.regular,
                color: colors.fg.muted,
                textAlign: 'center',
                lineHeight: 21,
                paddingHorizontal: spacing[2],
              }}>
                {uploadStatusText || 'Preparing upload...'}
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleCancelUpload}
              disabled={uploadStage === 'writing'}
              style={{
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: spacing[3],
                borderRadius: radius.xl,
                backgroundColor: uploadStage === 'writing' ? colors.bg.raised : colors.bg.base,
                borderWidth: 1,
                borderColor: colors.bg.raised,
                opacity: uploadStage === 'writing' ? 0.7 : 1,
              }}
            >
              <Text style={{
                fontSize: 14,
                fontFamily: fonts.sans.medium,
                color: colors.fg.default,
              }}>
                {uploadStage === 'writing' ? 'Finishing Upload...' : 'Cancel'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>


      {/* Filters Modal */}
      <Modal
        visible={filtersModalVisible}
        transparent
        animationType="none"
        onRequestClose={() => setShowFiltersModal(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Animated.View
            style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' }, filtersBackdropStyle]}
            pointerEvents="box-none"
          >
            <Pressable style={{ flex: 1 }} onPress={() => setShowFiltersModal(false)} />
          </Animated.View>
          <Animated.View style={[{ marginHorizontal: spacing[4], marginBottom: spacing[4] }, filtersSheetStyle]}>
          <View style={{
            backgroundColor: colors.bg.raised,
            borderRadius: radius["2xl"],
            borderWidth: 0.5,
            borderColor: colors.border.default,
            overflow: 'hidden',
            paddingBottom: spacing[6],
            paddingHorizontal: spacing[4],
          }}>
            {/* Modal Header */}
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: spacing[4],
            }}>
              <Text style={{
                fontSize: 17,
                fontFamily: fonts.sans.semibold,
                color: colors.fg.default,
              }}>
                Sort & Filter
              </Text>
              <TouchableOpacity
                onPress={() => setShowFiltersModal(false)}
                style={{
                  width: 32,
                  height: 32,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: radius.full,
                  backgroundColor: colors.bg.base,
                  borderWidth: 0.5,
                  borderColor: colors.border.secondary,
                }}
              >
                <X size={18} color={colors.fg.muted} />
              </TouchableOpacity>
            </View>

            {/* Sort Options */}
            <View style={{ paddingVertical: spacing[4] }}>
              <Text style={{
                fontSize: 12,
                fontFamily: fonts.sans.semibold,
                color: colors.fg.muted,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: spacing[2],
              }}>
                Sort by
              </Text>
              <View style={{ gap: spacing[1] }}>
                {(['name', 'size', 'modified'] as SortOption[]).map(option => (
                  <TouchableOpacity
                    key={option}
                    onPress={() => setSortBy(option)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing[3],
                      paddingVertical: spacing[4],
                      paddingHorizontal: spacing[3],
                      borderRadius: radius.lg,
                      backgroundColor: sortBy === option ? colors.accent.default + '20' : 'transparent',
                    }}
                  >
                    <Circle
                      size={20}
                      color={sortBy === option ? colors.accent.default : colors.fg.muted}
                      fill={sortBy === option ? colors.accent.default : 'transparent'}
                    />
                    <Text style={{
                      fontSize: 15,
                      fontFamily: sortBy === option ? fonts.sans.semibold : fonts.sans.regular,
                      color: sortBy === option ? colors.accent.default : colors.fg.default,
                    }}>
                      {getSortLabel(option)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Filter Options */}
            <View style={{ paddingBottom: spacing[4] }}>
              <Text style={{
                fontSize: 12,
                fontFamily: fonts.sans.semibold,
                color: colors.fg.muted,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: spacing[2],
              }}>
                Show
              </Text>
              <View style={{ gap: spacing[1] }}>
                {(['all', 'files', 'folders'] as FilterOption[]).map(option => (
                  <TouchableOpacity
                    key={option}
                    onPress={() => setFilterBy(option)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing[3],
                      paddingVertical: spacing[4],
                      paddingHorizontal: spacing[3],
                      borderRadius: radius.lg,
                      backgroundColor: filterBy === option ? colors.accent.default + '20' : 'transparent',
                    }}
                  >
                    <Circle
                      size={20}
                      color={filterBy === option ? colors.accent.default : colors.fg.muted}
                      fill={filterBy === option ? colors.accent.default : 'transparent'}
                    />
                    <Text style={{
                      fontSize: 15,
                      fontFamily: filterBy === option ? fonts.sans.semibold : fonts.sans.regular,
                      color: filterBy === option ? colors.accent.default : colors.fg.default,
                    }}>
                      {getFilterLabel(option)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

          </View>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 4,
    gap: 10,
  },
});

export default memo(ExplorerPanel);
