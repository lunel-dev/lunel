import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronDown, FileCode2, Search, TriangleAlert } from 'lucide-react-native';
import Header, { useHeaderHeight } from "@/components/Header";
import Loading from '@/components/Loading';
import NotConnected from '@/components/NotConnected';
import { useTheme } from '@/contexts/ThemeContext';
import { typography } from '@/constants/themes';
import { useApi, ApiError, GrepMatch } from '@/hooks/useApi';
import { usePlugins } from '@/plugins';
import { gPI } from '../../gpi';
import { PluginPanelProps } from '../../types';

interface GroupedMatch {
  file: string;
  matches: GrepMatch[];
}

function groupMatchesByFile(matches: GrepMatch[]): GroupedMatch[] {
  const groups: GroupedMatch[] = [];

  for (const match of matches) {
    const existing = groups[groups.length - 1];
    if (existing && existing.file === match.file) {
      existing.matches.push(match);
      continue;
    }

    groups.push({
      file: match.file,
      matches: [match],
    });
  }

  return groups;
}

function getHighlightedParts(content: string, query: string, caseSensitive: boolean) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [{ text: content, highlighted: false }];
  }

  const source = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? trimmedQuery : trimmedQuery.toLowerCase();
  const parts: { text: string; highlighted: boolean }[] = [];
  let startIndex = 0;

  while (startIndex < content.length) {
    const matchIndex = source.indexOf(needle, startIndex);
    if (matchIndex === -1) {
      parts.push({
        text: content.slice(startIndex),
        highlighted: false,
      });
      break;
    }

    if (matchIndex > startIndex) {
      parts.push({
        text: content.slice(startIndex, matchIndex),
        highlighted: false,
      });
    }

    parts.push({
      text: content.slice(matchIndex, matchIndex + trimmedQuery.length),
      highlighted: true,
    });
    startIndex = matchIndex + trimmedQuery.length;
  }

  return parts;
}

