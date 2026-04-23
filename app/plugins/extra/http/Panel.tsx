import React, { useState, useEffect, memo, useRef } from 'react';
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Switch,
  ActivityIndicator,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { Clock, ChevronDown, ChevronRight, X, Plus, Copy, Check } from 'lucide-react-native';
import { MenuView } from '@react-native-menu/menu';
import Header, { useHeaderHeight } from "@/components/Header";
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/contexts/ThemeContext';
import { typography } from '@/constants/themes';
import { PluginPanelProps } from '../../types';
import { lunelApi } from '@/lib/storage';
import { useApi, ApiError } from '@/hooks/useApi';

const HISTORY_KEY = 'http-history';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type HttpTab = 'client' | 'history' | 'configure';

interface Header {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  time: number;
}

interface HistoryItem {
  id: string;
  timestamp: string;
  request: {
    method: HttpMethod;
    url: string;
    headers: Header[];
    body: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    time: number;
  };
  viaCli?: boolean;
}

async function loadHistory(): Promise<HistoryItem[]> {
  const data = await lunelApi.storage.jsons.read<HistoryItem[]>(HISTORY_KEY);
  return data || [];
}

async function saveHistory(history: HistoryItem[]) {
  await lunelApi.storage.jsons.write(HISTORY_KEY, history);
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

function HttpPanel({ instanceId, isActive, bottomBarHeight }: PluginPanelProps) {
  const { colors, fonts, spacing } = useTheme();
  const headerHeight = useHeaderHeight();
  const { http: httpApi, isConnected } = useApi();

  const [method, setMethod] = useState<HttpMethod>('GET');
  const [url, setUrl] = useState('https://catfact.ninja/fact');
  const [headers, setHeaders] = useState<Header[]>([
    { id: '1', key: 'Content-Type', value: 'application/json', enabled: true },
  ]);
  const [body, setBody] = useState('');
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeTab, setActiveTab] = useState<HttpTab>('client');
  const [historySearch, setHistorySearch] = useState('');
  const [useCliProxy, setUseCliProxy] = useState(true);
  const [copied, setCopied] = useState(false);
  const urlInputRef = useRef<any>(null);
  const { height: keyboardHeightSV } = useReanimatedKeyboardAnimation();
  const rootAnimatedStyle = useAnimatedStyle(() => ({
    marginBottom: Math.max(0, -keyboardHeightSV.value - bottomBarHeight),
  }));

  // Collapsible sections
  const [requestExpanded, setRequestExpanded] = useState(true);
  const [responseHeadersExpanded, setResponseHeadersExpanded] = useState(false);
  const baseTextSize = 14;
  const sectionLabelStyle = {
    fontSize: baseTextSize,
    fontFamily: fonts.sans.medium,
    color: colors.fg.muted,
  };
  const metaTextStyle = {
    fontSize: baseTextSize,
    fontFamily: fonts.sans.regular,
    color: colors.fg.muted,
  };
  const panelStyle = {
    backgroundColor: colors.bg.raised,
    borderRadius: 10,
    overflow: 'hidden' as const,
  };
  const getMethodColor = (value: HttpMethod) => {
    switch (value) {
      case 'GET':
        return colors.terminal.green;
      case 'POST':
        return colors.terminal.blue;
      case 'PUT':
        return colors.terminal.yellow;
      case 'DELETE':
        return colors.terminal.red;
      case 'PATCH':
        return colors.terminal.magenta;
      default:
        return colors.fg.default;
    }
  };

  // Load history on mount
  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  const addHeader = () => {
    setHeaders([...headers, { id: Date.now().toString(), key: '', value: '', enabled: true }]);
  };

  const updateHeader = (id: string, field: 'key' | 'value', value: string) => {
    setHeaders(headers.map(h => h.id === id ? { ...h, [field]: value } : h));
  };

  const toggleHeader = (id: string) => {
    setHeaders(headers.map(h => h.id === id ? { ...h, enabled: !h.enabled } : h));
  };

  const removeHeader = (id: string) => {
    setHeaders(headers.filter(h => h.id !== id));
  };

  const sendRequest = async () => {
    setIsLoading(true);
    const startTime = Date.now();

    try {
      const reqHeaders: Record<string, string> = {};
      headers.filter(h => h.enabled && h.key).forEach(h => {
        reqHeaders[h.key] = h.value;
      });

      let httpResponse: HttpResponse;

      if (useCliProxy && isConnected) {
        const result = await httpApi.request({
          method,
          url,
          headers: reqHeaders,
          body: (method === 'POST' || method === 'PUT' || method === 'PATCH') && body ? body : undefined,
          timeout: 30000,
        });

        let formattedBody = result.body;
        try {
          const parsed = JSON.parse(result.body);
          formattedBody = JSON.stringify(parsed, null, 2);
        } catch {
          // Not JSON, keep as-is
        }

        httpResponse = {
          status: result.status,
          statusText: result.statusText || getStatusText(result.status),
          headers: result.headers,
          body: formattedBody,
          time: result.timing,
        };
      } else {
        const fetchResponse = await fetch(url, {
          method,
          headers: reqHeaders,
          body: (method === 'POST' || method === 'PUT' || method === 'PATCH') && body ? body : undefined,
        });

        const responseBody = await fetchResponse.text();
        const responseHeaders: Record<string, string> = {};
        fetchResponse.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let formattedBody = responseBody;
        try {
          const parsed = JSON.parse(responseBody);
          formattedBody = JSON.stringify(parsed, null, 2);
        } catch {
          // Not JSON, keep as-is
        }

        httpResponse = {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText || getStatusText(fetchResponse.status),
          headers: responseHeaders,
          body: formattedBody,
          time: Date.now() - startTime,
        };
      }

      setResponse(httpResponse);
      setIsLoading(false);

      const newItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        request: { method, url, headers: headers.filter(h => h.enabled), body },
        response: {
          status: httpResponse.status,
          statusText: httpResponse.statusText,
          headers: httpResponse.headers,
          body: httpResponse.body,
          time: httpResponse.time,
        },
        viaCli: useCliProxy && isConnected,
      };
      setHistory(prev => {
        const updated = [newItem, ...prev].slice(0, 50);
        saveHistory(updated);
        return updated;
      });
    } catch (error) {
      const errorMessage = error instanceof ApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Request failed';

      setResponse({
        status: 0,
        statusText: 'Error',
        headers: {},
        body: errorMessage,
        time: Date.now() - startTime,
      });
      setIsLoading(false);
    }
  };

  const getStatusText = (status: number): string => {
    const statusTexts: Record<number, string> = {
      200: 'OK', 201: 'Created', 204: 'No Content',
      301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
      404: 'Not Found', 405: 'Method Not Allowed',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    };
    return statusTexts[status] || '';
  };

  const loadFromHistory = (item: HistoryItem) => {
    const oldItem = item as any;
    const m = item.request?.method ?? oldItem.method ?? 'GET';
    const u = item.request?.url ?? oldItem.url ?? '';
    const reqHeaders = item.request?.headers ?? [];
    const reqBody = item.request?.body ?? '';

    setMethod(m);
    setUrl(u);
    setHeaders(reqHeaders.length > 0
      ? reqHeaders
      : [{ id: '1', key: 'Content-Type', value: 'application/json', enabled: true }]
    );
    setBody(reqBody);

    if (item.response) {
      setResponse({
        status: item.response.status,
        statusText: item.response.statusText,
        headers: item.response.headers,
        body: item.response.body,
        time: item.response.time,
      });
    }
    setActiveTab('client');
  };

  const copyResponse = async () => {
    if (response?.body) {
      await Clipboard.setStringAsync(response.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const clearHistory = async () => {
    setHistory([]);
    setHistorySearch('');
    await saveHistory([]);
  };

  const getStatusColor = (status: number) => {
    if (status >= 200 && status < 300) return '#22c55e';
    if (status >= 300 && status < 400) return '#3b82f6';
    if (status >= 400 && status < 500) return '#f59e0b';
    return '#ef4444';
  };

  const filteredHistory = history.filter((item) => {
    const m = item.request?.method ?? (item as any).method ?? 'GET';
    const u = item.request?.url ?? (item as any).url ?? '';
    const status = item.response?.status ?? (item as any).status ?? 0;
    const query = historySearch.trim().toLowerCase();
    if (!query) return true;
    return (
      m.toLowerCase().includes(query) ||
      u.toLowerCase().includes(query) ||
      String(status).includes(query)
    );
  });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <Header title="Rest API Client" colors={colors} />

      <View style={{
        flexDirection: 'row',
        paddingHorizontal: spacing[3],
        borderBottomWidth: 0.5,
        borderBottomColor: colors.border.secondary,
      }}>
        {([
          { key: 'client', label: 'API Client' },
          { key: 'history', label: 'History' },
          { key: 'configure', label: 'Configure' },
        ] as { key: HttpTab; label: string }[]).map((tab) => {
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
              <Text style={{
                fontSize: baseTextSize,
                fontFamily: fonts.sans.medium,
                color: active ? colors.fg.default : colors.fg.muted,
              }}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {activeTab === 'configure' ? (
        <View style={{ flex: 1, paddingHorizontal: spacing[3], paddingTop: spacing[2] }}>
          <View style={{ marginBottom: spacing[2] }}>
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing[3],
              paddingVertical: spacing[2],
              gap: spacing[3],
            }}>
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontSize: typography.body,
                  fontFamily: fonts.sans.medium,
                  color: colors.fg.default,
                  marginBottom: 2,
                }}>
                  Route requests via PC
                </Text>
                <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
                  Allows localhost access and uses the connected CLI machine for outgoing requests.
                </Text>
              </View>
              <View style={{ width: 72, alignItems: 'flex-end' }}>
                <Switch
                  value={useCliProxy}
                  onValueChange={setUseCliProxy}
                  trackColor={{ false: colors.bg.raised, true: colors.bg.raised }}
                  thumbColor={useCliProxy ? colors.fg.default : colors.fg.subtle}
                />
              </View>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => { void clearHistory(); }}
            activeOpacity={0.75}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing[3],
              paddingVertical: spacing[2],
              borderTopWidth: 0.5,
              borderTopColor: colors.border.secondary,
            }}
          >
            <View style={{ flex: 1, paddingRight: spacing[3] }}>
              <Text style={{
                fontSize: typography.body,
                fontFamily: fonts.sans.medium,
                color: colors.fg.default,
                marginBottom: 2,
              }}>
                Clear history
              </Text>
              <Text style={{ fontSize: typography.caption, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
                Removes saved request and response history from this tool.
              </Text>
            </View>
            <View
              style={{
                minHeight: 34,
                paddingHorizontal: spacing[3],
                borderRadius: 10,
                backgroundColor: colors.bg.raised,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{
                fontSize: typography.body,
                fontFamily: fonts.sans.medium,
                color: colors.terminal.red,
              }}>
                Clear
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      ) : activeTab === 'history' ? (
        history.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: spacing[8] + spacing[2] }}>
            <Clock size={48} color={colors.fg.subtle} strokeWidth={1.5} />
            <Text style={{ fontSize: baseTextSize, fontFamily: fonts.sans.medium, color: colors.fg.muted, marginTop: spacing[4] }}>
              No history yet
            </Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
            <View style={{ paddingHorizontal: spacing[3], paddingTop: spacing[2] }}>
              <TextInput
                value={historySearch}
                onChangeText={setHistorySearch}
                placeholder="Search history"
                placeholderTextColor={colors.fg.muted}
                style={{
                  height: 40,
                  paddingHorizontal: spacing[3],
                  borderRadius: 10,
                  backgroundColor: colors.bg.raised,
                  fontSize: baseTextSize,
                  fontFamily: fonts.sans.regular,
                  color: colors.fg.default,
                  marginBottom: spacing[2],
                  outline: 'none',
                } as any}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ marginBottom: spacing[2] }}>
              {filteredHistory.map((item, index) => {
                const m = item.request?.method ?? (item as any).method ?? 'GET';
                const u = item.request?.url ?? (item as any).url ?? '';
                const status = item.response?.status ?? (item as any).status ?? 0;

                return (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => loadFromHistory(item)}
                    style={{
                      paddingHorizontal: spacing[3],
                      paddingVertical: spacing[2],
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing[2],
                      borderTopWidth: index === 0 ? 0 : 0.5,
                      borderTopColor: colors.border.secondary,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: spacing[2], flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                      <Text
                        style={{
                          width: 34,
                          fontSize: baseTextSize,
                          fontFamily: fonts.sans.medium,
                          color: getMethodColor(m as HttpMethod),
                        }}
                      >
                        {m.slice(0, 3)}
                      </Text>
                      <Text
                        style={{
                          flex: 1,
                          fontSize: baseTextSize,
                          fontFamily: fonts.sans.regular,
                          color: colors.fg.default,
                        }}
                        numberOfLines={1}
                      >
                        {u}
                      </Text>
                    </View>
                    <View style={{ width: 64 }}>
                      <Text style={{
                        fontSize: baseTextSize,
                        fontFamily: fonts.sans.medium,
                        color: getStatusColor(status),
                        textAlign: 'right',
                      }}>
                        {status}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              {filteredHistory.length === 0 && (
                <View style={{ paddingVertical: spacing[5], alignItems: 'center' }}>
                  <Text style={metaTextStyle}>No matching history entries</Text>
                </View>
              )}
              </View>
            </View>
            <View style={{ height: spacing[8] }} />
          </ScrollView>
        )
      ) : (
        <Animated.View style={[{ flex: 1 }, rootAnimatedStyle]}>
      <View style={{
        flexDirection: 'row',
        paddingHorizontal: spacing[3],
        paddingVertical: spacing[2],
        gap: 8,
        alignItems: 'center',
      }}>
        <MenuView
          shouldOpenOnLongPress={false}
          onPressAction={({ nativeEvent }) => {
            setMethod(nativeEvent.event as HttpMethod);
          }}
          actions={METHODS.map(m => ({ id: m, title: m }))}
        >
          <TouchableOpacity
            style={{
              height: 42,
              paddingHorizontal: spacing[3],
              borderRadius: 10,
              backgroundColor: colors.bg.raised,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: spacing[1],
            }}
            activeOpacity={0.7}
          >
            <Text style={{
              fontSize: 13,
              fontFamily: fonts.sans.medium,
              color: getMethodColor(method),
            }}>
              {method}
            </Text>
            <ChevronDown size={12} color={colors.fg.muted} strokeWidth={2.5} />
          </TouchableOpacity>
        </MenuView>
        {/* URL Input */}
        <TextInput
          ref={urlInputRef}
          style={{
            flex: 1,
            height: 42,
            paddingHorizontal: spacing[3],
            borderRadius: 10,
            fontSize: baseTextSize,
            fontFamily: fonts.sans.regular,
            color: colors.fg.default,
            backgroundColor: colors.bg.raised,
            outline: 'none',
          } as any}
          value={url}
          onChangeText={setUrl}
          placeholder="https://api.example.com"
          placeholderTextColor={colors.fg.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag">
        {/* Request Section */}
        <View style={{ paddingHorizontal: spacing[3] }}>
          <View style={{
            ...panelStyle,
            marginBottom: spacing[2],
          }}>
            <TouchableOpacity
              onPress={() => setRequestExpanded(!requestExpanded)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: spacing[2],
                paddingHorizontal: spacing[3],
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                {requestExpanded ? (
                  <ChevronDown size={16} color={colors.fg.muted} strokeWidth={2} />
                ) : (
                  <ChevronRight size={16} color={colors.fg.muted} strokeWidth={2} />
                )}
                <Text style={sectionLabelStyle}>Request</Text>
              </View>
            </TouchableOpacity>

            {requestExpanded && (
              <View style={{
                paddingHorizontal: spacing[3],
                paddingBottom: spacing[3],
              }}>
                {/* Headers label */}
                <Text style={{ ...sectionLabelStyle, marginBottom: spacing[2] }}>Headers</Text>
                <View>
                  {headers.map((header, index) => (
                    <View
                      key={header.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: spacing[2],
                        paddingVertical: spacing[2],
                        borderTopWidth: index === 0 ? 0 : 0.5,
                        borderTopColor: colors.border.secondary,
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => toggleHeader(header.id)}
                        activeOpacity={0.7}
                        style={{
                          width: 24,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: header.enabled ? colors.accent.default : colors.border.secondary,
                            backgroundColor: header.enabled ? colors.accent.default : colors.bg.base,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {header.enabled ? (
                            <Check size={11} color="#fff" strokeWidth={3} />
                          ) : null}
                        </View>
                      </TouchableOpacity>
                      <TextInput
                        style={{
                          width: '32%',
                          minWidth: 96,
                          fontSize: baseTextSize,
                          fontFamily: fonts.sans.regular,
                          color: header.enabled ? colors.fg.default : colors.fg.muted,
                          paddingVertical: 0,
                          outline: 'none',
                        } as any}
                        value={header.key}
                        onChangeText={(v) => updateHeader(header.id, 'key', v)}
                        placeholder="Key"
                        placeholderTextColor={colors.fg.muted}
                      />
                      <TextInput
                        style={{
                          flex: 1,
                          fontSize: baseTextSize,
                          fontFamily: fonts.sans.regular,
                          color: header.enabled ? colors.fg.default : colors.fg.muted,
                          paddingVertical: 0,
                          outline: 'none',
                        } as any}
                        value={header.value}
                        onChangeText={(v) => updateHeader(header.id, 'value', v)}
                        placeholder="Value"
                        placeholderTextColor={colors.fg.muted}
                      />
                      <TouchableOpacity
                        onPress={() => removeHeader(header.id)}
                        style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <X size={16} color={colors.fg.muted} strokeWidth={2} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
                <TouchableOpacity
                  onPress={addHeader}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing[2],
                    paddingVertical: spacing[1],
                  }}
                >
                  <Plus size={16} color={colors.accent.default} strokeWidth={2} />
                  <Text style={{ fontSize: baseTextSize, fontFamily: fonts.sans.medium, color: colors.accent.default }}>
                    Add header
                  </Text>
                </TouchableOpacity>

                {/* Body */}
                {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
                  <>
                    <Text style={{ ...sectionLabelStyle, marginTop: spacing[3], marginBottom: spacing[2] }}>Body</Text>
                    <TextInput
                      style={{
                        minHeight: 88,
                        padding: spacing[3],
                        borderRadius: 12,
                        fontSize: baseTextSize,
                        fontFamily: fonts.sans.regular,
                        color: colors.fg.default,
                        backgroundColor: colors.bg.base,
                        textAlignVertical: 'top',
                        outline: 'none',
                      } as any}
                      value={body}
                      onChangeText={setBody}
                      placeholder='{"key": "value"}'
                      placeholderTextColor={colors.fg.muted}
                      multiline
                    />
                  </>
                )}
              </View>
            )}
          </View>
        </View>

        {/* Response Section */}
        <View style={{ paddingHorizontal: spacing[3] }}>
          {response ? (
            <View style={{
              ...panelStyle,
              marginBottom: spacing[2],
            }}>
              {/* Response Status Bar */}
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: spacing[2],
                paddingHorizontal: spacing[3],
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[3] }}>
                  <View style={{
                    paddingHorizontal: spacing[3],
                    paddingVertical: 4,
                    borderRadius: 10,
                    backgroundColor: colors.bg.base,
                  }}>
                    <Text style={{
                        fontSize: 13,
                        fontFamily: fonts.sans.medium,
                        color: getStatusColor(response.status),
                      }}>
                        {response.status} {response.statusText}
                      </Text>
                  </View>
                  <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
                    {response.time}ms
                  </Text>
                </View>
                <TouchableOpacity onPress={copyResponse} style={{ padding: spacing[2] }}>
                  {copied
                    ? <Check size={18} color={colors.fg.muted} strokeWidth={2} />
                    : <Copy size={18} color={colors.fg.muted} strokeWidth={2} />
                  }
                </TouchableOpacity>
              </View>

              {/* Response Body */}
              <View style={{ padding: spacing[3], paddingTop: 0, maxHeight: 360 }}>
                <ScrollView showsVerticalScrollIndicator nestedScrollEnabled>
                  <ScrollView horizontal showsHorizontalScrollIndicator>
                    <Text
                      style={{
                        fontSize: 12,
                        fontFamily: fonts.mono.regular,
                        color: colors.fg.default,
                        lineHeight: 20,
                      }}
                      selectable
                    >
                      {response.body}
                    </Text>
                  </ScrollView>
                </ScrollView>
              </View>

              {/* Response Headers (Collapsible) */}
              <TouchableOpacity
                onPress={() => setResponseHeadersExpanded(!responseHeadersExpanded)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: spacing[2],
                  paddingHorizontal: spacing[3],
                  paddingBottom: spacing[4],
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  {responseHeadersExpanded ? (
                    <ChevronDown size={14} color={colors.fg.muted} strokeWidth={2} />
                  ) : (
                    <ChevronRight size={14} color={colors.fg.muted} strokeWidth={2} />
                  )}
                  <Text style={sectionLabelStyle}>
                    Response Headers ({Object.keys(response.headers).length})
                  </Text>
                </View>
              </TouchableOpacity>
              {responseHeadersExpanded && (
                <View style={{
                  paddingHorizontal: spacing[3],
                  paddingBottom: spacing[4],
                }}>
                  {Object.entries(response.headers).map(([key, value], index) => (
                    <View
                      key={key}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'flex-start',
                        gap: spacing[2],
                        paddingVertical: spacing[2],
                        borderTopWidth: index === 0 ? 0 : 0.5,
                        borderTopColor: colors.border.secondary,
                      }}
                    >
                      <Text style={{
                        width: '32%',
                        minWidth: 96,
                        fontSize: baseTextSize,
                        fontFamily: fonts.sans.regular,
                        color: colors.accent.default,
                      }}
                      numberOfLines={1}
                      >
                        {key}
                      </Text>
                      <Text style={{
                        flex: 1,
                        fontSize: baseTextSize,
                        fontFamily: fonts.sans.regular,
                        color: colors.fg.default,
                      }}>
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : null}
        </View>

        <View style={{ height: spacing[8] }} />
      </ScrollView>

      <View
        style={{
          backgroundColor: colors.bg.base,
          borderTopWidth: 0.5,
          borderTopColor: colors.border.secondary,
          paddingHorizontal: spacing[3],
          paddingVertical: 8,
        }}
      >
        <TouchableOpacity
          onPress={sendRequest}
          disabled={isLoading || !url.trim()}
          activeOpacity={0.7}
          style={{
            height: 34,
            borderRadius: 10,
            backgroundColor: colors.accent.default,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing[3],
            opacity: url.trim() && !isLoading ? 1 : 0.5,
          }}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={{
              fontSize: 13,
              fontFamily: fonts.sans.semibold,
              color: '#fff',
            }}>
              Send Request
            </Text>
          )}
        </TouchableOpacity>
      </View>
        </Animated.View>
      )}
    </View>
  );
}

export default memo(HttpPanel);
