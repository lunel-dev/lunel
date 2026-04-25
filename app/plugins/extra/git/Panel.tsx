import React, { useState, useCallback, useEffect, useRef, memo } from 'react';
import {
  Animated,
  Easing,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Modal,
  Alert,
  ActionSheetIOS,
  Keyboard,
  Platform,
} from 'react-native';
import {
  RefreshCw,
  GitBranch,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  GitCommit as GitCommitIcon,
  LoaderCircle,
  Plus,
  ArrowLeft,
  Check,
  Circle,
  ChevronRight,
  ChevronDown,
  Send,
  Minus,
  Undo,
  X,
  Trash2,
  File,
} from 'lucide-react-native';
import Header, { useHeaderHeight } from "@/components/Header";
import NotConnected from '@/components/NotConnected';
import Loading from '@/components/Loading';
import Toast from '@/components/Toast';
import { useTheme } from '@/contexts/ThemeContext';
import { typography } from '@/constants/themes';
import { useConnection } from '@/contexts/ConnectionContext';
import { useApi, GitStatus, GitCommit, GitCommitDetails, ApiError } from '@/hooks/useApi';
import { PluginPanelProps } from '../../types';
import InputModal from '@/components/InputModal';
import ActionSheet from '@/components/ActionSheet';

type Tab = 'changes' | 'history' | 'branches';

function SpinnerIcon({ size, color }: { size: number; color: string }) {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [rotation]);
  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  );
}

function getStatusMeta(status: string, colors: any): { color: string; label: string } {
  const map: Record<string, { color: string; label: string }> = {
    M: { color: colors.terminal.yellow, label: 'M' },
    A: { color: colors.terminal.green, label: 'A' },
    D: { color: colors.terminal.red, label: 'D' },
    R: { color: colors.terminal.blue, label: 'R' },
    C: { color: colors.terminal.magenta, label: 'C' },
    U: { color: colors.terminal.green, label: 'U' },
  };
  return map[status] ?? { color: colors.fg.subtle, label: status || '?' };
}

