import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import InfoSheet from '@/components/InfoSheet';
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Modal,
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
  ArrowLeftRight,
  ListTree,
  Search,
  Settings2,
  CaseSensitive,
  ChevronRight,
  FileText,
  FileCode2,
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
import { useApi, FileEntry, ApiError, GrepMatch } from '@/hooks/useApi';
import { gPI, innerApi } from '@/plugins';
import { usePlugins } from '@/plugins/context';
import { PluginPanelProps } from '../../types';
import { resolveMaterialIconUri } from './materialIconTheme';

type SortOption = 'name' | 'size' | 'modified';
type FilterOption = 'all' | 'files' | 'folders';
type SearchMode = 'files' | 'codebase';
type ExplorerListItem = FileEntry & { __navParent?: boolean };
interface GroupedMatch {
  file: string;
  matches: GrepMatch[];
}
interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}
type CodeTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation';
interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

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

function groupMatchesByFile(matches: GrepMatch[]): GroupedMatch[] {
  const groups: GroupedMatch[] = [];
  for (const match of matches) {
    const existing = groups[groups.length - 1];
    if (existing && existing.file === match.file) {
      existing.matches.push(match);
      continue;
    }
    groups.push({ file: match.file, matches: [match] });
  }
  return groups;
}

function getHighlightedParts(content: string, query: string, caseSensitive: boolean) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [{ text: content, highlighted: false }];

  const source = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? trimmedQuery : trimmedQuery.toLowerCase();
  const parts: { text: string; highlighted: boolean }[] = [];
  let startIndex = 0;

  while (startIndex < content.length) {
    const matchIndex = source.indexOf(needle, startIndex);
    if (matchIndex === -1) {
      parts.push({ text: content.slice(startIndex), highlighted: false });
      break;
    }

    if (matchIndex > startIndex) {
      parts.push({ text: content.slice(startIndex, matchIndex), highlighted: false });
    }

    parts.push({
      text: content.slice(matchIndex, matchIndex + trimmedQuery.length),
      highlighted: true,
    });
    startIndex = matchIndex + trimmedQuery.length;
  }

  return parts;
}

