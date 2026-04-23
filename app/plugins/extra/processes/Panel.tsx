import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  Alert,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {
  X,
  Search,
  Plus,
  RefreshCw,
  AlertTriangle,
  Terminal,
  ChevronRight,
  Trash,
  RouteOff,
} from 'lucide-react-native';
import Header, { useHeaderHeight } from "@/components/Header";
import NotConnected from '@/components/NotConnected';
import Loading from '@/components/Loading';
import { useTheme } from '@/contexts/ThemeContext';
import { PluginPanelProps } from '../../types';
import { useApi, ProcessInfo, ApiError } from '@/hooks/useApi';


function ProcessesPanel({ instanceId, isActive }: PluginPanelProps) {
  const { colors, fonts, spacing, radius, typography } = useTheme();
  const { width } = useWindowDimensions();
  const isIPad = Platform.OS === 'ios' && Platform.isPad || width >= 768;
  const headerHeight = useHeaderHeight();
  const { processes: processApi, isConnected } = useApi();

  const [processList, setProcessList] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedProcess, setSelectedProcess] = useState<ProcessInfo | null>(null);
  const [processOutput, setProcessOutput] = useState<string>('');
  const [outputLoading, setOutputLoading] = useState(false);

  // Spawn form state
  const [showSpawnForm, setShowSpawnForm] = useState(false);
  const [spawnCommand, setSpawnCommand] = useState('');
  const [spawnArgs, setSpawnArgs] = useState('');
  const [spawnPath, setSpawnPath] = useState('');
  const [spawning, setSpawning] = useState(false);


  // Load processes
  const loadProcesses = useCallback(async () => {
    if (!isConnected) {
      setLoading(false);
      return;
    }

    try {
      setError(null);
      const result = await processApi.list();
      setProcessList(result);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load processes';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isConnected, processApi]);

  // Load on mount and when active
  useEffect(() => {
    if (isActive && isConnected) {
      loadProcesses();
    }
  }, [isActive, isConnected, loadProcesses]);

  // Auto-refresh every 5 seconds when active
  useEffect(() => {
    if (!isActive || !isConnected) return;
    const interval = setInterval(loadProcesses, 5000);
    return () => clearInterval(interval);
  }, [isActive, isConnected, loadProcesses]);

  // Load output when process selected
  useEffect(() => {
    if (selectedProcess) {
      setOutputLoading(true);
      processApi.getOutput(selectedProcess.channel)
        .then(output => setProcessOutput(output))
        .catch(() => setProcessOutput(''))
        .finally(() => setOutputLoading(false));
    } else {
      setProcessOutput('');
    }
  }, [selectedProcess]);

  const killProcess = async (pid: number) => {
    setProcessList(prev => prev.filter(p => p.pid !== pid));
    setSelectedProcess(null);
    try {
      await processApi.kill(pid);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to kill process';
      setError(message);
      await loadProcesses();
    }
  };

  const spawnProcess = async () => {
    if (!spawnCommand.trim()) return;

    setSpawning(true);
    try {
      const args = spawnArgs.trim() ? spawnArgs.split(' ') : undefined;
      await processApi.spawn(spawnCommand.trim(), args, {
        cwd: spawnPath.trim() || undefined,
      });
      setShowSpawnForm(false);
      setSpawnCommand('');
      setSpawnArgs('');
      setSpawnPath('');
      await loadProcesses();
    } catch (err) {
      const raw = err instanceof ApiError ? err.message : String(err);
      const isNotFound = /not found|no such|ENOENT|cannot find|command not/i.test(raw);
      setError(isNotFound
        ? `"${spawnCommand.trim()}" not found — check the command and try again.`
        : `Couldn't start "${spawnCommand.trim()}".`
      );
    } finally {
      setSpawning(false);
    }
  };

  const clearOutput = async () => {
    if (!selectedProcess) return;
    try {
      await processApi.clearOutput(selectedProcess.channel);
      setProcessOutput('');
    } catch {
      // Ignore errors
    }
  };

  const refreshOutput = async () => {
    if (!selectedProcess) return;
    setOutputLoading(true);
    try {
      const output = await processApi.getOutput(selectedProcess.channel);
      setProcessOutput(output);
    } catch {
      // Ignore errors
    } finally {
      setOutputLoading(false);
    }
  };

  const getStatusColor = (status: ProcessInfo['status']) => {
    switch (status) {
      case 'running': return '#22c55e';
      case 'stopped': return '#ef4444';
      default: return colors.fg.muted;
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  const formatDuration = (startTime: number) => {
    const elapsed = Date.now() - startTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const filteredProcesses = filter
    ? processList.filter(p =>
        p.command.toLowerCase().includes(filter.toLowerCase()) ||
        p.pid.toString().includes(filter)
      )
    : processList;

  // Not connected view
  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Header title="Processes" colors={colors} />
        <NotConnected colors={colors} fonts={fonts} />
      </View>
    );
  }

  if (selectedProcess) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Header
          title={selectedProcess.command.length > 18 ? selectedProcess.command.slice(0, 18) + '…' : selectedProcess.command}
          colors={colors}
          onBack={() => setSelectedProcess(null)}
          rightAccessory={
            selectedProcess.status === 'running' ? (
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    'Kill Process',
                    `Are you sure you want to kill "${selectedProcess.command}" (PID ${selectedProcess.pid})?`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Kill', style: 'destructive', onPress: () => killProcess(selectedProcess.pid) },
                    ]
                  );
                }}
                style={{ padding: 8 }}
              >
                <RouteOff size={18} color={colors.fg.muted} strokeWidth={2} />
              </TouchableOpacity>
            ) : undefined
          }
          rightAccessoryWidth={45}
        />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing[4], paddingTop: spacing[3], gap: spacing[3] }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginBottom: spacing[1] }}>
            <View style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: getStatusColor(selectedProcess.status),
            }} />
            <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.semibold, color: getStatusColor(selectedProcess.status) }}>
              {selectedProcess.status.charAt(0).toUpperCase() + selectedProcess.status.slice(1)}
            </Text>
            <Text style={{ fontSize: typography.caption, fontFamily: fonts.mono.regular, color: colors.fg.subtle }}>
              · PID {selectedProcess.pid}
            </Text>
          </View>

          <View>
            {/* Command */}
            <View style={{ paddingVertical: spacing[1], paddingHorizontal: spacing[2] }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: colors.fg.subtle, marginBottom: spacing[1] }}>COMMAND</Text>
              <Text style={{ fontSize: typography.body, fontFamily: fonts.mono.regular, color: colors.fg.default }}>{selectedProcess.command}</Text>
            </View>


            {/* Started */}
            <View style={{ paddingVertical: spacing[1], paddingHorizontal: spacing[2] }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: colors.fg.subtle, marginBottom: spacing[1] }}>STARTED</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.default }}>{formatTime(selectedProcess.startTime)}</Text>
                <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>· {formatDuration(selectedProcess.startTime)} ago</Text>
              </View>
            </View>

            {/* Working dir */}
            {selectedProcess.cwd && (
              <>
                    <View style={{ paddingVertical: spacing[1], paddingHorizontal: spacing[2] }}>
                  <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: colors.fg.subtle, marginBottom: spacing[1] }}>WORKING DIR</Text>
                  <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>{selectedProcess.cwd}</Text>
                </View>
              </>
            )}
          </View>

          <View style={{ marginTop: spacing[3], backgroundColor: colors.bg.raised, borderRadius: 10, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[4], paddingVertical: spacing[3], borderBottomWidth: 0.5, borderBottomColor: colors.border.secondary }}>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.medium, color: colors.fg.muted }}>OUTPUT</Text>
              <View style={{ flexDirection: 'row', gap: spacing[3] }}>
                <TouchableOpacity onPress={refreshOutput}>
                  <RefreshCw size={15} color={colors.fg.muted} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity onPress={clearOutput}>
                  <Trash size={15} color={'#ef4444'} strokeWidth={2} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={{ padding: spacing[4], minHeight: 120, justifyContent: 'center' }}>
              {outputLoading ? (
                <ActivityIndicator size="small" color={colors.fg.muted} />
              ) : processOutput ? (
                <Text style={{ fontSize: 12, fontFamily: fonts.mono.regular, color: colors.fg.default }}>{processOutput}</Text>
              ) : (
                <Text style={{ fontSize: typography.body, fontFamily: fonts.sans.regular, color: colors.fg.subtle, fontStyle: 'italic' }}>No output</Text>
              )}
            </View>
          </View>

          <View style={{ height: spacing[8] }} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, position: 'relative' }}>
      <Header
        title="Processes"
        colors={colors}
        rightAccessory={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => { setShowSearch(v => !v); if (!showSearch) { setShowSpawnForm(false); setSpawnCommand(''); setSpawnArgs(''); setSpawnPath(''); } }} style={{ padding: 8 }}>
              {showSearch ? (
                <X size={20} color={colors.fg.muted} />
              ) : (
                <Search size={20} color={colors.fg.muted} />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowSpawnForm(v => !v); if (!showSpawnForm) { setShowSearch(false); } setSpawnCommand(''); setSpawnArgs(''); setSpawnPath(''); }} style={{ padding: 8 }}>
              <Plus size={22} color={colors.fg.muted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setLoading(true); loadProcesses(); }} style={{ padding: 8 }}>
              <RefreshCw size={20} color={colors.fg.muted} />
            </TouchableOpacity>
          </View>
        }
        rightAccessoryWidth={130}
      />

      {/* Search Bar */}
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
                fontSize: 14,
                fontFamily: fonts.sans.regular,
                color: colors.fg.default,
                outline: 'none',
              } as any}
              value={filter}
              onChangeText={setFilter}
              placeholder="filter by command or PID..."
              placeholderTextColor={colors.fg.subtle}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
      )}

      {/* Spawn Form */}
      {showSpawnForm && (
        <View style={{
          paddingHorizontal: spacing[3],
          paddingTop: spacing[3],
          paddingBottom: spacing[3],
          borderBottomWidth: 0.5,
          borderBottomColor: colors.border.secondary,
        }}>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.bg.raised,
            borderRadius: radius.md,
            minHeight: 40,
            paddingHorizontal: spacing[3],
            gap: spacing[2],
            marginBottom: spacing[2],
          }}>
            <Terminal size={14} color={colors.fg.muted} strokeWidth={2} />
            <TextInput
              style={{
                flex: 1,
                fontSize: 14,
                fontFamily: fonts.sans.regular,
                color: colors.fg.default,
                paddingVertical: Platform.OS === 'android' ? 8 : 0,
              } as any}
              value={spawnCommand}
              onChangeText={setSpawnCommand}
              placeholder="command... (e.g. node, npm, python)"
              placeholderTextColor={colors.fg.subtle}
              autoFocus
              returnKeyType="next"
            />
          </View>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.bg.raised,
            borderRadius: radius.md,
            minHeight: 40,
            paddingHorizontal: spacing[3],
            marginBottom: spacing[2],
          }}>
            <TextInput
              style={{
                flex: 1,
                fontSize: 14,
                fontFamily: fonts.sans.regular,
                color: colors.fg.default,
                paddingVertical: Platform.OS === 'android' ? 8 : 0,
              } as any}
              value={spawnPath}
              onChangeText={setSpawnPath}
              placeholder="path... (optional absolute path, default current dir)"
              placeholderTextColor={colors.fg.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.bg.raised,
            borderRadius: radius.md,
            minHeight: 40,
            paddingHorizontal: spacing[3],
            marginBottom: spacing[2],
          }}>
            <TextInput
              style={{
                flex: 1,
                fontSize: 14,
                fontFamily: fonts.sans.regular,
                color: colors.fg.default,
                paddingVertical: Platform.OS === 'android' ? 8 : 0,
              } as any}
              value={spawnArgs}
              onChangeText={setSpawnArgs}
              placeholder="arguments... (e.g. run dev --port 3000)"
              placeholderTextColor={colors.fg.subtle}
              returnKeyType="done"
              onSubmitEditing={spawnProcess}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: spacing[2], justifyContent: isIPad ? 'flex-end' : undefined }}>
            <TouchableOpacity
              onPress={() => { setShowSpawnForm(false); setSpawnCommand(''); setSpawnArgs(''); setSpawnPath(''); }}
              style={{
                flex: isIPad ? undefined : 1,
                borderRadius: radius.md,
                backgroundColor: colors.bg.raised,
                height: 34,
                paddingHorizontal: isIPad ? spacing[4] : undefined,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={spawnProcess}
              disabled={spawning || !spawnCommand.trim()}
              style={{
                flex: isIPad ? undefined : 1,
                backgroundColor: spawning || !spawnCommand.trim() ? colors.accent.default + '60' : colors.accent.default,
                borderRadius: radius.md,
                height: 34,
                paddingHorizontal: isIPad ? spacing[4] : undefined,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {spawning ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={{ fontSize: 13, fontFamily: fonts.sans.medium, color: '#ffffff' }}>Spawn</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Error Banner */}
      {error && (
        <View style={{
          marginHorizontal: spacing[3],
          marginBottom: spacing[3],
          padding: spacing[3],
          backgroundColor: '#ef4444' + '15',
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
        }}>
          <AlertTriangle size={18} color={'#ef4444'} />
          <Text style={{
            flex: 1,
            marginLeft: spacing[2],
            fontSize: 13,
            fontFamily: fonts.sans.regular,
            color: '#ef4444',
          }}>
            {error}
          </Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <X size={18} color={'#ef4444'} />
          </TouchableOpacity>
        </View>
      )}

      {/* Loading State */}
      {loading ? (
        <Loading />
      ) : filteredProcesses.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6], paddingBottom: spacing[6] * 4 }}>
          <Terminal size={48} color={colors.fg.subtle} />
          <Text style={{
            fontSize: 14,
            fontFamily: fonts.sans.medium,
            color: colors.fg.muted,
            marginTop: spacing[4],
            textAlign: 'center',
          }}>
            {filter ? 'No matching processes' : 'No managed processes'}
          </Text>
          {!filter && (
            <Text style={{
              fontSize: 12,
              fontFamily: fonts.sans.regular,
              color: colors.fg.subtle,
              marginTop: spacing[2],
              textAlign: 'center',
            }}>
              Tap + to spawn a new process
            </Text>
          )}
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: spacing[4], paddingTop: spacing[2] }}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
        >
          {filteredProcesses.map((process, index) => (
            <TouchableOpacity
              key={process.pid}
              onPress={() => setSelectedProcess(process)}
              activeOpacity={0.6}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: spacing[2],
                gap: spacing[3],
                borderTopWidth: index === 0 ? 0 : 0.5,
                borderTopColor: colors.border.secondary,
              }}
            >
              <View style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                backgroundColor: getStatusColor(process.status),
              }} />
              <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                <Text style={{
                  fontSize: typography.body,
                  fontFamily: fonts.mono.regular,
                  color: colors.fg.default,
                  flexShrink: 1,
                }} numberOfLines={1}>
                  {process.command}
                </Text>
                <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.fg.subtle }}>·</Text>
                <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.fg.muted, flexShrink: 0 }}>
                  {process.pid}
                </Text>
                <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.fg.subtle }}>·</Text>
                <Text style={{ fontSize: 11, fontFamily: fonts.sans.regular, color: colors.fg.subtle, flexShrink: 0 }}>
                  {formatDuration(process.startTime)}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.fg.subtle} strokeWidth={2} />
            </TouchableOpacity>
          ))}

          <View style={{ height: spacing[8] }} />
        </ScrollView>
      )}

      {/* Process count badge */}
      {!loading && (
        <View style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          backgroundColor: colors.bg.base,
          paddingHorizontal: 10,
          paddingVertical: 5,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}>
          <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
            {filteredProcesses.length} process{filteredProcesses.length !== 1 ? 'es' : ''}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.subtle }}>·</Text>
          <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: '#22c55e' }}>
            {processList.filter(p => p.status === 'running').length} running
          </Text>
        </View>
      )}

    </View>
  );
}

export default memo(ProcessesPanel);