function SearchPanel({ isActive }: PluginPanelProps) {
  const { colors, fonts, spacing } = useTheme();
  const headerHeight = useHeaderHeight();
  const { fs, isConnected } = useApi();
  const { openTab } = usePlugins();
  const queryInputRef = useRef<TextInput>(null);

  const [query, setQuery] = useState('');
  const [searchPath, setSearchPath] = useState('.');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<GrepMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  const canSearch = query.trim().length > 0;
  const groupedMatches = useMemo(() => {
    return groupMatchesByFile(results);
  }, [results]);
  const fileCount = useMemo(() => {
    return new Set(results.map((match) => match.file)).size;
  }, [results]);
  const hasVisibleResults = !loading && !error && results.length > 0;

  const runSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    const trimmedPath = searchPath.trim() || '.';
    if (!trimmedQuery) {
      setResults([]);
      setError(null);
      setHasSearched(false);
      return;
    }

    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const matches = await fs.grep(trimmedQuery, trimmedPath, {
        caseSensitive,
        maxResults: 200,
      });
      setResults(matches);
    } catch (err) {
      setResults([]);
      setError(err instanceof ApiError ? err.message : 'Failed to search the codebase');
    } finally {
      setLoading(false);
    }
  }, [caseSensitive, fs, query, searchPath]);

  const openMatch = useCallback(async (match: GrepMatch) => {
    await gPI.editor.openFile(match.file);
    openTab('editor');
  }, [openTab]);

  const resultSummary = useMemo(() => {
    if (!hasSearched) {
      return `Search in ${searchPath.trim() || '.'}`;
    }

    if (loading) {
      return `Searching in ${searchPath.trim() || '.'}`;
    }

    if (error) {
      return 'Search failed';
    }

    const matchLabel = `${results.length} match${results.length === 1 ? '' : 'es'}`;
    const fileLabel = `${fileCount} file${fileCount === 1 ? '' : 's'}`;

    return `${matchLabel} across ${fileLabel} in ${searchPath.trim() || '.'}`;
  }, [error, fileCount, hasSearched, loading, results.length, searchPath]);

  useEffect(() => {
    if (!isActive) return;

    const timer = setTimeout(() => {
      queryInputRef.current?.focus();
    }, 150);

    return () => clearTimeout(timer);
  }, [isActive]);

  useEffect(() => {
    if (!hasSearched) return;
    if (loading) return;
    if (results.length > 0) return;

    setHasSearched(false);
    setError(null);
  }, [loading, query, results.length, hasSearched]);

  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Header title="Codebase Search" colors={colors} />
        <NotConnected colors={colors} fonts={fonts} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <Header title="Codebase Search" colors={colors} showBottomBorder={true} />

      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        contentContainerStyle={{
          paddingBottom: spacing[6],
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            paddingHorizontal: spacing[3],
            paddingTop: spacing[2],
            paddingBottom: spacing[2],
            gap: spacing[2],
            backgroundColor: colors.bg.base,
            borderBottomWidth: hasVisibleResults ? StyleSheet.hairlineWidth : 0,
            borderBottomColor: colors.border.secondary,
          }}
        >
          <View style={[styles.searchShell, { backgroundColor: colors.bg.raised, borderColor: colors.border.secondary }]}>
            <Search size={16} color={colors.fg.subtle} strokeWidth={2} />
            <TextInput
              ref={queryInputRef}
              style={[styles.searchInput, { color: colors.fg.default, fontFamily: fonts.mono.regular }]}
              placeholder="Search code..."
              placeholderTextColor={colors.fg.subtle}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => { if (canSearch && !loading) void runSearch(); }}
            />
            <TouchableOpacity
              onPress={() => setShowOptions((prev) => !prev)}
              activeOpacity={0.7}
              style={styles.iconButton}
            >
              <ChevronDown
                size={16}
                color={colors.fg.muted}
                strokeWidth={2}
                style={{ transform: [{ rotate: showOptions ? '180deg' : '0deg' }] }}
              />
            </TouchableOpacity>
          </View>

          {showOptions ? (
            <View
              style={[
                styles.optionsCard,
                {
                  backgroundColor: colors.bg.raised,
                  borderColor: colors.border.secondary,
                },
              ]}
            >
              <View style={styles.toolbarRow}>
                <View style={[styles.secondaryRow, { backgroundColor: colors.bg.raised }]}>
                  <Text style={{ color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 12 }}>
                    Path
                  </Text>
                <View style={[styles.secondaryValueRow, { borderColor: colors.border.secondary }]}>
                  <TextInput
                    style={[styles.pathInput, { color: colors.fg.default, fontFamily: fonts.mono.regular }]}
                    placeholder="."
                      placeholderTextColor={colors.fg.subtle}
                      value={searchPath}
                      onChangeText={setSearchPath}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>

                <View
                  style={[
                    styles.secondaryRow,
                    {
                      backgroundColor: colors.bg.raised,
                    },
                  ]}
                >
                  <Text style={{ color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 12 }}>
                    Case sensitive
                  </Text>
                  <View style={styles.secondaryToggleRow}>
                    <Switch
                      value={caseSensitive}
                      onValueChange={setCaseSensitive}
                      trackColor={{ false: colors.fg.subtle, true: colors.accent.default + '88' }}
                      thumbColor={caseSensitive ? '#ffffff' : colors.fg.default}
                      ios_backgroundColor={colors.fg.subtle}
                    />
                  </View>
                </View>
              </View>
            </View>
          ) : null}

          {hasVisibleResults ? (
            <View style={styles.summaryRow}>
              <Text style={{ flex: 1, color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: typography.caption }}>
                {resultSummary}
              </Text>
              <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: typography.caption }}>
                Tap a hit to open the file
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ paddingTop: spacing[1], paddingBottom: spacing[6] }}>
          {error ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing[2],
                padding: spacing[3],
                marginHorizontal: spacing[3],
                borderRadius: 10,
                backgroundColor: '#ef4444' + '15',
              }}
            >
              <TriangleAlert size={16} color="#ef4444" strokeWidth={2} />
              <Text style={{ flex: 1, color: '#ef4444', fontFamily: fonts.sans.medium, fontSize: 13 }}>
                {error}
              </Text>
            </View>
          ) : null}

          {loading ? (
            <Loading />
          ) : (
            <View>
              {groupedMatches.map((group) => {
                return (
                  <TouchableOpacity
                    key={group.file}
                    activeOpacity={0.7}
                    onPress={() => void openMatch(group.matches[0])}
                    style={{
                      paddingHorizontal: spacing[3],
                      paddingVertical: spacing[2],
                      gap: 6,
                    }}
                  >
                    <View style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: spacing[2],
                    }}>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text
                          style={{
                            fontSize: typography.body,
                            fontFamily: fonts.sans.medium,
                            color: colors.fg.default,
                          }}
                          numberOfLines={1}
                        >
                          {group.file}
                        </Text>

                        {group.matches.map((match, index) => {
                          const highlightedParts = getHighlightedParts(match.content, query, caseSensitive);

                          return (
                            <View
                              key={`${match.file}:${match.line}:${index}`}
                              style={styles.matchRow}
                            >
                              <Text
                                style={{
                                  width: 40,
                                  color: colors.fg.subtle,
                                  fontFamily: fonts.mono.regular,
                                  fontSize: 12,
                                }}
                              >
                                {match.line}
                              </Text>
                              <Text
                                style={{
                                  flex: 1,
                                  color: colors.fg.muted,
                                  fontFamily: fonts.mono.regular,
                                  fontSize: typography.caption,
                                  lineHeight: 18,
                                }}
                                numberOfLines={2}
                              >
                                {highlightedParts.map((part, partIndex) => (
                                  <Text
                                    key={`${match.file}:${match.line}:${partIndex}`}
                                    style={part.highlighted ? { color: colors.fg.default, fontFamily: fonts.mono.bold } : undefined}
                                  >
                                    {part.text}
                                  </Text>
                                ))}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}

              {hasSearched && !loading && results.length === 0 ? (
                <View
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: spacing[8],
                    gap: spacing[2],
                  }}
                >
                  <FileCode2 size={36} color={colors.fg.subtle} strokeWidth={1.8} />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 14 }}>
                      No matches for
                    </Text>
                    <Text style={{ color: colors.fg.default, fontFamily: fonts.mono.medium, fontSize: 14 }}>
                      {query.trim()}
                    </Text>
                  </View>
                  <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: typography.caption }}>
                    Try a broader path or change the casing filter.
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  searchShell: {
    height: 40,
    borderRadius: 8,
    paddingLeft: 12,
    paddingRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: typography.body,
    paddingVertical: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarRow: {
    flexDirection: 'column',
    gap: 8,
  },
  optionsCard: {
    marginTop: 4,
    borderRadius: 12,
    padding: 0,
  },
  secondaryRow: {
    minHeight: 40,
    borderRadius: 8,
    paddingLeft: 12,
    paddingRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  secondaryValueRow: {
    flex: 1,
    minHeight: 32,
    borderRadius: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    paddingRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  secondaryToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginLeft: 'auto',
  },
  pathInput: {
    flex: 1,
    fontSize: 13,
    paddingVertical: 8,
    outlineStyle: 'none',
  } as any,
  summaryRow: {
    minHeight: 18,
    paddingTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
});

export default memo(SearchPanel);