function tokenizeCodeLine(content: string, filePath: string): CodeToken[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const hashCommentLangs = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'env']);
  const keywordPattern = '\\b(?:const|let|var|function|return|if|else|for|while|do|import|from|export|default|class|new|try|catch|finally|throw|await|async|interface|type|extends|implements|public|private|protected|static|switch|case|break|continue|null|undefined|true|false|def|lambda|pass|in|and|or|not|while|with|as|yield|enum|package|namespace|using|void|int|string|boolean|number|any|unknown)\\b';
  const numberPattern = '\\b\\d+(?:\\.\\d+)?\\b';
  const stringPattern = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`';
  const functionPattern = '\\b[A-Za-z_][A-Za-z0-9_]*\\s*(?=\\()';
  const typePattern = '\\b[A-Z][A-Za-z0-9_]*\\b';
  const operatorPattern = '(?:===|!==|==|!=|<=|>=|=>|\\+\\+|--|&&|\\|\\||[+\\-*/%=&|!<>?:])';
  const punctuationPattern = '[(){}\\[\\].,;]';
  const commentPattern = hashCommentLangs.has(ext) ? '#.*$' : '//.*$|/\\*.*\\*/';
  const tokenRegex = new RegExp(
    `(${commentPattern}|${stringPattern}|${functionPattern}|${typePattern}|${keywordPattern}|${numberPattern}|${operatorPattern}|${punctuationPattern})`,
    'gi'
  );

  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(content)) !== null) {
    const matchText = match[0];
    const start = match.index;
    if (start > lastIndex) {
      tokens.push({ text: content.slice(lastIndex, start), kind: 'plain' });
    }

    let kind: CodeTokenKind = 'plain';
    if (/^(\/\/|\/\*|#)/.test(matchText)) kind = 'comment';
    else if (/^['"`]/.test(matchText)) kind = 'string';
    else if (/^[`'"]/.test(matchText)) kind = 'string';
    else if (/^\d/.test(matchText)) kind = 'number';
    else if (/^[A-Za-z_][A-Za-z0-9_]*\s*$/.test(matchText) && /\($/.test(content.slice(start + matchText.length).trimStart())) kind = 'function';
    else if (/^[A-Z][A-Za-z0-9_]*$/.test(matchText)) kind = 'type';
    else if (/^(===|!==|==|!=|<=|>=|=>|\+\+|--|&&|\|\||[+\-*/%=&|!<>?:])$/.test(matchText)) kind = 'operator';
    else if (/^[(){}\[\].,;]$/.test(matchText)) kind = 'punctuation';
    else kind = 'keyword';

    tokens.push({ text: matchText, kind });
    lastIndex = start + matchText.length;
  }

  if (lastIndex < content.length) {
    tokens.push({ text: content.slice(lastIndex), kind: 'plain' });
  }

  return tokens.length > 0 ? tokens : [{ text: content, kind: 'plain' }];
}

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

const SearchResultFileIcon = memo(function SearchResultFileIcon({
  filePath,
  fallbackColor,
  size = 14,
}: {
  filePath: string;
  fallbackColor: string;
  size?: number;
}) {
  const [iconLoadFailed, setIconLoadFailed] = useState(false);
  const fileName = useMemo(() => filePath.split('/').pop() || filePath, [filePath]);
  const iconUri = useMemo(
    () => resolveMaterialIconUri({ name: fileName, type: 'file' }),
    [fileName]
  );

  useEffect(() => {
    setIconLoadFailed(false);
  }, [iconUri]);

  if (!iconUri || iconLoadFailed) {
    return <FileCode2 size={size} color={fallbackColor} strokeWidth={1.9} />;
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
  const { colors, fonts, spacing, radius, isDark } = useTheme();
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
  const [searchMode, setSearchMode] = useState<SearchMode>('files');
  const [includeChildReposInFileSearch, setIncludeChildReposInFileSearch] = useState(false);
  const [repoFileSearchResults, setRepoFileSearchResults] = useState<FileSearchResult[]>([]);
  const [repoFileSearchLoading, setRepoFileSearchLoading] = useState(false);
  const [repoFileSearchError, setRepoFileSearchError] = useState<string | null>(null);
  const [hasTreeFileSearchRun, setHasTreeFileSearchRun] = useState(false);
  const [codebaseResults, setCodebaseResults] = useState<GrepMatch[]>([]);
  const [codebaseSearchLoading, setCodebaseSearchLoading] = useState(false);
  const [codebaseSearchError, setCodebaseSearchError] = useState<string | null>(null);
  const [hasCodebaseSearched, setHasCodebaseSearched] = useState(false);
  const [codebaseCaseSensitive, setCodebaseCaseSensitive] = useState(false);
  const [codebasePath, setCodebasePath] = useState('.');
  const [showCodebaseOptions, setShowCodebaseOptions] = useState(false);
  const [collapsedCodebaseFiles, setCollapsedCodebaseFiles] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [filterBy, setFilterBy] = useState<FilterOption>('all');
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [selectedItem, setSelectedItem] = useState<FileEntry | null>(null);
  const [selectedItemIsBinary, setSelectedItemIsBinary] = useState<boolean | null>(null);
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [uploadStage, setUploadStage] = useState<'idle' | 'preparing' | 'writing'>('idle');
  const uploadPickerInFlightRef = useRef(false);
  const uploadCancelRequestedRef = useRef(false);
  const listRef = useRef<FlashList<ExplorerListItem> | null>(null);
  const codebaseRequestIdRef = useRef(0);
  const repoFileSearchRequestIdRef = useRef(0);
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

  const runCodebaseSearch = useCallback(async (opts?: { caseSensitive?: boolean }) => {
    if (!isConnected || searchMode !== 'codebase') return;

    const query = searchQuery.trim();
    const grepPath = codebasePath.trim() || '.';
    const caseSensitive = opts?.caseSensitive ?? codebaseCaseSensitive;
    if (!query) {
      setCodebaseResults([]);
      setCodebaseSearchError(null);
      setCodebaseSearchLoading(false);
      setHasCodebaseSearched(false);
      return;
    }

    const requestId = ++codebaseRequestIdRef.current;
    setCodebaseSearchLoading(true);
    setCodebaseSearchError(null);
    setHasCodebaseSearched(true);

    try {
      const matches = await fs.grep(query, grepPath, {
        caseSensitive,
        maxResults: 300,
      });
      if (requestId !== codebaseRequestIdRef.current) return;
      setCodebaseResults(matches);
    } catch (err) {
      if (requestId !== codebaseRequestIdRef.current) return;
      const apiError = err as ApiError;
      setCodebaseResults([]);
      setCodebaseSearchError(apiError.message || 'Codebase search failed');
    } finally {
      if (requestId === codebaseRequestIdRef.current) {
        setCodebaseSearchLoading(false);
      }
    }
  }, [codebaseCaseSensitive, codebasePath, fs, isConnected, searchMode, searchQuery]);

  const runRepoFileSearch = useCallback(async (opts?: { forceTreeMode?: boolean }) => {
    if (!isConnected || searchMode !== 'files') return;

    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      setRepoFileSearchResults([]);
      setRepoFileSearchError(null);
      setRepoFileSearchLoading(false);
      setHasTreeFileSearchRun(false);
      return;
    }

    const includeChildren = opts?.forceTreeMode ?? includeChildReposInFileSearch;
    if (includeChildren) {
      setHasTreeFileSearchRun(true);
    }

    const requestId = ++repoFileSearchRequestIdRef.current;
    setRepoFileSearchLoading(true);
    setRepoFileSearchError(null);

    try {
      const maxResults = 400;
      const maxDirectories = includeChildren ? 600 : 250;
      const maxDurationMs = includeChildren ? 10000 : 5000;
      const startedAt = Date.now();

      const matches: FileSearchResult[] = [];
      const visited = new Set<string>(['.']);
      const queue: string[] = ['.'];
      let scannedDirectories = 0;

      while (queue.length > 0) {
        if (requestId !== repoFileSearchRequestIdRef.current) return;
        if (matches.length >= maxResults || scannedDirectories >= maxDirectories) break;
        if (Date.now() - startedAt > maxDurationMs) break;

        const dir = queue.shift()!;
        scannedDirectories += 1;

        let entries: FileEntry[];
        try {
          entries = await fs.list(dir);
        } catch {
          continue;
        }

        const hasGitDir = entries.some((entry) => entry.type === 'directory' && entry.name === '.git');
        if (hasGitDir && dir !== '.' && !includeChildren) {
          continue;
        }

        for (const entry of entries) {
          if (entry.name === '.git') continue;
          if (!showHiddenFiles && entry.name.startsWith('.')) continue;

          const relPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
          const matchesQuery =
            entry.name.toLowerCase().includes(query)
            || relPath.toLowerCase().includes(query);

          const passesFilter = filterBy === 'all'
            || (filterBy === 'files' && entry.type === 'file')
            || (filterBy === 'folders' && entry.type === 'directory');

          if (matchesQuery && passesFilter) {
            matches.push({
              path: relPath,
              name: entry.name,
              type: entry.type,
            });
            if (matches.length >= maxResults) break;
          }

          if (entry.type === 'directory' && !visited.has(relPath)) {
            visited.add(relPath);
            queue.push(relPath);
          }
        }
      }

      if (requestId !== repoFileSearchRequestIdRef.current) return;
      matches.sort((a, b) => a.path.localeCompare(b.path));
      setRepoFileSearchResults(matches);
    } catch (err) {
      if (requestId !== repoFileSearchRequestIdRef.current) return;
      const apiError = err as ApiError;
      setRepoFileSearchResults([]);
      setRepoFileSearchError(apiError.message || 'File search failed');
    } finally {
      if (requestId === repoFileSearchRequestIdRef.current) {
        setRepoFileSearchLoading(false);
      }
    }
  }, [
    filterBy,
    fs,
    includeChildReposInFileSearch,
    isConnected,
    searchMode,
    searchQuery,
    showHiddenFiles,
  ]);

  useEffect(() => {
    if (!showSearch || searchMode !== 'files' || !isConnected) {
      setRepoFileSearchLoading(false);
      setRepoFileSearchError(null);
      return;
    }

    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      setRepoFileSearchResults([]);
      setRepoFileSearchLoading(false);
      setRepoFileSearchError(null);
      setHasTreeFileSearchRun(false);
      return;
    }

    if (includeChildReposInFileSearch) {
      setRepoFileSearchLoading(false);
      setRepoFileSearchError(null);
      return;
    }

    const timeout = setTimeout(() => {
      void runRepoFileSearch({ forceTreeMode: false });
    }, 160);

    return () => {
      clearTimeout(timeout);
    };
  }, [
    includeChildReposInFileSearch,
    isConnected,
    runRepoFileSearch,
    searchMode,
    searchQuery,
    showSearch,
  ]);

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

  const toggleCodebaseFileCollapse = useCallback((file: string) => {
    setCollapsedCodebaseFiles((prev) => ({
      ...prev,
      [file]: !prev[file],
    }));
  }, []);

  const openFileSearchResult = useCallback(async (result: FileSearchResult) => {
    if (result.type === 'directory') {
      setCurrentPath(result.path);
      return;
    }

    try {
      openTab('editor');
      await gPI.editor.openFile(result.path);
    } catch (err) {
      const apiError = err as ApiError;
      Alert.alert('Error', apiError.message || 'Failed to open file in editor');
    }
  }, [openTab]);

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
  const syntaxPalette = useMemo(() => {
    if (isDark) {
      return {
        plain: colors.fg.muted,
        keyword: '#c792ea',
        string: '#c3e88d',
        number: '#f78c6c',
        comment: '#7f848e',
        function: '#82aaff',
        type: '#ffcb6b',
        operator: '#89ddff',
        punctuation: '#bfc7d5',
      };
    }
    return {
      plain: colors.fg.muted,
      keyword: '#7c3aed',
      string: '#15803d',
      number: '#c2410c',
      comment: '#6b7280',
      function: '#1d4ed8',
      type: '#b45309',
      operator: '#0f766e',
      punctuation: '#4b5563',
    };
  }, [colors.fg.muted, isDark]);
  const groupedCodebaseMatches = useMemo(() => groupMatchesByFile(codebaseResults), [codebaseResults]);
  const codebaseFileCount = useMemo(() => new Set(codebaseResults.map((match) => match.file)).size, [codebaseResults]);
  const codebaseMatchCountText = useMemo(() => String(codebaseResults.length), [codebaseResults.length]);
  const codebaseMatchLabel = useMemo(
    () => `${codebaseResults.length} match${codebaseResults.length === 1 ? '' : 'es'}`,
    [codebaseResults.length]
  );
  const codebaseResultSummary = useMemo(() => {
    if (codebaseSearchLoading) return `Searching in ${codebasePath.trim() || '.'}`;
    const fileLabel = `${codebaseFileCount} file${codebaseFileCount === 1 ? '' : 's'}`;
    return `${codebaseMatchLabel} across ${fileLabel} in ${codebasePath.trim() || '.'}`;
  }, [codebaseFileCount, codebaseMatchLabel, codebasePath, codebaseSearchLoading]);
  const searchStateContainerStyle = {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[18],
  };
  const searchStateTextStyle = {
    marginTop: spacing[3],
    fontSize: 13,
    fontFamily: fonts.sans.regular,
    color: colors.fg.muted,
    textAlign: 'center' as const,
  };

  useEffect(() => {
    setCollapsedCodebaseFiles({});
  }, [codebaseResults]);
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
            <View style={{
              flex: 1,
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
                placeholder={searchMode === 'codebase' ? 'search in codebase...' : 'search files...'}
                placeholderTextColor={colors.fg.subtle}
                value={searchQuery}
                onChangeText={(value) => {
                  setSearchQuery(value);
                  if (searchMode === 'codebase') {
                    setHasCodebaseSearched(false);
                    setCodebaseSearchError(null);
                  } else if (searchMode === 'files' && includeChildReposInFileSearch) {
                    setHasTreeFileSearchRun(false);
                    setRepoFileSearchError(null);
                  }
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={(searchMode === 'codebase' || (searchMode === 'files' && includeChildReposInFileSearch)) ? 'search' : 'done'}
                onSubmitEditing={() => {
                  if (searchMode === 'codebase') {
                    void runCodebaseSearch();
                  } else if (searchMode === 'files' && includeChildReposInFileSearch) {
                    void runRepoFileSearch({ forceTreeMode: true });
                  }
                }}
              />
            </View>
            {searchMode === 'files' ? (
              <TouchableOpacity
                onPress={() => {
                  setIncludeChildReposInFileSearch((prev) => {
                    const next = !prev;
                    if (!next) {
                      setHasTreeFileSearchRun(false);
                    }
                    setRepoFileSearchError(null);
                    return next;
                  });
                }}
                activeOpacity={0.7}
                style={{
                  height: 40,
                  width: 40,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: includeChildReposInFileSearch ? colors.accent.default : colors.bg.raised,
                }}
              >
                <ListTree
                  size={18}
                  color={includeChildReposInFileSearch ? '#ffffff' : colors.fg.default}
                  strokeWidth={2}
                />
              </TouchableOpacity>
            ) : null}
            {searchMode === 'codebase' ? (
              <TouchableOpacity
                onPress={() => setShowCodebaseOptions((prev) => !prev)}
                activeOpacity={0.7}
                style={{
                  height: 40,
                  width: 40,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: showCodebaseOptions ? colors.accent.default : colors.bg.raised,
                }}
              >
                <Settings2
                  size={16}
                  color={showCodebaseOptions ? '#ffffff' : colors.fg.default}
                  strokeWidth={2}
                />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={() => setSearchMode((prev) => {
                const next = prev === 'files' ? 'codebase' : 'files';
                setSearchQuery('');
                setHasCodebaseSearched(false);
                setCodebaseResults([]);
                setCodebaseSearchError(null);
                setRepoFileSearchResults([]);
                setRepoFileSearchError(null);
                setRepoFileSearchLoading(false);
                setHasTreeFileSearchRun(false);
                if (next !== 'codebase') {
                  setShowCodebaseOptions(false);
                }
                return next;
              })}
              activeOpacity={0.7}
              style={{
                width: 40,
                height: 40,
                borderRadius: radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.bg.raised,
              }}
            >
              <ArrowLeftRight size={16} color={colors.fg.default} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          {searchMode === 'codebase' && showCodebaseOptions ? (
            <View style={{ marginTop: spacing[2], flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
              <View style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colors.bg.raised,
                borderRadius: radius.md,
                height: 40,
                paddingHorizontal: spacing[3],
                gap: spacing[2],
              }}>
                <Text style={{
                  fontSize: typography.caption,
                  fontFamily: fonts.sans.medium,
                  color: colors.fg.muted,
                }}>
                  Path
                </Text>
                <TextInput
                  style={{
                    flex: 1,
                    fontSize: typography.body,
                    fontFamily: fonts.sans.regular,
                    color: colors.fg.default,
                    outline: 'none',
                  } as any}
                  value={codebasePath}
                  onChangeText={(value) => {
                    setCodebasePath(value);
                    setHasCodebaseSearched(false);
                    setCodebaseSearchError(null);
                  }}
                  placeholder="."
                  placeholderTextColor={colors.fg.subtle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={() => { void runCodebaseSearch(); }}
                />
              </View>
              <TouchableOpacity
                onPress={() => {
                  const nextCaseSensitive = !codebaseCaseSensitive;
                  setCodebaseCaseSensitive(nextCaseSensitive);
                  setCodebaseSearchError(null);
                  if (searchQuery.trim()) {
                    void runCodebaseSearch({ caseSensitive: nextCaseSensitive });
                  } else {
                    setHasCodebaseSearched(false);
                    setCodebaseResults([]);
                  }
                }}
                activeOpacity={0.7}
                style={{
                  height: 40,
                  width: 40,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: codebaseCaseSensitive ? colors.accent.default : colors.bg.raised,
                }}
              >
                <CaseSensitive
                  size={18}
                  color={codebaseCaseSensitive ? '#ffffff' : colors.fg.default}
                  strokeWidth={2}
                />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}

      {/* File List with Action Buttons as header */}
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
          {searchMode === 'codebase' && showSearch ? (
            <View style={{ flex: 1 }}>
              {!searchQuery.trim() ? (
                <View style={searchStateContainerStyle}>
                  <Search size={28} color={colors.fg.subtle} />
                  <Text style={searchStateTextStyle}>
                    Type to search across the entire codebase
                  </Text>
                </View>
              ) : !hasCodebaseSearched ? (
                <View style={searchStateContainerStyle}>
                  <Search size={28} color={colors.fg.subtle} />
                  <Text style={searchStateTextStyle}>
                    Press search on keyboard to run codebase search
                  </Text>
                </View>
              ) : codebaseSearchLoading ? (
                <View style={{ flex: 1 }}>
                  <Loading />
                </View>
              ) : codebaseSearchError ? (
                <View style={searchStateContainerStyle}>
                  <AlertCircle size={28} color={'#ef4444'} />
                  <Text style={[searchStateTextStyle, { color: '#ef4444' }]}>
                    {codebaseSearchError}
                  </Text>
                </View>
              ) : codebaseResults.length === 0 ? (
                <View
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: spacing[4],
                    paddingVertical: spacing[8],
                    paddingBottom: spacing[18],
                    gap: spacing[3],
                  }}
                >
                  <FileCode2 size={36} color={colors.fg.subtle} strokeWidth={1.8} />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 14 }}>
                      No matches for
                    </Text>
                    <Text style={{ color: colors.fg.default, fontFamily: fonts.mono.medium, fontSize: 14 }}>
                      {searchQuery.trim()}
                    </Text>
                  </View>
                  <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: typography.caption }}>
                    Try a broader path or change the casing filter.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  contentContainerStyle={{ paddingTop: spacing[1], paddingBottom: spacing[6] }}
                  keyboardShouldPersistTaps="handled"
                >
                  <View style={[styles.summaryRow, { paddingHorizontal: spacing[3], marginTop: spacing[1] }]}>
                    <Text style={{ flex: 1, color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 13 }}>
                      <Text style={{ color: '#22c55e', fontFamily: fonts.sans.medium }}>
                        {codebaseMatchCountText}
                      </Text>
                      <Text>
                        {codebaseResultSummary.slice(codebaseMatchCountText.length)}
                      </Text>
                    </Text>
                    <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: 13 }}>
                      Tap a hit to open the file
                    </Text>
                  </View>
                  {groupedCodebaseMatches.map((group) => (
                    <View
                      key={group.file}
                      style={{
                        paddingHorizontal: spacing[3],
                        paddingVertical: spacing[1],
                        gap: 6,
                      }}
                    >
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => toggleCodebaseFileCollapse(group.file)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing[1],
                          borderRadius: radius.sm,
                          marginHorizontal: -spacing[1],
                          paddingHorizontal: spacing[1],
                          paddingVertical: 6,
                          backgroundColor: collapsedCodebaseFiles[group.file] ? colors.bg.raised : 'transparent',
                        }}
                      >
                        <ChevronRight
                          size={17}
                          color={colors.fg.subtle}
                          strokeWidth={2}
                          style={{ transform: [{ rotate: collapsedCodebaseFiles[group.file] ? '0deg' : '90deg' }] }}
                        />
                        <SearchResultFileIcon filePath={group.file} fallbackColor={colors.fg.muted} size={14} />
                        <Text
                          style={{
                            flex: 1,
                            fontSize: typography.body,
                            fontFamily: fonts.sans.medium,
                            color: colors.fg.default,
                          }}
                          numberOfLines={1}
                        >
                          {group.file}
                        </Text>
                      </TouchableOpacity>

                      {!collapsedCodebaseFiles[group.file] ? (
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                          <View style={{ width: 40 }}>
                            {group.matches.map((match, index) => (
                              <Text
                                key={`${match.file}:${match.line}:${index}:line`}
                                style={{
                                  color: colors.fg.subtle,
                                  fontFamily: fonts.mono.regular,
                                  fontSize: 12,
                                  lineHeight: 18,
                                }}
                                numberOfLines={1}
                              >
                                {match.line}
                              </Text>
                            ))}
                          </View>
                          <ScrollView
                            horizontal
                            style={{ flex: 1 }}
                            contentContainerStyle={{ paddingRight: spacing[2] }}
                            showsHorizontalScrollIndicator={false}
                            nestedScrollEnabled
                          >
                            <View>
                              {group.matches.map((match, index) => {
                                const lineTokens = tokenizeCodeLine(match.content, match.file);
                                return (
                                  <Text
                                    key={`${match.file}:${match.line}:${index}:code`}
                                    style={{
                                      fontFamily: fonts.mono.regular,
                                      fontSize: typography.caption,
                                      lineHeight: 18,
                                    }}
                                    numberOfLines={1}
                                  >
                                    {lineTokens.map((token, tokenIndex) => {
                                      const highlightedParts = getHighlightedParts(token.text, searchQuery, codebaseCaseSensitive);
                                      const baseColor = syntaxPalette[token.kind];
                                      return highlightedParts.map((part, partIndex) => (
                                        <Text
                                          key={`${match.file}:${match.line}:${tokenIndex}:${partIndex}`}
                                          style={part.highlighted
                                            ? {
                                              color: colors.fg.default,
                                              backgroundColor: colors.accent.default + '33',
                                              fontFamily: fonts.mono.bold,
                                            }
                                            : {
                                              color: baseColor,
                                              fontFamily: fonts.mono.regular,
                                            }}
                                        >
                                          {part.text}
                                        </Text>
                                      ));
                                    })}
                                  </Text>
                                );
                              })}
                            </View>
                          </ScrollView>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          ) : searchMode === 'files' && showSearch && !!searchQuery.trim() ? (
            <View style={{ flex: 1 }}>
              {includeChildReposInFileSearch && !hasTreeFileSearchRun ? (
                <View style={searchStateContainerStyle}>
                  <ListTree size={28} color={colors.fg.subtle} />
                  <Text style={searchStateTextStyle}>
                    Press search on keyboard to run tree search
                  </Text>
                </View>
              ) : repoFileSearchLoading ? (
                <Loading />
              ) : repoFileSearchError ? (
                <View style={searchStateContainerStyle}>
                  <AlertCircle size={28} color={'#ef4444'} />
                  <Text style={[searchStateTextStyle, { color: '#ef4444' }]}>
                    {repoFileSearchError}
                  </Text>
                </View>
              ) : repoFileSearchResults.length === 0 ? (
                <View style={searchStateContainerStyle}>
                  <Search size={28} color={colors.fg.subtle} />
                  <Text style={searchStateTextStyle}>
                    No matching files {includeChildReposInFileSearch ? 'in current + child repos' : 'in current repo'}
                  </Text>
                </View>
              ) : (
                <FlashList
                  data={repoFileSearchResults}
                  estimatedItemSize={56}
                  contentContainerStyle={{ paddingTop: spacing[2], paddingBottom: spacing[6] }}
                  keyExtractor={(item) => item.path}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => { void openFileSearchResult(item); }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: spacing[3],
                        paddingVertical: spacing[2],
                        gap: spacing[2],
                      }}
                    >
                      <SearchResultFileIcon filePath={item.path} fallbackColor={colors.fg.muted} size={15} />
                      <View style={{ flex: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            fontSize: typography.body,
                            fontFamily: fonts.sans.regular,
                            color: colors.fg.default,
                          }}
                        >
                          {item.path}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}
            </View>
          ) : (
            <>
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
            </>
          )}
      </View>

      <InfoSheet
        visible={selectedItem !== null}
        onClose={closeModal}
        title={selectedItem?.name ?? ''}
        description={selectedItemPath}
        icon={selectedItem ? <EntryIcon item={selectedItem} colors={colors} size={26} /> : undefined}
      >
        <ScrollView
          contentContainerStyle={{ gap: spacing[2], paddingBottom: spacing[1] }}
          keyboardDismissMode="on-drag"
        >
          <View style={{ flexDirection: 'row', gap: spacing[3] }}>
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

          <View style={{ gap: spacing[2], marginTop: spacing[2] }}>
            {selectedItemIsBinary !== true ? (
              <TouchableOpacity
                style={[styles.sheetRow, { borderRadius: 10, backgroundColor: colors.accent.default, marginBottom: 0 }]}
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
                style={[styles.sheetRow, { borderRadius: 10, backgroundColor: colors.accent.default, marginBottom: 0 }]}
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

            <View style={{ borderRadius: 10, overflow: 'hidden', backgroundColor: colors.bg.raised }}>
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


      {/* Filters Sheet */}
      <InfoSheet
        visible={showFiltersModal}
        onClose={() => setShowFiltersModal(false)}
        title="Sort & Filter"
        description="Adjust how files are sorted and shown"
      >
        <ScrollView contentContainerStyle={{ gap: spacing[4], paddingBottom: spacing[2] }}>
          <View>
            <Text style={{
              fontSize: typography.caption,
              fontFamily: fonts.sans.semibold,
              color: 'rgba(255,255,255,0.4)',
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
                    paddingVertical: spacing[3],
                    paddingHorizontal: spacing[3],
                    borderRadius: radius.lg,
                    backgroundColor: sortBy === option ? colors.bg.raised : 'transparent',
                  }}
                >
                  <Circle
                    size={18}
                    color={sortBy === option ? colors.fg.default : 'rgba(255,255,255,0.3)'}
                    fill={sortBy === option ? colors.fg.default : 'transparent'}
                  />
                  <Text style={{
                    fontSize: typography.body,
                    fontFamily: sortBy === option ? fonts.sans.semibold : fonts.sans.regular,
                    color: sortBy === option ? colors.fg.default : '#ffffff',
                  }}>
                    {getSortLabel(option)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View>
            <Text style={{
              fontSize: typography.caption,
              fontFamily: fonts.sans.semibold,
              color: 'rgba(255,255,255,0.4)',
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
                    paddingVertical: spacing[3],
                    paddingHorizontal: spacing[3],
                    borderRadius: radius.lg,
                    backgroundColor: filterBy === option ? colors.bg.raised : 'transparent',
                  }}
                >
                  <Circle
                    size={18}
                    color={filterBy === option ? colors.fg.default : 'rgba(255,255,255,0.3)'}
                    fill={filterBy === option ? colors.fg.default : 'transparent'}
                  />
                  <Text style={{
                    fontSize: typography.body,
                    fontFamily: filterBy === option ? fonts.sans.semibold : fonts.sans.regular,
                    color: filterBy === option ? colors.fg.default : '#ffffff',
                  }}>
                    {getFilterLabel(option)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </ScrollView>
      </InfoSheet>

    </View>
  );
}

const styles = StyleSheet.create({
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 2,
    gap: 10,
  },
  summaryRow: {
    minHeight: 24,
    paddingTop: 8,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 0,
  },
});

export default memo(ExplorerPanel);