function timeAgo(date: number | string): string {
  const now = Date.now();
  const then = typeof date === 'number' ? date : new Date(date).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

// Colored diff viewer - parses raw diff text line by line
function DiffViewer({ diff, fonts, colors }: { diff: string; fonts: any; colors: any }) {
  if (!diff) {
    return (
      <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color: colors.fg.subtle, padding: 12 }}>
        No diff available
      </Text>
    );
  }

  const lines = diff.split('\n');

  return (
    <View style={{ paddingBottom: 8 }}>
      {lines.map((line, i) => {
        let bg = 'transparent';
        let color = colors.fg.default;
        let opacity = 1;

        if (line.startsWith('+') && !line.startsWith('+++')) {
          bg = colors.terminal.green + '18';
          color = colors.terminal.green;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          bg = colors.terminal.red + '18';
          color = colors.terminal.red;
        } else if (line.startsWith('@@')) {
          bg = colors.terminal.blue + '18';
          color = colors.terminal.blue;
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          color = colors.fg.muted;
          opacity = 0.7;
        } else {
          color = colors.fg.subtle;
          opacity = 0.8;
        }

        return (
          <View key={i} style={{ backgroundColor: bg, paddingHorizontal: 12, paddingVertical: 1 }}>
            <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color, opacity }} selectable>
              {line || ' '}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// Status badge — small colored letter pill
function StatusBadge({ status, fonts, colors }: { status: string; fonts: any; colors: any }) {
  const meta = getStatusMeta(status, colors);
  return (
    <View style={{
      width: 26,
      height: 26,
      borderRadius: 5,
      backgroundColor: meta.color + '22',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color: meta.color, lineHeight: 14 }}>
        {meta.label}
      </Text>
    </View>
  );
}

const GitFileIcon = memo(function GitFileIcon({
  filePath: _filePath,
  colors,
}: {
  filePath: string;
  colors: any;
}) {
  return <File size={15} color={colors.fg.muted} strokeWidth={2} />;
});

function GitPanel({ instanceId, isActive }: PluginPanelProps) {
  const { colors, fonts, spacing, radius } = useTheme();
  const headerHeight = useHeaderHeight();
  const { status: connStatus } = useConnection();
  const { git, fs } = useApi();
  const isConnected = connStatus === 'connected';

  const [activeTab, setActiveTab] = useState<Tab>('changes');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<{ current: string; branches: string[] } | null>(null);

  const [showCommitInputModal, setShowCommitInputModal] = useState(false);
  const [showBranchInputModal, setShowBranchInputModal] = useState(false);
  const [showPullActionSheet, setShowPullActionSheet] = useState(false);
  const [showCommitDetailsModal, setShowCommitDetailsModal] = useState(false);
  const [selectedCommitDetails, setSelectedCommitDetails] = useState<GitCommitDetails | null>(null);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [showFileDiffModal, setShowFileDiffModal] = useState(false);
  const [selectedChangeFile, setSelectedChangeFile] = useState<{ path: string; staged: boolean; status: string } | null>(null);
  const [selectedChangeDiff, setSelectedChangeDiff] = useState<string>('');
  const [selectedChangeContent, setSelectedChangeContent] = useState<string | null>(null);
  const [changeDiffLoading, setChangeDiffLoading] = useState(false);
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false);
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [stagingPaths, setStagingPaths] = useState<Set<string>>(new Set());
  const [discardingPaths, setDiscardingPaths] = useState<Set<string>>(new Set());
  const [stageAllLoading, setStageAllLoading] = useState(false);
  const [unstageAllLoading, setUnstageAllLoading] = useState(false);
  const [discardAllLoading, setDiscardAllLoading] = useState(false);

  const addStagingPaths = (paths: string[]) => setStagingPaths(prev => new Set([...prev, ...paths]));
  const removeStagingPaths = (paths: string[]) => setStagingPaths(prev => { const next = new Set(prev); paths.forEach(p => next.delete(p)); return next; });
  const addDiscardingPaths = (paths: string[]) => setDiscardingPaths(prev => new Set([...prev, ...paths]));
  const removeDiscardingPaths = (paths: string[]) => setDiscardingPaths(prev => { const next = new Set(prev); paths.forEach(p => next.delete(p)); return next; });
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });
  const [commitLimit, setCommitLimit] = useState(50);
  const commitLimitRef = useRef(50);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  const dismissGitInputs = useCallback(() => {
    TextInput.State.currentlyFocusedInput?.()?.blur?.();
    Keyboard.dismiss();
  }, []);

  const loadStatus = useCallback(async () => {
    if (!isConnected) return;
    try {
      const status = await git.status();
      setGitStatus(status);
      setError(null);
    } catch (err) {
      const apiError = err as ApiError;
      setError(apiError.code === 'ENOTGIT' ? 'Not a git repository' : (apiError.message || 'Failed to load status'));
    }
  }, [isConnected, git]);

  const loadCommits = useCallback(async (limit?: number) => {
    if (!isConnected) return;
    try {
      const log = await git.log(limit ?? commitLimitRef.current);
      setCommits(log);
    } catch { /* silent */ }
  }, [isConnected, git]);

  const handleLoadMore = useCallback(async () => {
    const nextLimit = commitLimitRef.current + 50;
    commitLimitRef.current = nextLimit;
    setCommitLimit(nextLimit);
    setLoadingMore(true);
    try {
      const log = await git.log(nextLimit);
      setCommits(log);
    } catch { /* silent */ }
    setLoadingMore(false);
  }, [git]);

  const loadBranches = useCallback(async () => {
    if (!isConnected) return;
    try {
      const data = await git.branches();
      setBranches(data);
    } catch { /* silent */ }
  }, [isConnected, git]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStatus(), loadCommits(), loadBranches()]);
    setLoading(false);
  }, [loadStatus, loadCommits, loadBranches]);

  useEffect(() => {
    if (isConnected && isActive) loadAll();
  }, [isConnected, isActive, loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const handleStage = async (paths: string[]) => {
    if (!gitStatus) return;
    addStagingPaths(paths);
    try {
      await git.stage(paths);
      await loadStatus();
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to stage');
    } finally {
      removeStagingPaths(paths);
    }
  };

  const handleUnstage = async (paths: string[]) => {
    if (!gitStatus) return;
    addStagingPaths(paths);
    try {
      await git.unstage(paths);
      await loadStatus();
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to unstage');
    } finally {
      removeStagingPaths(paths);
    }
  };

  const handleCommit = async (rawMessage: string) => {
    const message = rawMessage.trim();
    if (!message || actionLoading) return;
    dismissGitInputs();
    setActionLoading(true);
    try {
      await git.commit(message);
      showToast('Committed');
      await loadAll();
    } catch (err) {
      showToast((err as ApiError).message || 'Failed to commit', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const openCommitPrompt = useCallback(() => {
    dismissGitInputs();
    if (actionLoading) return;

    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        'Commit',
        'Enter commit message',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Commit', onPress: (value) => { void handleCommit(value ?? ''); } },
        ],
        'plain-text'
      );
      return;
    }

    setShowCommitInputModal(true);
  }, [dismissGitInputs, actionLoading, handleCommit]);

  const handlePull = async () => {
    setPullLoading(true);
    try {
      const result = await git.pull();
      showToast(result.summary || 'Up to date');
      await loadAll();
    } catch (err) {
      showToast((err as ApiError).message || 'Failed to pull', 'error');
    } finally {
      setPullLoading(false);
    }
  };

  const handlePush = async () => {
    dismissGitInputs();
    setPushLoading(true);
    try {
      await git.push();
      showToast('Pushed successfully');
      await loadStatus();
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.message?.includes('no upstream') || apiError.message?.includes('set-upstream')) {
        Alert.alert('No upstream branch', 'Push and set upstream?', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Push & Set Upstream',
            onPress: async () => {
              try { await git.push(true); showToast('Pushed successfully'); await loadStatus(); }
              catch (e) { showToast((e as ApiError).message || 'Failed to push', 'error'); }
            },
          },
        ]);
      } else {
        showToast(apiError.message || 'Failed to push', 'error');
      }
    } finally {
      setPushLoading(false);
    }
  };

  const handlePullWithStrategy = async (strategy: 'merge' | 'rebase' | 'ff-only') => {
    setPullLoading(true);
    try {
      const result = await git.pull(strategy);
      showToast(result.summary || 'Up to date');
      await loadAll();
    } catch (err) {
      showToast((err as ApiError).message || 'Failed to pull', 'error');
    } finally {
      setPullLoading(false);
    }
  };

  const handlePullLongPress = () => {
    if (Platform.OS === 'ios') {
      Alert.alert('Pull options', undefined, [
        { text: 'Pull', onPress: () => { void handlePull(); } },
        { text: 'Merge', onPress: () => { void handlePullWithStrategy('merge'); } },
        { text: 'Rebase', onPress: () => { void handlePullWithStrategy('rebase'); } },
        { text: 'Fast-forward only', onPress: () => { void handlePullWithStrategy('ff-only'); } },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      setShowPullActionSheet(true);
    }
  };

  const handlePushWithOptions = async (force?: 'force-with-lease' | 'force') => {
    dismissGitInputs();
    setPushLoading(true);
    try {
      await git.push(false, force);
      showToast('Pushed successfully');
      await loadStatus();
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.message?.includes('no upstream') || apiError.message?.includes('set-upstream')) {
        Alert.alert('No upstream branch', 'Push and set upstream?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Push & Set Upstream', onPress: async () => {
            try { await git.push(true); showToast('Pushed successfully'); await loadStatus(); }
            catch (e) { showToast((e as ApiError).message || 'Failed to push', 'error'); }
          }},
        ]);
      } else {
        showToast(apiError.message || 'Failed to push', 'error');
      }
    } finally {
      setPushLoading(false);
    }
  };

  const handlePushLongPress = () => {
    dismissGitInputs();
    const options = ['Cancel', 'Push', 'Force with lease', 'Force push'];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 0, destructiveButtonIndex: 3 },
        (i) => {
          if (i === 1) handlePushWithOptions();
          if (i === 2) handlePushWithOptions('force-with-lease');
          if (i === 3) handlePushWithOptions('force');
        }
      );
    } else {
      Alert.alert('Push options', undefined, [
        { text: 'Push', onPress: () => handlePushWithOptions() },
        { text: 'Force with lease', onPress: () => handlePushWithOptions('force-with-lease') },
        { text: 'Force push', style: 'destructive', onPress: () => handlePushWithOptions('force') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const handleCheckout = async (branch: string) => {
    try {
      setHistoryLoading(true);
      await git.checkout(branch);
      commitLimitRef.current = 50;
      setCommitLimit(50);
      await Promise.all([loadStatus(), loadCommits(50), loadBranches()]);
      setHistoryLoading(false);
    } catch (err) {
      setHistoryLoading(false);
      Alert.alert('Error', (err as ApiError).message || 'Failed to checkout');
    }
  };

  const handleDeleteBranch = async (branch: string) => {
    Alert.alert('Delete Branch', `Delete "${branch}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await git.deleteBranch(branch);
            await loadBranches();
          } catch (err) {
            Alert.alert('Error', (err as ApiError).message || 'Failed to delete branch');
          }
        }
      },
    ]);
  };

  const handleCreateBranch = async (rawBranchName: string) => {
    const branchName = rawBranchName.trim();
    if (!branchName || actionLoading) return;
    setActionLoading(true);
    try {
      await git.checkout(branchName, true);
      await loadAll();
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to create branch');
    } finally {
      setActionLoading(false);
    }
  };

  const openCreateBranchPrompt = useCallback(() => {
    dismissGitInputs();
    if (actionLoading) return;

    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        'New Branch',
        'Enter branch name',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create', onPress: (value) => { void handleCreateBranch(value ?? ''); } },
        ],
        'plain-text'
      );
      return;
    }

    setShowBranchInputModal(true);
  }, [dismissGitInputs, actionLoading, handleCreateBranch]);

  const handleOpenCommitDetails = async (hash: string) => {
    setCommitDetailsLoading(true);
    setLoadingCommitHash(hash);
    try {
      const details = await git.commitDetails(hash);
      setSelectedCommitDetails(details);
      setSelectedCommitFile(details.files[0]?.path || null);
      setShowCommitDetailsModal(true);
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to load commit');
    } finally {
      setCommitDetailsLoading(false);
      setLoadingCommitHash(null);
    }
  };

  const handleOpenFileDiff = useCallback(async (path: string, staged: boolean, status: string) => {
    setChangeDiffLoading(true);
    setSelectedChangeFile({ path, staged, status });
    setSelectedChangeDiff('');
    setSelectedChangeContent(null);
    setShowFileDiffModal(true);
    try {
      const diff = await git.diff(path, staged);
      setSelectedChangeDiff(diff);
      if (!staged && status === 'U' && !diff.trim()) {
        const file = await fs.read(path);
        if (file.encoding === 'utf8') {
          setSelectedChangeContent(file.content);
        }
      }
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to load diff');
      setShowFileDiffModal(false);
      setSelectedChangeFile(null);
    } finally {
      setChangeDiffLoading(false);
    }
  }, [fs, git]);

  const handleDiscard = async (paths?: string[]) => {
    Alert.alert(
      'Discard Changes?',
      paths
        ? `This will permanently discard all changes to ${paths.length === 1 ? `"${paths[0].split('/').pop()}"` : `${paths.length} files`}. This cannot be undone.`
        : 'This will permanently discard all unstaged changes. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            if (!gitStatus) return;
            if (paths) {
              addDiscardingPaths(paths);
            } else {
              setDiscardAllLoading(true);
            }
            try {
              await git.discard(paths);
              await loadStatus();
            } catch (err) {
              Alert.alert('Error', (err as ApiError).message || 'Failed to discard');
            } finally {
              if (paths) {
                removeDiscardingPaths(paths);
              } else {
                setDiscardAllLoading(false);
              }
            }
          },
        },
      ]
    );
  };

  const handleStageAll = async () => {
    if (!gitStatus) return;
    const paths = [...gitStatus.unstaged.map(f => f.path), ...gitStatus.untracked];
    if (paths.length === 0) return;
    setStageAllLoading(true);
    try {
      await git.stage(paths);
      await loadStatus();
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to stage');
    } finally {
      setStageAllLoading(false);
    }
  };

  const handleUnstageAll = async () => {
    if (!gitStatus) return;
    const paths = gitStatus.staged.map(f => f.path);
    if (paths.length === 0) return;
    setUnstageAllLoading(true);
    try {
      await git.unstage(paths);
      await loadStatus();
    } catch (err) {
      Alert.alert('Error', (err as ApiError).message || 'Failed to unstage');
    } finally {
      setUnstageAllLoading(false);
    }
  };

  const totalChanges = gitStatus
    ? gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length
    : 0;

  // ── Not connected ──────────────────────────────────────────────
  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Header title="Git" colors={colors} />
        <NotConnected colors={colors} fonts={fonts} />
      </View>
    );
  }

  // ── Styles ─────────────────────────────────────────────────────
  const pad = spacing[3];
  const sectionHeaderStyle = {
    fontSize: typography.caption,
    fontFamily: fonts.sans.semibold,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  };
  const sectionCountBadgeStyle = {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 6,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: colors.bg.raised,
  };
  const sectionCountTextStyle = {
    fontSize: 12,
    fontFamily: fonts.sans.medium,
    color: colors.fg.default,
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <Header
        title="Git"
        colors={colors}
        showBottomBorder={!loading}
        rightAccessory={
          <TouchableOpacity onPress={onRefresh} style={{ padding: 6 }}>
            <RefreshCw size={20} color={colors.fg.muted} strokeWidth={2} />
          </TouchableOpacity>
        }
      />

      {!loading && (
        <View style={{
          flexDirection: 'row',
          paddingHorizontal: pad,
          marginBottom: 0,
          borderBottomWidth: 0.5,
          borderBottomColor: colors.border.secondary,
        }}>
          {([
            { key: 'changes', label: 'Changes' },
            { key: 'history', label: 'History' },
            { key: 'branches', label: 'Branches' },
          ] as { key: Tab; label: string }[]).map((tab) => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={{
                  paddingHorizontal: spacing[2],
                  paddingTop: spacing[3],
                  paddingBottom: spacing[3],
                  marginRight: spacing[1],
                  borderBottomWidth: 2,
                  borderBottomColor: active ? colors.fg.muted : 'transparent',
                  marginBottom: -0.5,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{
                    fontSize: typography.body,
                    fontFamily: fonts.sans.regular,
                    color: active ? colors.fg.default : colors.fg.muted,
                  }}>
                    {tab.label}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Loading color={colors.fg.muted} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          <View style={{ alignItems: 'center', gap: 8 }}>
            <GitBranch size={48} color={colors.fg.muted} strokeWidth={1.5} />
            <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
              {error}
            </Text>
          </View>
        </View>
      ) : activeTab === 'changes' ? (
        <View style={{ flex: 1 }}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, padding: pad, paddingTop: 0, paddingBottom: 0 }}
            keyboardDismissMode="on-drag"
          >
            {/* Staged section */}
            {gitStatus && gitStatus.staged.length > 0 && (
              <View style={{ marginBottom: spacing[2] }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing[2], marginBottom: spacing[3], marginHorizontal: spacing[1] }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[sectionHeaderStyle, { color: colors.fg.default, fontSize: 13 }]}>
                      Staged
                    </Text>
                    <View style={sectionCountBadgeStyle}>
                      <Text style={sectionCountTextStyle}>{gitStatus.staged.length}</Text>
                    </View>
                  </View>
                  <TouchableOpacity onPress={handleUnstageAll} disabled={unstageAllLoading} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.bg.raised }}>
                    {unstageAllLoading ? <SpinnerIcon size={14} color={colors.fg.subtle} /> : <Minus size={14} color={colors.fg.default} strokeWidth={2} />}
                    <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.default }}>Unstage all</Text>
                  </TouchableOpacity>
                </View>

                <View style={{ gap: spacing[1] }}>
                  {gitStatus.staged.map((file) => {
                    const parts = file.path.split('/');
                    const name = parts.pop()!;
                    const dir = parts.join('/');
                    return (
                      <View
                        key={file.path}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing[2],
                        }}
                      >
                        <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                          <GitFileIcon filePath={file.path} colors={colors} />
                        </View>
                        <TouchableOpacity
                          onPress={() => { void handleOpenFileDiff(file.path, true, file.status); }}
                          activeOpacity={0.7}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <ScrollView
                            horizontal
                            directionalLockEnabled
                            showsHorizontalScrollIndicator={false}
                            style={{ minWidth: 0 }}
                            contentContainerStyle={{ alignItems: 'center', gap: 6, paddingRight: 6 }}
                          >
                            <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.default }}>{name}</Text>
                            {dir.length > 0 && <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>{dir}</Text>}
                          </ScrollView>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleUnstage([file.path])}
                          disabled={stagingPaths.has(file.path)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ width: 26, height: 26, borderRadius: 5, backgroundColor: colors.bg.raised, alignItems: 'center', justifyContent: 'center' }}
                        >
                          {stagingPaths.has(file.path) ? <SpinnerIcon size={12} color={colors.fg.subtle} /> : <Minus size={12} color={colors.fg.default} strokeWidth={2.5} />}
                        </TouchableOpacity>
                        <StatusBadge status={file.status} fonts={fonts} colors={colors} />
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Unstaged / Untracked section */}
            {gitStatus && (gitStatus.unstaged.length > 0 || gitStatus.untracked.length > 0) && (
              <View style={{ marginBottom: spacing[3] }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing[2], marginBottom: spacing[3], marginHorizontal: spacing[1] }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[sectionHeaderStyle, { color: colors.fg.default, fontSize: 13, fontFamily: fonts.sans.medium }]}>
                      Changes
                    </Text>
                    <View style={sectionCountBadgeStyle}>
                      <Text style={sectionCountTextStyle}>{gitStatus.unstaged.length + gitStatus.untracked.length}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                    <TouchableOpacity onPress={() => handleDiscard()} disabled={discardAllLoading} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.git.deleted + '18' }}>
                      {discardAllLoading ? <SpinnerIcon size={14} color={colors.git.deleted} /> : <Undo size={14} color={colors.git.deleted} strokeWidth={2} />}
                      <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.git.deleted }}>Discard all</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleStageAll} disabled={stageAllLoading} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.bg.raised }}>
                      {stageAllLoading ? <SpinnerIcon size={14} color={colors.fg.subtle} /> : <Plus size={14} color={colors.fg.subtle} strokeWidth={2} />}
                      <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.default }}>Stage all</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={{ gap: spacing[1] }}>
                  {gitStatus.unstaged.map((file) => {
                    const parts = file.path.split('/');
                    const name = parts.pop()!;
                    const dir = parts.join('/');
                    return (
                      <View
                        key={file.path}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing[2],
                        }}
                      >
                        <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                          <GitFileIcon filePath={file.path} colors={colors} />
                        </View>
                        <TouchableOpacity
                          onPress={() => { void handleOpenFileDiff(file.path, false, file.status); }}
                          activeOpacity={0.7}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <ScrollView
                            horizontal
                            directionalLockEnabled
                            showsHorizontalScrollIndicator={false}
                            style={{ minWidth: 0 }}
                            contentContainerStyle={{ alignItems: 'center', gap: 6, paddingRight: 6 }}
                          >
                            <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.default }}>{name}</Text>
                            {dir.length > 0 && <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>{dir}</Text>}
                          </ScrollView>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleDiscard([file.path])}
                          disabled={discardingPaths.has(file.path)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ width: 26, height: 26, borderRadius: 5, backgroundColor: colors.git.deleted + '18', alignItems: 'center', justifyContent: 'center', marginRight: 1 }}
                        >
                          {discardingPaths.has(file.path) ? <SpinnerIcon size={11} color={colors.git.deleted} /> : <Undo size={11} color={colors.git.deleted} strokeWidth={2} />}
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleStage([file.path])}
                          disabled={stagingPaths.has(file.path)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ width: 26, height: 26, borderRadius: 5, backgroundColor: colors.bg.raised, alignItems: 'center', justifyContent: 'center' }}
                        >
                          {stagingPaths.has(file.path) ? <SpinnerIcon size={12} color={colors.fg.subtle} /> : <Plus size={12} color={colors.fg.default} strokeWidth={2.5} />}
                        </TouchableOpacity>
                        <StatusBadge status={file.status} fonts={fonts} colors={colors} />
                      </View>
                    );
                  })}
                  {gitStatus.untracked.map((path) => {
                    const parts = path.split('/');
                    const name = parts.pop()!;
                    const dir = parts.join('/');
                    return (
                      <View
                        key={path}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing[2],
                        }}
                      >
                        <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                          <GitFileIcon filePath={path} colors={colors} />
                        </View>
                        <TouchableOpacity
                          onPress={() => { void handleOpenFileDiff(path, false, 'U'); }}
                          activeOpacity={0.7}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <ScrollView
                            horizontal
                            directionalLockEnabled
                            showsHorizontalScrollIndicator={false}
                            style={{ minWidth: 0 }}
                            contentContainerStyle={{ alignItems: 'center', gap: 6, paddingRight: 6 }}
                          >
                            <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>{name}</Text>
                            {dir.length > 0 && <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>{dir}</Text>}
                          </ScrollView>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleDiscard([path])}
                          disabled={discardingPaths.has(path)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ width: 26, height: 26, borderRadius: 5, backgroundColor: colors.git.deleted + '18', alignItems: 'center', justifyContent: 'center', marginRight: 1 }}
                        >
                          {discardingPaths.has(path) ? <SpinnerIcon size={11} color={colors.git.deleted} /> : <Undo size={11} color={colors.git.deleted} strokeWidth={2} />}
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleStage([path])}
                          disabled={stagingPaths.has(path) || discardingPaths.has(path)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ width: 26, height: 26, borderRadius: 5, backgroundColor: colors.bg.raised, alignItems: 'center', justifyContent: 'center' }}
                        >
                          {stagingPaths.has(path) ? <SpinnerIcon size={12} color={colors.fg.subtle} /> : <Plus size={12} color={colors.fg.default} strokeWidth={2.5} />}
                        </TouchableOpacity>
                        <StatusBadge status="U" fonts={fonts} colors={colors} />
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Clean state */}
            {gitStatus && totalChanges === 0 && (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
                <View style={{ alignItems: 'center', gap: 8 }}>
                  <CheckCircle2 size={48} color={colors.fg.muted} strokeWidth={1.5} />
                  <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                    Working tree clean
                  </Text>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      ) : activeTab === 'history' ? (
        historyLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Loading color={colors.fg.muted} />
          </View>
        ) :
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: spacing[6] }}
        >
          {commits.length === 0 ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <GitCommitIcon size={48} color={colors.fg.muted} strokeWidth={1.5} />
                <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                  No commits yet
                </Text>
              </View>
            </View>
          ) : (
            <>
            {commits.map((commit, i) => {
              const isHead = i === 0;
              return (
                <TouchableOpacity
                  key={commit.hash}
                  onPress={() => handleOpenCommitDetails(commit.hash)}
                  activeOpacity={0.6}
                  style={{ flexDirection: 'row', minHeight: 48, paddingRight: spacing[3] }}
                >
                  {/* Graph column */}
                  <View style={{ width: 44, alignItems: 'center' }}>
                    {/* Line above dot */}
                    {i > 0 && (
                      <View style={{
                        position: 'absolute',
                        top: 0,
                        height: 22,
                        width: 2,
                        backgroundColor: colors.fg.muted + '40',
                      }} />
                    )}
                    {/* Commit dot */}
                    <View style={{
                      width: 13,
                      height: 13,
                      borderRadius: 7,
                      backgroundColor: isHead ? colors.git.added : colors.bg.base,
                      borderWidth: 2,
                      borderColor: isHead ? colors.git.added : colors.fg.muted,
                      marginTop: 17,
                      zIndex: 1,
                    }} />
                    {/* Line below dot */}
                    {(i < commits.length - 1 || commits.length >= commitLimit) && (
                      <View style={{
                        position: 'absolute',
                        top: 30,
                        bottom: 0,
                        width: 2,
                        backgroundColor: colors.fg.muted + '40',
                      }} />
                    )}
                  </View>

                  {/* Commit content */}
                  <View style={{ flex: 1, paddingTop: 8, paddingBottom: 8, justifyContent: 'center' }}>
                    {/* Subject line with HEAD badge + time */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      {isHead && (
                        <View style={{
                          paddingHorizontal: 5,
                          paddingVertical: 2,
                          borderRadius: 4,
                          backgroundColor: colors.git.added + '22',
                          flexShrink: 0,
                        }}>
                          <Text style={{
                            fontSize: typography.caption,
                            fontFamily: fonts.sans.semibold,
                            color: colors.git.added,
                            letterSpacing: 0.6,
                          }}>
                            HEAD
                          </Text>
                        </View>
                      )}
                      <Text
                        style={{
                          flex: 1,
                          fontSize: typography.body,
                          fontFamily: fonts.sans.medium,
                          color: colors.fg.default,
                          lineHeight: 20,
                        }}
                        numberOfLines={1}
                      >
                        {commit.message}
                        <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>
                          {' · '}{timeAgo(commit.date)}
                        </Text>
                      </Text>
                    </View>

                    {/* Meta row: hash badge · author */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{
                        paddingHorizontal: 5,
                        paddingVertical: 2,
                        borderRadius: 4,
                        backgroundColor: colors.git.info + '20',
                        flexShrink: 0,
                      }}>
                        <Text style={{
                          fontSize: typography.caption,
                          fontFamily: fonts.mono.regular,
                          color: colors.git.info,
                        }}>
                          {commit.hash.substring(0, 7)}
                        </Text>
                      </View>
                      <Text
                        style={{ flex: 1, fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}
                        numberOfLines={1}
                      >
                        {commit.author}
                      </Text>
                    </View>
                  </View>

                  {/* Right arrow centered */}
                  <View style={{ justifyContent: 'center', paddingRight: spacing[1] }}>
                    <ChevronRight size={18} color={colors.fg.subtle} strokeWidth={2} />
                  </View>
                </TouchableOpacity>
              );
            })}
            {commits.length >= commitLimit && (
              <TouchableOpacity
                onPress={handleLoadMore}
                disabled={loadingMore}
                activeOpacity={0.5}
                style={{ alignItems: 'center', paddingVertical: spacing[4] }}
              >
                {loadingMore ? (
                  <SpinnerIcon size={16} color={colors.fg.subtle} />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>
                      Load more
                    </Text>
                    <ChevronDown size={12} color={colors.fg.subtle} strokeWidth={2} />
                  </View>
                )}
              </TouchableOpacity>
            )}
            </>
          )}
        </ScrollView>
      ) : activeTab === 'branches' && branches ? (
        branches.branches.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <GitBranch size={48} color={colors.fg.muted} strokeWidth={1.5} />
              <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                No branches found
              </Text>
            </View>
          </View>
        ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: pad, paddingTop: spacing[2] }}
          keyboardShouldPersistTaps="always"
        >
          {branches.branches.map((branch, index) => {
            const isCurrent = branch === branches.current;
            const isLast = index === branches.branches.length - 1;
            return (
              <TouchableOpacity
                key={branch}
                onPress={() => !isCurrent && handleCheckout(branch)}
                disabled={isCurrent || actionLoading}
                activeOpacity={0.6}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: spacing[1],
                  paddingVertical: spacing[2],
                  borderRadius: 10,
                  gap: spacing[2],
                  backgroundColor: 'transparent',
                  borderBottomWidth: isLast ? 0 : 0.5,
                  borderBottomColor: colors.border.secondary,
                }}
              >
                <GitBranch size={14} color={isCurrent ? colors.git.added : colors.fg.subtle} strokeWidth={2} />
                <Text
                  style={{
                    flex: 1,
                    fontSize: typography.body,
                    fontFamily: fonts.sans.regular,
                    color: isCurrent ? colors.git.added : colors.fg.default,
                  }}
                  numberOfLines={1}
                >
                  {branch}
                </Text>
                {isCurrent && (
                  <View style={{ paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}>
                    <Circle size={8} color={colors.git.added} fill={colors.git.added} strokeWidth={2} />
                  </View>
                )}
                {!isCurrent && (
                  <TouchableOpacity
                    onPress={() => handleDeleteBranch(branch)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.6}
                  >
                    <Trash2 size={15} color={colors.git.deleted} strokeWidth={2} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        )
      ) : null}

      {/* ── Branch & Sync Bar ──────────────────────────────────── */}
      {!loading && gitStatus && (
        <View style={{
          borderTopWidth: 0.5,
          borderTopColor: colors.border.secondary,
          marginTop: 'auto',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[3], paddingVertical: 6, gap: spacing[2] }}>
              <TouchableOpacity onPress={() => setActiveTab('branches')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <GitBranch size={13} color={colors.git.added} strokeWidth={2} />
                <Text style={{ fontSize: 13, fontFamily: fonts.mono.regular, color: colors.fg.default }} numberOfLines={1}>{gitStatus.branch}</Text>
                {gitStatus.ahead > 0 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1, marginLeft: 2 }}>
                    <ArrowUp size={10} color={colors.git.added} strokeWidth={2.5} />
                    <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color: colors.git.added }}>{gitStatus.ahead}</Text>
                  </View>
                )}
                {gitStatus.behind > 0 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
                    <ArrowDown size={10} color={colors.git.modified} strokeWidth={2.5} />
                    <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color: colors.git.modified }}>{gitStatus.behind}</Text>
                  </View>
                )}
              </TouchableOpacity>

              <View style={{ flex: 1 }} />

              {activeTab === 'branches' ? (
                <TouchableOpacity
                  onPress={openCreateBranchPrompt}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 10, height: 32, borderRadius: 8, backgroundColor: colors.bg.raised }}
                >
                  <Plus size={13} color={colors.fg.default} strokeWidth={2} />
                  <Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: colors.fg.default }}>New Branch</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity onPress={handlePullLongPress} disabled={pullLoading || pushLoading} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, width: 72, height: 32, borderRadius: 8, backgroundColor: colors.bg.raised }}>
                    {pullLoading ? <SpinnerIcon size={13} color={colors.fg.subtle} /> : <><ArrowDown size={13} color={colors.fg.default} strokeWidth={2} /><Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Pull</Text></>}
                  </TouchableOpacity>
                  {gitStatus.staged.length > 0 ? (
                    <TouchableOpacity onPress={openCommitPrompt} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 14, height: 32, borderRadius: 8, backgroundColor: colors.bg.raised }}>
                      <GitCommitIcon size={13} color={colors.fg.default} strokeWidth={2} />
                      <Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Commit</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={handlePushLongPress} disabled={pushLoading || gitStatus.ahead === 0} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, width: 72, height: 32, borderRadius: 8, backgroundColor: colors.bg.raised, opacity: gitStatus.ahead === 0 ? 0.4 : 1 }}>
                      {pushLoading ? <SpinnerIcon size={13} color={colors.fg.subtle} /> : <><ArrowUp size={13} color={gitStatus.ahead > 0 ? colors.fg.default : colors.fg.muted} strokeWidth={2} /><Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: gitStatus.ahead > 0 ? colors.fg.default : colors.fg.muted }}>Push</Text></>}
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
        </View>
      )}

      {/* ── Commit Details Modal ───────────────────────────────── */}
      <Modal
        visible={showCommitDetailsModal}
        transparent={false}
        animationType="slide"
        onRequestClose={() => setShowCommitDetailsModal(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
          <Header
            title={selectedCommitDetails?.commit.hash?.substring(0, 7) ?? 'Commit'}
            onBack={() => setShowCommitDetailsModal(false)}
            colors={colors}
          />

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing[3], paddingBottom: spacing[6] }}>
            {/* Commit meta */}
            {selectedCommitDetails && (
              <View style={{ marginBottom: spacing[4], gap: spacing[3] }}>
                {/* Subject */}
                <Text style={{ fontSize: typography.heading, fontFamily: fonts.sans.semibold, color: colors.fg.default, lineHeight: 24 }}>
                  {selectedCommitDetails.commit.message}
                </Text>

                {/* Author row */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.medium, color: colors.fg.default }}>
                      {selectedCommitDetails.commit.author}
                    </Text>
                    <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle, marginTop: 1 }}>
                      {new Date(selectedCommitDetails.commit.date).toLocaleString(undefined, {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>

                {/* Hash row */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.git.info + '18' }}>
                    <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.git.info }}>
                      {selectedCommitDetails.commit.fullHash ?? selectedCommitDetails.commit.hash}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* File list */}
            {selectedCommitDetails && selectedCommitDetails.files.length > 0 && (
              <View style={{
                borderRadius: 12,
                borderWidth: 0.5,
                borderColor: colors.border.secondary,
                backgroundColor: colors.bg.raised,
                overflow: 'hidden',
                marginBottom: spacing[3],
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[3], paddingTop: spacing[3], paddingBottom: spacing[2] }}>
                  <Text style={[sectionHeaderStyle, { color: colors.fg.subtle }]}>
                    Files changed
                  </Text>
                  <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.bg.base }}>
                    <Text style={{ fontSize: 10, fontFamily: fonts.sans.semibold, color: colors.fg.subtle }}>
                      {selectedCommitDetails.files.length}
                    </Text>
                  </View>
                </View>
                {selectedCommitDetails.files.map((file, idx) => {
                  const isSelected = selectedCommitFile === file.path;
                  const parts = file.path.split('/');
                  const name = parts.pop()!;
                  const dir = parts.join('/');
                  return (
                    <TouchableOpacity
                      key={`${file.path}-${idx}`}
                      onPress={() => setSelectedCommitFile(file.path)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: spacing[2],
                        paddingHorizontal: spacing[3],
                        paddingVertical: 9,
                        borderTopWidth: 0.5,
                        borderTopColor: colors.border.secondary,
                        backgroundColor: isSelected ? colors.git.info + '12' : 'transparent',
                      }}
                    >
                      <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                        <GitFileIcon filePath={file.path} colors={colors} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text
                          style={{ fontSize: 12, fontFamily: fonts.mono.regular, color: isSelected ? colors.git.info : colors.fg.default, flexShrink: 1 }}
                          numberOfLines={1}
                        >
                          {name}
                        </Text>
                        {dir.length > 0 && (
                          <Text
                            numberOfLines={1}
                            style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle, flexShrink: 2 }}
                          >
                            {dir}
                          </Text>
                        )}
                        <StatusBadge status={file.status} fonts={fonts} colors={colors} />
                      </View>
                      {isSelected && <Check size={12} color={colors.git.info} strokeWidth={2.5} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Diff viewer */}
            {selectedCommitDetails && (
              <View style={{
                borderRadius: 12,
                borderWidth: 0.5,
                borderColor: colors.border.secondary,
                backgroundColor: colors.bg.raised,
                overflow: 'hidden',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[3], paddingTop: spacing[3], paddingBottom: spacing[2] }}>
                  <Text style={[sectionHeaderStyle, { color: colors.fg.subtle }]}>
                    Diff
                  </Text>
                  {selectedCommitFile && (
                    <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.fg.subtle }} numberOfLines={1}>
                      {selectedCommitFile.split('/').pop()}
                    </Text>
                  )}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ minWidth: '100%' }}>
                    <DiffViewer
                      diff={
                        selectedCommitFile
                          ? (selectedCommitDetails.fileDiffs?.[selectedCommitFile] || selectedCommitDetails.diff)
                          : selectedCommitDetails.diff
                      }
                      fonts={fonts}
                      colors={colors}
                    />
                  </View>
                </ScrollView>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showFileDiffModal}
        transparent={false}
        animationType="slide"
        onRequestClose={() => setShowFileDiffModal(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
          <Header
            title={selectedChangeFile?.path.split('/').pop() ?? 'Diff'}
            onBack={() => setShowFileDiffModal(false)}
            colors={colors}
          />

          {changeDiffLoading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Loading color={colors.fg.muted} />
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing[3], paddingBottom: spacing[6] }}>
              {selectedChangeFile && (
                <View style={{ marginBottom: spacing[3], gap: spacing[3] }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                    <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                      <GitFileIcon filePath={selectedChangeFile.path} colors={colors} />
                    </View>
                    <Text style={{ flex: 1, fontSize: typography.body, fontFamily: fonts.mono.regular, color: colors.fg.default }}>
                      {selectedChangeFile.path}
                    </Text>
                    <StatusBadge status={selectedChangeFile.status} fonts={fonts} colors={colors} />
                  </View>
                  <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>
                    {selectedChangeFile.staged ? 'Staged changes' : 'Working tree changes'}
                  </Text>
                </View>
              )}

              <View style={{
                borderRadius: 12,
                borderWidth: 0.5,
                borderColor: colors.border.secondary,
                backgroundColor: colors.bg.raised,
                overflow: 'hidden',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[3], paddingTop: spacing[3], paddingBottom: spacing[2] }}>
                  <Text style={[sectionHeaderStyle, { color: colors.fg.subtle }]}>
                    {selectedChangeContent != null ? 'File' : 'Diff'}
                  </Text>
                </View>
                {selectedChangeContent != null ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ minWidth: '100%' }}>
                      <Text
                        style={{
                          fontSize: typography.caption,
                          fontFamily: fonts.mono.regular,
                          color: colors.fg.default,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          lineHeight: 18,
                        }}
                        selectable
                      >
                        {selectedChangeContent}
                      </Text>
                    </View>
                  </ScrollView>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ minWidth: '100%' }}>
                      <DiffViewer diff={selectedChangeDiff} fonts={fonts} colors={colors} />
                    </View>
                  </ScrollView>
                )}
              </View>
            </ScrollView>
          )}
        </View>
      </Modal>

      <InputModal
        visible={showCommitInputModal}
        title="Commit"
        description="Enter commit message"
        acceptLabel="Commit"
        cancelLabel="Cancel"
        onCancel={() => setShowCommitInputModal(false)}
        onAccept={(value) => { setShowCommitInputModal(false); void handleCommit(value); }}
      />

      <InputModal
        visible={showBranchInputModal}
        title="New Branch"
        description="Enter branch name"
        acceptLabel="Create"
        cancelLabel="Cancel"
        onCancel={() => setShowBranchInputModal(false)}
        onAccept={(value) => { setShowBranchInputModal(false); void handleCreateBranch(value); }}
      />

      <ActionSheet
        visible={showPullActionSheet}
        onClose={() => setShowPullActionSheet(false)}
        title="Pull options"
        options={[
          { label: 'Pull', onPress: () => { void handlePull(); } },
          { label: 'Merge', onPress: () => { void handlePullWithStrategy('merge'); } },
          { label: 'Rebase', onPress: () => { void handlePullWithStrategy('rebase'); } },
          { label: 'Fast-forward only', onPress: () => { void handlePullWithStrategy('ff-only'); } },
        ]}
      />

      <Toast
        visible={!!toast}
        message={toast?.message ?? ''}
        type={toast?.type}
        onHide={() => setToast(null)}
      />
      {commitDetailsLoading && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: 'rgba(0,0,0,0.28)',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing[6],
          }}
        >
          <View
            style={{
              width: '88%',
              maxWidth: 330,
              alignItems: 'center',
              gap: spacing[3],
              paddingHorizontal: spacing[5],
              paddingVertical: spacing[5],
              borderRadius: 15,
              backgroundColor: colors.bg.raised,
            }}
          >
            <SpinnerIcon size={22} color={colors.fg.default} />
            <Text style={{ fontSize: 16, fontFamily: fonts.sans.semibold, color: colors.fg.default, textAlign: 'center' }}>
              Loading commit
            </Text>
            <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.muted, textAlign: 'center' }}>
              {`Fetching diff for ${loadingCommitHash?.substring(0, 7) ?? 'this commit'}...`}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

export default memo(GitPanel);
