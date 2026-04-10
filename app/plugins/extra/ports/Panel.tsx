import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { X, RefreshCw, AlertTriangle, Wifi, Search } from 'lucide-react-native';
import PluginHeader, { usePluginHeaderHeight } from '@/components/PluginHeader';
import NotConnected from '@/components/NotConnected';
import Loading from '@/components/Loading';
import { useConnection } from '@/contexts/ConnectionContext';
import { useTheme } from '@/contexts/ThemeContext';
import { PluginPanelProps } from '../../types';
import { useApi, PortInfo, ApiError } from '@/hooks/useApi';

function PortsPanel({ instanceId, isActive }: PluginPanelProps) {
  const { colors, fonts, spacing, radius } = useTheme();
  const headerHeight = usePluginHeaderHeight();
  const { ports: portsApi, isConnected } = useApi();
  const { trackedProxyPorts, untrackProxyPort } = useConnection();

  const [portsList, setPortsList] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killingPorts, setKillingPorts] = useState<Set<number>>(new Set());
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadPorts = useCallback(async () => {
    if (!isConnected) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const result = await portsApi.list();
      setPortsList(result);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load ports';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isConnected, portsApi]);

  useEffect(() => {
    if (isActive && isConnected) loadPorts();
  }, [isActive, isConnected, loadPorts]);

  useEffect(() => {
    if (!isActive || !isConnected) return;
    const interval = setInterval(loadPorts, 10000);
    return () => clearInterval(interval);
  }, [isActive, isConnected, loadPorts]);

  const killPort = async (port: number) => {
    setKillingPorts(prev => new Set(prev).add(port));
    try {
      await portsApi.kill(port);
      if (trackedProxyPorts.includes(port)) {
        await untrackProxyPort(port);
      }
      setPortsList(prev => prev.filter(p => p.port !== port));
      setTimeout(() => {
        void loadPorts();
      }, 750);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to kill port';
      Alert.alert('Error', message);
    } finally {
      setKillingPorts(prev => {
        const next = new Set(prev);
        next.delete(port);
        return next;
      });
    }
  };

  const sortedPorts = [...portsList]
    .sort((a, b) => a.port - b.port)
    .filter(p => !searchQuery.trim() || p.port.toString().includes(searchQuery) || (p.process || '').toLowerCase().includes(searchQuery.toLowerCase()));

  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: headerHeight }}>
        <PluginHeader title="Ports" colors={colors} />
        <NotConnected colors={colors} fonts={fonts} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: headerHeight, position: 'relative' }}>
      <PluginHeader
        title="Ports"
        colors={colors}
        rightAccessory={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => { setShowSearch(v => !v); setSearchQuery(''); }} style={{ padding: 8 }}>
              {showSearch ? <X size={20} color={colors.fg.muted} strokeWidth={2} /> : <Search size={20} color={colors.fg.muted} strokeWidth={2} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setLoading(true); loadPorts(); }} style={{ padding: 8 }}>
              <RefreshCw size={20} color={colors.fg.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        }
        rightAccessoryWidth={80}
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
              placeholder="search ports..."
              placeholderTextColor={colors.fg.subtle}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
      )}

      {/* Error Banner */}
      {error && (
        <View style={{
          marginHorizontal: spacing[3],
          marginBottom: spacing[2],
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          backgroundColor: '#ef4444' + '15',
          borderRadius: radius.md,
          flexDirection: 'row',
          alignItems: 'center',
        }}>
          <AlertTriangle size={14} color={'#ef4444'} strokeWidth={2} />
          <Text style={{
            flex: 1,
            marginLeft: spacing[2],
            fontSize: 14,
            fontFamily: fonts.sans.regular,
            color: '#ef4444',
          }}>
            {error}
          </Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <X size={14} color={'#ef4444'} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <Loading />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: spacing[4], paddingHorizontal: spacing[4], paddingTop: spacing[1] }}
          showsVerticalScrollIndicator={false}
        >
          {sortedPorts.length === 0 ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: spacing[16] }}>
              <Wifi size={36} color={colors.fg.subtle} strokeWidth={1.5} />
              <Text style={{
                fontSize: 14,
                fontFamily: fonts.sans.medium,
                color: colors.fg.muted,
                marginTop: spacing[3],
              }}>
                No listening ports
              </Text>
            </View>
          ) : (() => {
            const groups: { process: string; ports: PortInfo[] }[] = [];
            for (const port of sortedPorts) {
              const name = port.process || 'unknown';
              const existing = groups.find(g => g.process === name);
              if (existing) existing.ports.push(port);
              else groups.push({ process: name, ports: [port] });
            }
            return (
              <View style={{ gap: spacing[3] }}>
                {groups.map(group => (
                  <View key={group.process}>
                    {/* Group header */}
                    <View style={{
                      paddingHorizontal: 0,
                      paddingVertical: spacing[2],
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}>
                      <Text style={{
                        fontSize: 14,
                        fontFamily: fonts.sans.medium,
                        color: colors.fg.default,
                      }}>
                        {group.process}
                      </Text>
                    </View>

                    {/* Port rows */}
                    {group.ports.map((port, portIdx) => (
                      <View
                        key={`${port.port}-${port.pid}-${portIdx}`}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 0,
                          paddingVertical: 4,
                          borderTopWidth: portIdx === 0 ? 0 : 0.5,
                          borderTopColor: colors.border.secondary,
                        }}
                      >
                        <Text style={{
                          fontSize: 12,
                          fontFamily: fonts.mono.regular,
                          color: colors.accent.default,
                          width: 56,
                        }}>
                          {`:${port.port}`}
                        </Text>

                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Text style={{
                              fontSize: 12,
                              fontFamily: fonts.mono.regular,
                              color: colors.fg.muted,
                            }}>
                              {`PID ${port.pid}`}
                            </Text>
                            {port.address ? (
                              <>
                                <Text style={{ fontSize: 11, fontFamily: fonts.mono.regular, color: colors.fg.subtle }}>·</Text>
                                <Text numberOfLines={1} style={{
                                  fontSize: 12,
                                  fontFamily: fonts.mono.regular,
                                  color: colors.fg.subtle,
                                  flexShrink: 1,
                                }}>
                                  {port.address}
                                </Text>
                              </>
                            ) : null}
                          </View>
                        </View>

                        <TouchableOpacity
                          onPress={() => killPort(port.port)}
                          disabled={killingPorts.has(port.port)}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 9,
                            backgroundColor: '#ef444418',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginLeft: spacing[2],
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          {killingPorts.has(port.port) ? (
                            <Loading size="small" color={'#ef4444'} />
                          ) : (
                            <X size={13} color={'#ef4444'} strokeWidth={2.5} />
                          )}
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          })()}
        </ScrollView>
      )}
    </View>
  );
}

export default memo(PortsPanel);
