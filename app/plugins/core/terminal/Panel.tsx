import PluginHeader, { BaseTab, usePluginHeaderHeight } from "@/components/PluginHeader";
import Loading from "@/components/Loading";
import { useSessionRegistryActions } from "@/contexts/SessionRegistry";
import { radius } from "@/constants/themes";
import { useConnection } from "@/contexts/ConnectionContext";
import { useTheme } from "@/contexts/ThemeContext";
import {
  Canvas,
  Group,
  Rect,
  Text as SkiaText,
  useFont,
} from "@shopify/react-native-skia";
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
  TerminalCell,
  TerminalState,
  useTerminal,
} from "@/hooks/useTerminal";
import * as Haptics from "expo-haptics";
import * as FileSystem from "expo-file-system/legacy";
import { Audio } from "expo-av";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CornerDownLeft,
  Keyboard as KeyboardIcon,
  Mic,
  Plus,
  Terminal,
  X,
} from "lucide-react-native";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Keyboard,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  withTiming,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import Svg, { Path } from "react-native-svg";
import { PluginPanelProps } from "../../types";

// ============================================================================
// Constants
// ============================================================================

const FONT_SIZE = 12;
const CHAR_WIDTH = FONT_SIZE * 0.602; // Monospace char width ratio
const LINE_HEIGHT = FONT_SIZE * 1.45;
const MONO_FONT = "JetBrainsMonoNerdFontMono-Regular";
const MONO_FONT_BOLD = "JetBrainsMonoNerdFontMono-Bold";
const TERMINAL_PADDING = 8;
const TERMINAL_PADDING_RIGHT = 16;
const FLOATING_CONTROLS_REST_BOTTOM = 0;
const FLOATING_CONTROLS_KEYBOARD_PADDING = 0;
const TOOLBAR_RESERVED_HEIGHT = 60;
const QUICK_INPUT_RESERVED_HEIGHT = 0;
const { width: SCREEN_WIDTH } = Dimensions.get("window");
const MIC_WAVE_BAR_COUNT = Math.round(42 * (SCREEN_WIDTH / 390));
const MIC_WAVE_IDLE_LEVEL = 0.08;
const MIC_WAVE_DOT_SIZE = 2.5;
const MIC_WAVE_MAX_EXTRA_HEIGHT = 34;
const TERMINAL_TRANSCRIBE_ENDPOINT = "";
const MONO_FONT_ASSET = require("../../../assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf");
const MONO_FONT_BOLD_ASSET = require("../../../assets/fonts/JetBrainsMonoNerdFontMono-Bold.ttf");

function formatMicDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const springConfig = {
  damping: 20,
  stiffness: 200,
  mass: 0.8,
};

function TrashIcon({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h16m-10 4v6m4-6v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SendIcon({ size = 24, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 5v14m6-8l-6-6m-6 6l6-6"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ============================================================================
// Toolbar key definitions
// ============================================================================

interface ToolbarKey {
  label: string;
  value: string;
  isModifier?: boolean;
  modifierType?: "ctrl" | "alt";
  icon?: React.ComponentType<{
    size: number;
    color: string;
    strokeWidth: number;
  }>;
}

const TOOLBAR_KEYS: ToolbarKey[] = [
  { label: "Esc", value: "\x1b" },
  { label: "Tab", value: "\t" },
  { label: "Ctrl", value: "", isModifier: true, modifierType: "ctrl" },
  { label: "Alt", value: "", isModifier: true, modifierType: "alt" },
  { label: "↑", value: "\x1b[A", icon: ArrowUp },
  { label: "↓", value: "\x1b[B", icon: ArrowDown },
  { label: "←", value: "\x1b[D", icon: ArrowLeft },
  { label: "→", value: "\x1b[C", icon: ArrowRight },
  { label: "Bksp", value: "\x7f" },
  { label: "Enter", value: "\r" },
  { label: "Home", value: "\x1b[H" },
  { label: "End", value: "\x1b[F" },
  { label: "PgUp", value: "\x1b[5~" },
  { label: "PgDn", value: "\x1b[6~" },
];

// ============================================================================
// Color mapping
// ============================================================================

const ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function resolveColor(
  colorSpec: string,
  type: "fg" | "bg",
  terminalColors: Record<string, string>,
): string {
  if (colorSpec === "default") {
    return type === "fg" ? terminalColors.fg : terminalColors.bg;
  }
  const idx = parseInt(colorSpec, 10);
  if (!isNaN(idx) && idx >= 0 && idx <= 15) {
    return terminalColors[ANSI_COLOR_KEYS[idx]] || terminalColors.fg;
  }
  // Hex color passthrough
  if (colorSpec.startsWith("#")) {
    return colorSpec;
  }
  return type === "fg" ? terminalColors.fg : terminalColors.bg;
}

// ============================================================================
// Terminal row span grouping (performance optimization)
// ============================================================================

interface Span {
  text: string;
  cells: number;
  fg: string;
  bg: string;
  attrs: number;
  x: number;
}

function groupCellsIntoSpans(
  row: TerminalCell[],
  rowIndex: number,
  cursorX: number,
  cursorY: number,
  cursorStyle: number,
  terminalColors: Record<string, string>,
  reverseVideo: boolean,
): Span[] {
  const spans: Span[] = [];
  let current: Span | null = null;

  const defaultFg = reverseVideo ? terminalColors.bg : terminalColors.fg;
  const defaultBg = reverseVideo ? terminalColors.fg : terminalColors.bg;

  for (let x = 0; x < row.length; x++) {
    const cell = row[x];
    const isCursor = x === cursorX && rowIndex === cursorY;
    const attrs = cell.attrs || 0;

    // Block cursor (styles 0, 1, 2) inverts fg/bg; underline/bar cursors use underline decoration
    const isBlockCursor = isCursor && cursorStyle <= 2;

    let fg: string;
    let bg: string;
    if (isBlockCursor) {
      fg = defaultBg;
      bg = terminalColors.cursor;
    } else {
      fg = resolveColor(cell.fg, "fg", terminalColors);
      bg = resolveColor(cell.bg, "bg", terminalColors);
      if (reverseVideo) {
        // Swap only default colors in reverse video mode
        if (cell.fg === "default") fg = defaultFg;
        if (cell.bg === "default") bg = defaultBg;
      }
    }

    // Merge underline cursor into attrs for rendering
    let effectiveAttrs = attrs;
    if (isCursor && !isBlockCursor) {
      effectiveAttrs |= ATTR_UNDERLINE;
    }

    if (
      current &&
      current.fg === fg &&
      current.bg === bg &&
      current.attrs === effectiveAttrs
    ) {
      current.text += cell.char || " ";
      current.cells += 1;
    } else {
      current = {
        text: cell.char || " ",
        cells: 1,
        fg,
        bg,
        attrs: effectiveAttrs,
        x,
      };
      spans.push(current);
    }
  }

  return spans;
}

function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  if (color.startsWith("#")) {
    if (color.length === 7) {
      const channel = Math.max(0, Math.min(255, Math.round(alpha * 255)))
        .toString(16)
        .padStart(2, "0");
      return `${color}${channel}`;
    }
    if (color.length === 9) {
      const channel = Math.max(0, Math.min(255, Math.round(alpha * 255)))
        .toString(16)
        .padStart(2, "0");
      return `${color.slice(0, 7)}${channel}`;
    }
  }
  return color;
}

// ============================================================================
// TerminalRow component
// ============================================================================

const TerminalRow = memo(
  ({
    row,
    rowIndex,
    cursorX,
    cursorY,
    cursorStyle,
    terminalColors,
    reverseVideo,
  }: {
    row: TerminalCell[];
    rowIndex: number;
    cursorX: number;
    cursorY: number;
    cursorStyle: number;
    terminalColors: Record<string, string>;
    reverseVideo: boolean;
  }) => {
    const spans = groupCellsIntoSpans(
      row,
      rowIndex,
      cursorX,
      cursorY,
      cursorStyle,
      terminalColors,
      reverseVideo,
    );

    const bgColor = reverseVideo ? terminalColors.fg : terminalColors.bg;

    return (
      <View style={{ height: LINE_HEIGHT, flexDirection: "row", overflow: "hidden" }}>
        {spans.map((span, i) => {
          const isBold = (span.attrs & ATTR_BOLD) !== 0;
          const isDim = (span.attrs & ATTR_DIM) !== 0;
          const isItalic = (span.attrs & ATTR_ITALIC) !== 0;
          const isUnderline = (span.attrs & ATTR_UNDERLINE) !== 0;
          const isStrikethrough = (span.attrs & ATTR_STRIKETHROUGH) !== 0;

          return (
            <View
              key={i}
              style={{
                width: span.cells * CHAR_WIDTH,
                minWidth: span.cells * CHAR_WIDTH,
                overflow: "visible",
                backgroundColor: span.bg !== bgColor ? span.bg : undefined,
              }}
            >
              <Text
                style={{
                  fontFamily: isBold ? MONO_FONT_BOLD : MONO_FONT,
                  fontSize: FONT_SIZE,
                  lineHeight: LINE_HEIGHT,
                  color: span.fg,
                  fontStyle: isItalic ? "italic" : undefined,
                  textDecorationLine:
                    isUnderline && isStrikethrough
                      ? "underline line-through"
                      : isUnderline
                        ? "underline"
                        : isStrikethrough
                          ? "line-through"
                          : undefined,
                  opacity: isDim ? 0.5 : undefined,
                }}
              >
                {span.text}
              </Text>
            </View>
          );
        })}
      </View>
    );
  },
);

// ============================================================================
// TerminalGrid component
// ============================================================================

const TerminalGrid = memo(
  ({
    displayBuffer,
    cursorX,
    cursorY,
    cursorStyle,
    showCursor,
    terminalColors,
    reverseVideo,
  }: {
    displayBuffer: TerminalCell[][];
    cursorX: number;
    cursorY: number;
    cursorStyle: number;
    showCursor: boolean;
    terminalColors: Record<string, string>;
    reverseVideo: boolean;
  }) => {
    const bgColor = reverseVideo ? terminalColors.fg : terminalColors.bg;
    return (
      <View style={{ backgroundColor: bgColor }}>
        {displayBuffer.map((row, y) => (
          <TerminalRow
            key={y}
            row={row}
            rowIndex={y}
            cursorX={showCursor ? cursorX : -1}
            cursorY={showCursor ? cursorY : -1}
            cursorStyle={cursorStyle || 0}
            terminalColors={terminalColors}
            reverseVideo={reverseVideo}
          />
        ))}
      </View>
    );
  },
);
TerminalGrid.displayName = "TerminalGrid";

const SkiaTerminalGrid = memo(
  ({
    displayBuffer,
    cursorX,
    cursorY,
    cursorStyle,
    showCursor,
    terminalColors,
    reverseVideo,
    width,
    height,
  }: {
    displayBuffer: TerminalCell[][];
    cursorX: number;
    cursorY: number;
    cursorStyle: number;
    showCursor: boolean;
    terminalColors: Record<string, string>;
    reverseVideo: boolean;
    width: number;
    height: number;
  }) => {
    const regularFont = useFont(MONO_FONT_ASSET, FONT_SIZE);
    const boldFont = useFont(MONO_FONT_BOLD_ASSET, FONT_SIZE);
    const bgColor = reverseVideo ? terminalColors.fg : terminalColors.bg;

    const rows = useMemo(
      () =>
        displayBuffer.map((row, y) =>
          groupCellsIntoSpans(
            row,
            y,
            showCursor ? cursorX : -1,
            showCursor ? cursorY : -1,
            cursorStyle,
            terminalColors,
            reverseVideo,
          ),
        ),
      [
        cursorStyle,
        cursorX,
        cursorY,
        displayBuffer,
        reverseVideo,
        showCursor,
        terminalColors,
      ],
    );

    if (!regularFont || !boldFont) {
      return (
        <TerminalGrid
          displayBuffer={displayBuffer}
          cursorX={cursorX}
          cursorY={cursorY}
          cursorStyle={cursorStyle}
          showCursor={showCursor}
          terminalColors={terminalColors}
          reverseVideo={reverseVideo}
        />
      );
    }

    return (
      <Canvas style={{ width, height }}>
        <Rect x={0} y={0} width={width} height={height} color={bgColor} />
        {rows.map((spans, rowIndex) => {
          const textY = rowIndex * LINE_HEIGHT + FONT_SIZE;
          const lineY = rowIndex * LINE_HEIGHT;
          return (
            <Group key={rowIndex}>
              {spans.map((span, spanIndex) => {
                const x = span.x * CHAR_WIDTH;
                const spanWidth = span.cells * CHAR_WIDTH;
                const isBold = (span.attrs & ATTR_BOLD) !== 0;
                const isDim = (span.attrs & ATTR_DIM) !== 0;
                const isUnderline = (span.attrs & ATTR_UNDERLINE) !== 0;
                const isStrikethrough = (span.attrs & ATTR_STRIKETHROUGH) !== 0;
                const fgColor = withAlpha(span.fg, isDim ? 0.5 : 1);
                const font = isBold ? boldFont : regularFont;

                return (
                  <Group key={`${rowIndex}-${spanIndex}`}>
                    {span.bg !== bgColor ? (
                      <Rect
                        x={x}
                        y={lineY}
                        width={spanWidth}
                        height={LINE_HEIGHT}
                        color={span.bg}
                      />
                    ) : null}
                    <SkiaText
                      x={x}
                      y={textY}
                      text={span.text}
                      font={font}
                      color={fgColor}
                    />
                    {isUnderline ? (
                      <Rect
                        x={x}
                        y={lineY + LINE_HEIGHT - 2}
                        width={spanWidth}
                        height={1}
                        color={fgColor}
                      />
                    ) : null}
                    {isStrikethrough ? (
                      <Rect
                        x={x}
                        y={lineY + LINE_HEIGHT * 0.52}
                        width={spanWidth}
                        height={1}
                        color={fgColor}
                      />
                    ) : null}
                  </Group>
                );
              })}
            </Group>
          );
        })}
      </Canvas>
    );
  },
);
SkiaTerminalGrid.displayName = "SkiaTerminalGrid";

// ============================================================================
// Virtual Scrollbar
// ============================================================================

const MIN_THUMB_HEIGHT = 24;
const SCROLLBAR_ZONE_WIDTH = 40;
const THUMB_WIDTH_IDLE = 6;
const THUMB_WIDTH_ACTIVE = 16;
const SCROLL_DEBOUNCE_MS = 32;

const VirtualScrollbar = memo(
  ({
    scrollbackLength,
    visibleRows,
    scrollOffset,
    onScrollOffsetChange,
    trackHeight,
    terminalColors,
  }: {
    scrollbackLength: number;
    visibleRows: number;
    scrollOffset: number;
    onScrollOffsetChange: (offset: number) => void;
    trackHeight: number;
    terminalColors: Record<string, string>;
  }) => {
    const maxOffset = scrollbackLength;
    const totalLines = scrollbackLength + visibleRows;
    const thumbRatio = Math.min(1, visibleRows / totalLines);
    const thumbHeight = Math.max(MIN_THUMB_HEIGHT, trackHeight * thumbRatio);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);

    const thumbY = useSharedValue(
      maxOffset > 0
        ? (1 - scrollOffset / maxOffset) * maxThumbTop
        : maxThumbTop,
    );
    const thumbWidth = useSharedValue(THUMB_WIDTH_IDLE);
    const dragStartY = useSharedValue(0);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastEmittedOffset = useRef(scrollOffset);

    // Sync thumbY when scrollOffset changes externally (new content, snap-to-bottom)
    useEffect(() => {
      thumbY.value =
        maxOffset > 0
          ? (1 - scrollOffset / maxOffset) * maxThumbTop
          : maxThumbTop;
    }, [scrollOffset, maxOffset, maxThumbTop]);

    const emitOffset = useCallback(
      (newThumbY: number) => {
        const clampedY = Math.max(0, Math.min(maxThumbTop, newThumbY));
        const scrollFraction = maxThumbTop > 0 ? 1 - clampedY / maxThumbTop : 0;
        const newOffset = Math.round(scrollFraction * maxOffset);
        if (newOffset === lastEmittedOffset.current) return;
        lastEmittedOffset.current = newOffset;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          onScrollOffsetChange(newOffset);
        }, SCROLL_DEBOUNCE_MS);
      },
      [maxThumbTop, maxOffset, onScrollOffsetChange],
    );

    const jumpToY = useCallback(
      (absoluteY: number) => {
        // Center thumb on tap position
        const targetY = Math.max(
          0,
          Math.min(maxThumbTop, absoluteY - thumbHeight / 2),
        );
        thumbY.value = targetY;
        emitOffset(targetY);
      },
      [maxThumbTop, thumbHeight, emitOffset],
    );

    const tapGesture = useMemo(
      () =>
        Gesture.Tap()
          .onBegin(() => {
            thumbWidth.value = withSpring(THUMB_WIDTH_ACTIVE, {
              damping: 20,
              stiffness: 300,
            });
          })
          .onEnd((event) => {
            runOnJS(jumpToY)(event.y);
          })
          .onFinalize(() => {
            thumbWidth.value = withSpring(THUMB_WIDTH_IDLE, {
              damping: 20,
              stiffness: 300,
            });
          }),
      [jumpToY],
    );

    const panGesture = useMemo(
      () =>
        Gesture.Pan()
          .onStart(() => {
            dragStartY.value = thumbY.value;
            thumbWidth.value = withSpring(THUMB_WIDTH_ACTIVE, {
              damping: 20,
              stiffness: 300,
            });
          })
          .onUpdate((event) => {
            const newY = dragStartY.value + event.translationY;
            thumbY.value = Math.max(0, Math.min(maxThumbTop, newY));
            runOnJS(emitOffset)(thumbY.value);
          })
          .onEnd(() => {
            thumbWidth.value = withSpring(THUMB_WIDTH_IDLE, {
              damping: 20,
              stiffness: 300,
            });
          })
          .onFinalize(() => {
            thumbWidth.value = withSpring(THUMB_WIDTH_IDLE, {
              damping: 20,
              stiffness: 300,
            });
          }),
      [maxThumbTop, emitOffset],
    );

    const composedGesture = useMemo(
      () => Gesture.Race(panGesture, tapGesture),
      [panGesture, tapGesture],
    );

    const thumbAnimatedStyle = useAnimatedStyle(() => ({
      transform: [{ translateY: thumbY.value }],
      width: thumbWidth.value,
      borderRadius: thumbWidth.value / 2,
    }));

    if (scrollbackLength === 0) return null;

    return (
      <GestureDetector gesture={composedGesture}>
        <Animated.View
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: SCROLLBAR_ZONE_WIDTH,
            height: trackHeight,
          }}
        >
          <View
            style={{
              position: "absolute",
              right: 1,
              top: 0,
              bottom: 0,
              width: THUMB_WIDTH_IDLE,
              backgroundColor: terminalColors.fg + "10",
              borderRadius: THUMB_WIDTH_IDLE / 2,
            }}
          />
          <Animated.View
            style={[
              {
                position: "absolute",
                right: 1,
                top: 0,
                height: thumbHeight,
                backgroundColor: terminalColors.fg + "50",
              },
              thumbAnimatedStyle,
            ]}
          />
        </Animated.View>
      </GestureDetector>
    );
  },
);

// ============================================================================
// Terminal Toolbar
// ============================================================================

const TerminalToolbar = memo(
  ({
    colors,
    fonts,
    ctrlActive,
    altActive,
    onKeyPress,
    onToggleKeyboard,
    keyboardVisible,
    onToggleMicInput,
    micInputOpen,
    micWave,
    onCancelMicInput,
    onSendMicInput,
    micInputLoading,
    micDurationMs,
    onToggleQuickInput,
    quickInputOpen,
    quickInputText,
    onQuickInputTextChange,
    onSendQuickInput,
    quickInputRef,
  }: {
    colors: any;
    fonts: any;
    ctrlActive: boolean;
    altActive: boolean;
    onKeyPress: (key: ToolbarKey) => void;
    onToggleKeyboard?: () => void;
    keyboardVisible?: boolean;
    onToggleMicInput?: () => void;
    micInputOpen?: boolean;
    micWave: number[];
    onCancelMicInput?: () => void;
    onSendMicInput?: () => void;
    micInputLoading?: boolean;
    micDurationMs?: number;
    onToggleQuickInput?: () => void;
    quickInputOpen?: boolean;
    quickInputText: string;
    onQuickInputTextChange: (text: string) => void;
    onSendQuickInput: () => void;
    quickInputRef: React.RefObject<TextInput | null>;
  }) => {
    const toolbarVerticalPadding = keyboardVisible ? 6 : 8;
    const [quickInputFocused, setQuickInputFocused] = useState(false);

    const leftButtonStyle = ({
      pressed,
      active,
    }: {
      pressed: boolean;
      active?: boolean;
    }) => ({
      width: 42,
      height: 42,
      borderRadius: 9,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: pressed
        ? colors.bg.raised
        : active
          ? colors.accent.default + "22"
          : colors.bg.raised,
    });

    return (
      <View
        style={{
          backgroundColor: colors.bg.base,
          borderTopWidth: (micInputOpen || quickInputOpen) ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border.secondary,
          paddingHorizontal: 10,
          paddingTop: toolbarVerticalPadding,
          paddingBottom: toolbarVerticalPadding,
          position: "relative",
        }}
      >
        {/* Keyboard dismiss button — absolute top-right above quick input, only when focused */}
        {quickInputOpen && keyboardVisible && (
          <View style={{ position: "absolute", bottom: "100%", right: 10, marginBottom: 14, zIndex: 100 }}>
            <TouchableOpacity
              onPress={() => quickInputRef.current?.blur()}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.bg.raised,
                borderColor: colors.border.secondary,
                borderWidth: 0.5,
                borderRadius: 999,
                width: 45,
                height: 45,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <KeyboardIcon size={22} color={colors.fg.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        )}

        {/* Quick input — capsule that grows as user types */}
        {quickInputOpen && (
          <View
            style={{
              backgroundColor: colors.bg.raised,
              borderRadius: 26,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.fg.disabled,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.08,
              shadowRadius: 10,
              elevation: 3,
              flexDirection: "row",
              alignItems: "flex-end",
              overflow: "hidden",
            }}
          >
            {/* Text input — paddingVertical centers single line, grows upward as user types */}
            <TextInput
              ref={quickInputRef}
              style={{
                flex: 1,
                fontFamily: fonts.sans.regular,
                fontSize: 16,
                color: colors.fg.default,
                paddingHorizontal: 16,
                paddingVertical: 16,
                maxHeight: 160,
              }}
              multiline
              scrollEnabled
              value={quickInputText}
              onChangeText={onQuickInputTextChange}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              spellCheck={false}
              placeholderTextColor={colors.fg.muted + "88"}
              placeholder="Type..."
              onFocus={() => setQuickInputFocused(true)}
              onBlur={() => setQuickInputFocused(false)}
            />

            {/* Buttons — always pinned to bottom */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 12,
                paddingRight: 6,
                paddingBottom: 6,
                gap: 6,
              }}
            >
              <TouchableOpacity
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.bg.base,
                }}
                onPress={onToggleQuickInput}
                activeOpacity={0.7}
              >
                <X size={20} color={colors.fg.muted} strokeWidth={1.8} />
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: quickInputText.trim() ? colors.accent.default : colors.bg.raised,
                  borderWidth: quickInputText.trim() ? 0 : StyleSheet.hairlineWidth,
                  borderColor: colors.fg.subtle + "50",
                }}
                onPress={onSendQuickInput}
                activeOpacity={0.7}
              >
                <SendIcon
                  size={22}
                  color={quickInputText.trim() ? '#ffffff' : colors.fg.muted}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Voice capsule — in-flow, replaces toolbar row when mic is open */}
        {micInputOpen && (
          <View
            style={{
              backgroundColor: colors.bg.raised,
              borderRadius: 9999,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.fg.disabled,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.08,
              shadowRadius: 10,
              elevation: 3,
              paddingHorizontal: 7,
              flexDirection: "row",
              alignItems: "center",
              minHeight: 52,
            }}
          >
            {/* Cancel */}
            <TouchableOpacity
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.bg.base,
              }}
              onPress={onCancelMicInput}
              activeOpacity={0.7}
            >
              <X size={18} color={colors.fg.default} />
            </TouchableOpacity>

            {/* Waveform */}
            <View
              style={{
                flex: 1,
                height: 40,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 8,
                gap: 2,
              }}
            >
              {micWave.map((level, idx) => {
                const activeLevel = Math.max(0, (level - MIC_WAVE_IDLE_LEVEL) / (1 - MIC_WAVE_IDLE_LEVEL));
                const barHeight = MIC_WAVE_DOT_SIZE + activeLevel * MIC_WAVE_MAX_EXTRA_HEIGHT;
                return (
                  <View
                    key={`mic-wave-${idx}`}
                    style={{
                      width: MIC_WAVE_DOT_SIZE,
                      height: barHeight,
                      borderRadius: 9999,
                      backgroundColor: colors.fg.default,
                    }}
                  />
                );
              })}
            </View>

            {/* Timer */}
            <Text style={{ color: colors.fg.muted, fontFamily: MONO_FONT, fontSize: 13, marginRight: 10, marginLeft: 2 }}>
              {formatMicDuration(micDurationMs ?? 0)}
            </Text>

            {/* Send */}
            <TouchableOpacity
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accent.default,
                borderWidth: 0.5,
                borderColor: colors.border.secondary,
              }}
              onPress={onSendMicInput}
              disabled={!!micInputLoading}
              activeOpacity={0.7}
            >
              {micInputLoading ? (
                <ActivityIndicator size="small" color={'#ffffff'} />
              ) : (
                <Check size={22} color={'#ffffff'} strokeWidth={2.5} />
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Main toolbar row — only rendered when neither mic nor quick input is open */}
        {!micInputOpen && !quickInputOpen && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Pressable
                onPress={onToggleKeyboard}
                disabled={!onToggleKeyboard}
                style={({ pressed }) =>
                  leftButtonStyle({ pressed, active: !!keyboardVisible })
                }
              >
                <KeyboardIcon
                  size={17}
                  color={keyboardVisible ? colors.accent.default : colors.fg.muted}
                  strokeWidth={1.8}
                />
              </Pressable>
              <Pressable
                onPress={onToggleMicInput}
                style={({ pressed }) =>
                  leftButtonStyle({ pressed, active: !!micInputOpen })
                }
              >
                <Mic
                  size={17}
                  color={micInputOpen ? colors.accent.default : colors.fg.muted}
                  strokeWidth={2}
                />
              </Pressable>
              <Pressable
                onPress={onToggleQuickInput}
                style={({ pressed }) =>
                  leftButtonStyle({ pressed, active: !!quickInputOpen })
                }
              >
                <CornerDownLeft
                  size={17}
                  color={quickInputOpen ? colors.accent.default : colors.fg.muted}
                  strokeWidth={2}
                />
              </Pressable>
            </View>

            <View style={{ flex: 1, minWidth: 0 }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={{ gap: 6, paddingRight: 2 }}
              >
                {TOOLBAR_KEYS.map((key) => {
                  const isActive =
                    (key.modifierType === "ctrl" && ctrlActive) ||
                    (key.modifierType === "alt" && altActive);
                  const iconColor = isActive
                    ? colors.accent.default
                    : key.isModifier
                      ? colors.fg.muted
                      : colors.fg.default;

                  return (
                    <Pressable
                      key={key.label}
                      onPress={() => onKeyPress(key)}
                      style={({ pressed }) => ({
                        height: 42,
                        minWidth: 46,
                        borderRadius: 9,
                        alignItems: "center",
                        justifyContent: "center",
                        paddingHorizontal: 10,
                        backgroundColor: pressed
                          ? colors.bg.raised
                          : isActive
                            ? colors.accent.default + "22"
                            : colors.bg.raised,
                      })}
                    >
                      {key.icon ? (
                        <key.icon size={18} color={iconColor} strokeWidth={2.5} />
                      ) : (
                        <Text
                          style={{
                            fontSize: 13,
                            fontFamily: fonts.sans.medium,
                            color: iconColor,
                          }}
                        >
                          {key.label}
                        </Text>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        )}

      </View>
    );
  },
);

// ============================================================================
// Key mapping
// ============================================================================

function mapSpecialKey(key: string, appCursorKeys: boolean): string | null {
  // In application cursor keys mode, arrows send ESC O instead of ESC [
  const csi = appCursorKeys ? "\x1bO" : "\x1b[";
  switch (key) {
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return csi + "A";
    case "ArrowDown":
      return csi + "B";
    case "ArrowRight":
      return csi + "C";
    case "ArrowLeft":
      return csi + "D";
    default:
      return null;
  }
}

// ============================================================================
// Tab types
// ============================================================================

interface TerminalTab extends BaseTab {
  terminalId?: string;
  exited?: boolean;
  exitCode?: number;
}

// ============================================================================
// AnimatedTerminalTab (reused from original)
// ============================================================================

const AnimatedTerminalTab = memo(
  ({
    tab,
    isActive,
    isLast,
    showDivider,
    targetWidth,
    colors,
    onPress,
    onClose,
    isNew,
    showIcon = true,
  }: {
    tab: TerminalTab;
    isActive: boolean;
    isLast: boolean;
    showDivider: boolean;
    targetWidth: number;
    colors: any;
    onPress: () => void;
    onClose: () => void;
    isNew: boolean;
    showIcon?: boolean;
  }) => {
    const { fonts } = useTheme();
    const width = useSharedValue(isNew ? 0 : targetWidth);
    const opacity = useSharedValue(isNew ? 0 : 1);

    useEffect(() => {
      width.value = withSpring(targetWidth, springConfig);
      opacity.value = withSpring(1, springConfig);
    }, [targetWidth]);

    const animatedStyle = useAnimatedStyle(() => ({
      width: width.value,
      opacity: opacity.value,
    }));

    const handlePress = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    };

    const handleClose = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onClose();
    };

    return (
      <Animated.View style={[animatedStyle, { overflow: "hidden", height: "100%" }]}>
        <TouchableOpacity
          onPress={handlePress}
          activeOpacity={0.8}
          style={{
            height: "100%",
            paddingLeft: 12,
            paddingRight: 8,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: isActive ? colors.bg.base : "transparent",
            borderRightWidth: isLast ? 0 : 0.5,
            borderRightColor: colors.bg.raised,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 6 }}>
            {showIcon ? (
              <Terminal
                size={14}
                color={isActive ? colors.fg.default : colors.fg.muted}
                strokeWidth={2}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                fontSize: 13,
                fontFamily: isActive ? fonts.sans.semibold : fonts.sans.regular,
                color: isActive ? colors.fg.default : colors.fg.muted,
                flex: 1,
              }}
            >
              {tab.title}
              {tab.exited ? ` [${tab.exitCode ?? "?"}]` : ""}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleClose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={13} color={isActive ? colors.fg.default : colors.fg.muted} strokeWidth={2} />
          </TouchableOpacity>
        </TouchableOpacity>
      </Animated.View>
    );
  },
);

// ============================================================================
// Main Panel
// ============================================================================

export default function TerminalPanel({
  instanceId,
  isActive,
  bottomBarHeight,
}: PluginPanelProps) {
  const { colors, radius, fonts } = useTheme();
  const headerHeight = usePluginHeaderHeight();
  const { status } = useConnection();
  const isConnected = status === "connected";
  const { register, unregister } = useSessionRegistryActions();
  const { bottom: bottomInset } = useSafeAreaInsets();

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 });
  const [cursorVisible, setCursorVisible] = useState(true);
  const [, setActiveTerminalVersion] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const processedLengthRef = useRef(0);
  const scrollOffsetRef = useRef<Map<string, number>>(new Map());
  const terminalStatesRef = useRef<Map<string, TerminalState>>(new Map());
  const [, setScrollRenderKey] = useState(0);
  const ctrlActiveRef = useRef(false);
  const altActiveRef = useRef(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [quickInputVisible, setQuickInputVisible] = useState(false);
  const [micInputVisible, setMicInputVisible] = useState(false);
  const [micInputLoading, setMicInputLoading] = useState(false);
  const [quickInputText, setQuickInputText] = useState("");
  const quickInputRef = useRef<TextInput>(null);
  const micRecordingRef = useRef<Audio.Recording | null>(null);
  const [micWave, setMicWave] = useState<number[]>(
    () => Array.from({ length: MIC_WAVE_BAR_COUNT }, () => MIC_WAVE_IDLE_LEVEL)
  );
  const latestMicLevelRef = useRef(MIC_WAVE_IDLE_LEVEL);
  const micWaveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [micDurationMs, setMicDurationMs] = useState(0);

  const updateMicEqualizer = useCallback((metering?: number) => {
    const normalized = typeof metering === "number"
      ? Math.max(0, Math.min(1, (metering + 40) / 40))
      : MIC_WAVE_IDLE_LEVEL;
    const gated = normalized < 0.25 ? 0 : normalized;
    latestMicLevelRef.current = Math.max(
      MIC_WAVE_IDLE_LEVEL,
      Math.min(1, gated * (0.9 + Math.random() * 0.2))
    );
  }, []);

  const resetMicEqualizer = useCallback(() => {
    latestMicLevelRef.current = MIC_WAVE_IDLE_LEVEL;
    setMicWave(Array.from({ length: MIC_WAVE_BAR_COUNT }, () => MIC_WAVE_IDLE_LEVEL));
  }, []);

  const terminalColors = colors.terminal as Record<string, string>;

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const keyboardHeightSV = useSharedValue(0);

  useKeyboardHandler(
    {
      onMove: e => {
        "worklet";
        keyboardHeightSV.value = e.height;
      },
      onStart: e => {
        "worklet";
        runOnJS(setKeyboardVisible)(e.height > 0);
      },
      onEnd: e => {
        "worklet";
        keyboardHeightSV.value = e.height;
        runOnJS(setKeyboardHeight)(e.height);
      },
    },
    [],
  );

  // Reset input states on new connection
  const prevIsConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !prevIsConnectedRef.current) {
      setQuickInputVisible(false);
      setMicInputVisible(false);
      setCtrlActive(false);
      setAltActive(false);
      ctrlActiveRef.current = false;
      altActiveRef.current = false;
    }
    prevIsConnectedRef.current = isConnected;
  }, [isConnected]);

  // Cursor blink
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(interval);
  }, []);

  // useTerminal hook
  const { spawn, write, resize, kill, scroll } = useTerminal({
    onState: (terminalId, state) => {
      terminalStatesRef.current.set(terminalId, state);
      const activeTab = tabs.find((tab) => tab.id === activeTabId);

      if (activeTab?.terminalId === terminalId) {
        setActiveTerminalVersion((version) => version + 1);
      }

      if (state.title) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.terminalId === terminalId && tab.title !== state.title
              ? { ...tab, title: state.title }
              : tab,
          ),
        );
      }
    },
    onExit: (terminalId, code) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.terminalId === terminalId
            ? { ...t, exited: true, exitCode: code }
            : t,
        ),
      );
      setActiveTerminalVersion((version) => version + 1);
    },
  });

  // Calculate terminal dimensions from container size
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const cols = Math.max(
      10,
      Math.floor((width - TERMINAL_PADDING - TERMINAL_PADDING_RIGHT) / CHAR_WIDTH) - 1,
    );
    const rows = Math.max(
      4,
      Math.floor((height - TERMINAL_PADDING * 2) / LINE_HEIGHT),
    );
    setDimensions((prev) => {
      if (prev.cols === cols && prev.rows === rows) return prev;
      return { cols, rows };
    });
  }, []);

  // Resize all active terminals when dimensions change
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.terminalId && !tab.exited) {
        resize(tab.terminalId, dimensions.cols, dimensions.rows).catch(
          () => {},
        );
      }
    }
  }, [dimensions.cols, dimensions.rows]);

  const getTabWidth = useCallback(() => 120, []);

  const createNewTab = useCallback(async () => {
    if (!isConnected) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const newId = Date.now().toString();
    const newTab: TerminalTab = {
      id: newId,
      title: "Terminal",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setQuickInputVisible(false);
    setQuickInputText("");
    if (micRecordingRef.current) {
      micRecordingRef.current.stopAndUnloadAsync().catch(() => {});
      micRecordingRef.current = null;
    }
    if (micWaveIntervalRef.current) {
      clearInterval(micWaveIntervalRef.current);
      micWaveIntervalRef.current = null;
    }
    setMicInputVisible(false);
    resetMicEqualizer();

    try {
      const terminalId = await spawn({
        cols: dimensionsRef.current.cols,
        rows: dimensionsRef.current.rows,
      });
      setTabs((prev) =>
        prev.map((t) => (t.id === newId ? { ...t, terminalId } : t)),
      );
      // Auto-focus to bring up keyboard for new terminal
      setTimeout(() => focusInput(), 200);
    } catch (err) {
      console.error("Failed to spawn terminal:", err);
      setTabs((prev) => prev.filter((t) => t.id !== newId));
    }
  }, [isConnected, spawn]);

  const closeTab = useCallback(
    async (tabId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Stop mic if running
      if (micRecordingRef.current) {
        micRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        micRecordingRef.current = null;
      }
      if (micWaveIntervalRef.current) {
        clearInterval(micWaveIntervalRef.current);
        micWaveIntervalRef.current = null;
      }
      setMicInputVisible(false);
      setQuickInputVisible(false);
      setQuickInputText("");
      resetMicEqualizer();

      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.terminalId) {
        scrollOffsetRef.current.delete(tab.terminalId);
        terminalStatesRef.current.delete(tab.terminalId);
        if (!tab.exited) {
          try {
            await kill(tab.terminalId);
          } catch {}
        }
      }

      const newTabs = tabs.filter((t) => t.id !== tabId);
      setTabs(newTabs);

      if (activeTabId === tabId) {
        if (newTabs.length > 0) {
          const index = tabs.findIndex((t) => t.id === tabId);
          const newActiveTab = newTabs[Math.max(0, index - 1)];
          setActiveTabId(newActiveTab.id);
        } else {
          setActiveTabId("");
        }
      }
    },
    [tabs, activeTabId, kill],
  );

  // Keyboard input
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTerminalState = activeTab?.terminalId
    ? terminalStatesRef.current.get(activeTab.terminalId)
    : undefined;
  const controlsBottomOffset =
    keyboardHeight > 0
      ? Math.max(
          0,
          keyboardHeight -
            bottomBarHeight +
            (Platform.OS === "ios" ? 0 : bottomInset),
        )
      : FLOATING_CONTROLS_REST_BOTTOM;
  const hasBottomControls = !!(tabs.length > 0 && activeTab && !activeTab.exited);
  const controlsReserve = hasBottomControls
    ? TOOLBAR_RESERVED_HEIGHT +
      (quickInputVisible ? QUICK_INPUT_RESERVED_HEIGHT : 0) +
      controlsBottomOffset
    : 0;
  const floatingControlsAnimatedStyle = useAnimatedStyle(() => {
    if (keyboardHeightSV.value > 0) {
      return { bottom: Math.max(0, keyboardHeightSV.value - bottomBarHeight + (Platform.OS === "ios" ? 0 : bottomInset)) };
    }
    return { bottom: FLOATING_CONTROLS_REST_BOTTOM };
  });

  // Snap to bottom when user types (standard terminal UX)
  const snapToBottom = useCallback(() => {
    if (!activeTab?.terminalId) return;
    const offset = scrollOffsetRef.current.get(activeTab.terminalId) || 0;
    if (offset > 0) {
      scrollOffsetRef.current.set(activeTab.terminalId, 0);
      scroll(activeTab.terminalId, 0);
      setScrollRenderKey((k) => k + 1);
    }
  }, [activeTab?.terminalId, scroll]);

  const handleKeyPress = useCallback(
    (e: { nativeEvent: { key: string } }) => {
      const key = e.nativeEvent.key;
      const appCursorKeys = activeTerminalState?.appCursorKeys || false;
      const mapped = mapSpecialKey(key, appCursorKeys);
      if (activeTab?.terminalId && mapped && !activeTab.exited) {
        snapToBottom();
        write(activeTab.terminalId, mapped);
      }
    },
    [
      activeTab?.terminalId,
      activeTab?.exited,
      activeTerminalState?.appCursorKeys,
      write,
      snapToBottom,
    ],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      if (activeTab?.terminalId && !activeTab.exited) {
        snapToBottom();
        const newChars = text.slice(processedLengthRef.current);
        if (newChars) {
          let dataToSend = newChars;
          if (ctrlActiveRef.current) {
            const code = newChars.charAt(0).toLowerCase().charCodeAt(0) - 96;
            if (code >= 1 && code <= 26) {
              dataToSend = String.fromCharCode(code) + newChars.slice(1);
            }
            ctrlActiveRef.current = false;
            setCtrlActive(false);
          } else if (altActiveRef.current) {
            dataToSend = "\x1b" + newChars;
            altActiveRef.current = false;
            setAltActive(false);
          } else if (newChars.length > 1 && activeTerminalState?.bracketedPaste) {
            // Multi-char input is likely a paste — wrap with bracketed paste sequences
            dataToSend = "\x1b[200~" + newChars + "\x1b[201~";
          }
          write(activeTab.terminalId, dataToSend);
        }
      }
      processedLengthRef.current = text.length;
      if (text.length > 100) {
        processedLengthRef.current = 0;
        inputRef.current?.setNativeProps({ text: "" });
      }
    },
    [
      activeTab?.terminalId,
      activeTab?.exited,
      activeTerminalState?.bracketedPaste,
      write,
      snapToBottom,
    ],
  );

  const handleSubmit = useCallback(() => {
    if (activeTab?.terminalId && !activeTab.exited) {
      snapToBottom();
      write(activeTab.terminalId, "\r");
    }
  }, [activeTab?.terminalId, activeTab?.exited, write, snapToBottom]);

  const handleToolbarKey = useCallback(
    (key: ToolbarKey) => {
      if (!activeTab?.terminalId || activeTab.exited) return;

      if (key.isModifier) {
        if (key.modifierType === "ctrl") {
          const next = !ctrlActiveRef.current;
          ctrlActiveRef.current = next;
          setCtrlActive(next);
          altActiveRef.current = false;
          setAltActive(false);
        } else if (key.modifierType === "alt") {
          const next = !altActiveRef.current;
          altActiveRef.current = next;
          setAltActive(next);
          ctrlActiveRef.current = false;
          setCtrlActive(false);
        }
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }

      let data = key.value;

      // Remap arrow key toolbar values for application cursor keys mode
      const appCK = activeTerminalState?.appCursorKeys;
      if (appCK) {
        if (data === "\x1b[A") data = "\x1bOA";
        else if (data === "\x1b[B") data = "\x1bOB";
        else if (data === "\x1b[C") data = "\x1bOC";
        else if (data === "\x1b[D") data = "\x1bOD";
      }

      if (ctrlActiveRef.current && data.length === 1) {
        const code = data.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) {
          data = String.fromCharCode(code);
        }
        ctrlActiveRef.current = false;
        setCtrlActive(false);
      } else if (altActiveRef.current) {
        data = "\x1b" + data;
        altActiveRef.current = false;
        setAltActive(false);
      }

      snapToBottom();
      write(activeTab.terminalId, data);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [activeTab?.terminalId, activeTab?.exited, activeTerminalState?.appCursorKeys, write, snapToBottom],
  );

  // Focus input when terminal is tapped
  // On Android, .focus() on an already-focused input with hidden keyboard does nothing,
  // so we blur first to force the keyboard to reappear
  const focusInput = useCallback(() => {
    if (Platform.OS === "android") {
      inputRef.current?.blur();
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      inputRef.current?.focus();
    }
  }, []);

  // Toggle keyboard visibility
  const toggleKeyboard = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (keyboardVisible) {
      Keyboard.dismiss();
    } else {
      focusInput();
    }
  }, [keyboardVisible, focusInput]);

  // Quick input
  const sendQuickInput = useCallback(() => {
    if (!activeTab?.terminalId || activeTab.exited) return;
    if (!quickInputText.trim()) return;
    snapToBottom();
    write(activeTab.terminalId, quickInputText + "\r");
    setQuickInputText("");
  }, [activeTab?.terminalId, activeTab?.exited, quickInputText, write, snapToBottom]);


  const toggleQuickInput = useCallback(() => {
    if (quickInputVisible) {
      setQuickInputText("");
      if (keyboardVisible) {
        inputRef.current?.focus();
      } else {
        Keyboard.dismiss();
      }
      setQuickInputVisible(false);
    } else {
      setMicInputVisible(false);
      setQuickInputVisible(true);
      setTimeout(() => quickInputRef.current?.focus(), 50);
    }
  }, [quickInputVisible, keyboardVisible]);

  const startMicRecording = useCallback(async () => {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Microphone Permission Required",
        "This app uses the microphone so you can speak commands instead of typing in the terminal. Voice is sent to our servers for transcription only — we don't store or log it. Please enable microphone access in Settings to use this feature."
      );
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    const recording = new Audio.Recording();
    recording.setProgressUpdateInterval(100);
    recording.setOnRecordingStatusUpdate((status) => {
      if (!status.isRecording) {
        latestMicLevelRef.current = MIC_WAVE_IDLE_LEVEL;
        return;
      }
      setMicDurationMs(status.durationMillis ?? 0);
      updateMicEqualizer(typeof status.metering === "number" ? status.metering : undefined);
    });
    await recording.prepareToRecordAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    } as Audio.RecordingOptions);
    await recording.startAsync();
    setMicDurationMs(0);
    micRecordingRef.current = recording;
  }, [updateMicEqualizer]);

  const stopMicRecording = useCallback(async (): Promise<string | null> => {
    const recording = micRecordingRef.current;
    if (!recording) return null;
    micRecordingRef.current = null;
    if (micWaveIntervalRef.current) {
      clearInterval(micWaveIntervalRef.current);
      micWaveIntervalRef.current = null;
    }
    try {
      await recording.stopAndUnloadAsync();
    } catch {
      // noop
    }
    recording.setOnRecordingStatusUpdate(null);
    const uri = recording.getURI();
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
    } catch {
      // noop
    }
    resetMicEqualizer();
    return uri;
  }, [resetMicEqualizer]);

  const toggleMicInput = useCallback(() => {
    if (micInputVisible) {
      setMicInputVisible(false);
      stopMicRecording().catch(() => {});
      inputRef.current?.focus();
    } else {
      setQuickInputVisible(false);
      setMicInputVisible(true);
      startMicRecording().catch((err) => {
        console.error("Terminal mic start error:", err);
        setMicInputVisible(false);
      });
    }
  }, [micInputVisible, startMicRecording, stopMicRecording]);

  const cancelMicInput = useCallback(() => {
    setMicInputVisible(false);
    stopMicRecording().catch(() => {});
    inputRef.current?.focus();
  }, [stopMicRecording]);

  const sendMicInput = useCallback(async () => {
    if (micInputLoading) return;
    setMicInputLoading(true);
    try {
      if (!TERMINAL_TRANSCRIBE_ENDPOINT) {
        throw new Error("Voice transcription is not configured in this self-hosted build.");
      }
      const uri = await stopMicRecording();
      if (!uri) {
        return;
      }
      const audioBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const res = await fetch(TERMINAL_TRANSCRIBE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: audioBase64 }),
      });
      if (!res.ok) {
        throw new Error(`Transcription failed (${res.status})`);
      }
      const data = (await res.json()) as { text?: string };
      const transcribed = (data.text || "").trim();
      setMicInputVisible(false);
      if (transcribed) {
        setQuickInputText(transcribed);
        setQuickInputVisible(true);
        setTimeout(() => quickInputRef.current?.focus(), 50);
      } else {
        inputRef.current?.focus();
      }
    } catch (err) {
      console.error("Terminal voice transcription error:", err);
    } finally {
      setMicInputLoading(false);
    }
  }, [micInputLoading, stopMicRecording]);

  // Drive the waveform from real metering while mic is open
  useEffect(() => {
    if (micInputVisible) {
      resetMicEqualizer();
      if (micWaveIntervalRef.current) clearInterval(micWaveIntervalRef.current);
      micWaveIntervalRef.current = setInterval(() => {
        const next = latestMicLevelRef.current;
        setMicWave((prev) => {
          const shifted = prev.slice(1);
          shifted.push(next);
          return shifted;
        });
      }, 100);
    } else if (micWaveIntervalRef.current) {
      clearInterval(micWaveIntervalRef.current);
      micWaveIntervalRef.current = null;
    }
  }, [micInputVisible, resetMicEqualizer]);

  useEffect(() => {
    return () => {
      if (micRecordingRef.current) {
        micRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        micRecordingRef.current = null;
      }
      if (micWaveIntervalRef.current) {
        clearInterval(micWaveIntervalRef.current);
        micWaveIntervalRef.current = null;
      }
    };
  }, []);

  const renderTerminalTab = useCallback(
    (
      tab: TerminalTab,
      isActive: boolean,
      isLast: boolean,
      showDivider: boolean,
      targetWidth: number,
      onPress: () => void,
      onClose: () => void,
      isNew: boolean,
    ) => (
      <AnimatedTerminalTab
        tab={tab}
        isActive={isActive}
        isLast={isLast}
        showDivider={showDivider}
        targetWidth={targetWidth}
        colors={colors}
        onPress={onPress}
        onClose={onClose}
        isNew={isNew}
        showIcon={false}
      />
    ),
    [colors],
  );

  useEffect(() => {
    register('terminal', {
      sessions: tabs,
      activeSessionId: activeTabId || null,
      onSessionPress: setActiveTabId,
      onSessionClose: closeTab,
      onCreateSession: createNewTab,
    });
  }, [tabs, activeTabId, register, closeTab, createNewTab]);

  useEffect(() => () => unregister('terminal'), [unregister]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      {/* Header */}
      <PluginHeader
        title={activeTab?.title || "Terminal"}
        colors={colors}
        showBottomBorder={tabs.length > 0}
      />

      {/* Hidden keyboard input */}
      <TextInput
        ref={inputRef}
        style={{
          position: "absolute",
          opacity: 0,
          height: 1,
          width: 1,
          top: -100,
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        keyboardType={
          Platform.OS === "ios" ? "ascii-capable" : "visible-password"
        }
        returnKeyType="default"
        blurOnSubmit={false}
        multiline={false}
        onKeyPress={handleKeyPress}
        onChangeText={handleChangeText}
        onSubmitEditing={handleSubmit}
      />

      {/* Terminal Content */}
      <View style={{ flex: 1, paddingTop: headerHeight, paddingBottom: controlsReserve }}>
        {tabs.length === 0 ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 20,
            }}
          >
            <View style={{ alignItems: "center", gap: 8 }}>
              <Terminal size={48} color={colors.fg.muted} strokeWidth={1.5} />
              <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                {isConnected ? "No terminals open" : "Not connected"}
              </Text>
            </View>
            {isConnected && (
              <TouchableOpacity
                onPress={createNewTab}
                style={{
                  alignItems: "center",
                  backgroundColor: colors.bg.raised,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 10,
                }}
              >
                <Text
                  style={{
                    color: colors.fg.default,
                    fontSize: 14,
                    fontFamily: fonts.sans.medium,
                  }}
                >
                  Open New Terminal
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          tabs.map((tab) => {
            const terminalState = tab.terminalId
              ? terminalStatesRef.current.get(tab.terminalId)
              : undefined;

            return (
            <View
              key={tab.id}
              style={{
                flex: 1,
                display: activeTabId === tab.id ? "flex" : "none",
              }}
            >
              <TouchableOpacity
                activeOpacity={1}
                onPress={focusInput}
                style={{ flex: 1 }}
              >
                <View
                  onLayout={onLayout}
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    backgroundColor: terminalColors.bg,
                  }}
                >
                  {terminalState ? (
                    <View style={{ flex: 1, overflow: "hidden", paddingLeft: TERMINAL_PADDING, paddingTop: TERMINAL_PADDING, paddingBottom: TERMINAL_PADDING }}>
                      <SkiaTerminalGrid
                        displayBuffer={terminalState.buffer}
                        cursorX={terminalState.cursorX}
                        cursorY={terminalState.cursorY}
                        cursorStyle={terminalState.cursorStyle || 0}
                        showCursor={
                          cursorVisible &&
                          !tab.exited &&
                          terminalState.cursorVisible !== false
                        }
                        terminalColors={terminalColors}
                        reverseVideo={terminalState.reverseVideo || false}
                        width={Math.max(0, dimensions.cols * CHAR_WIDTH)}
                        height={Math.max(0, dimensions.rows * LINE_HEIGHT)}
                      />
                      {terminalState.scrollbackLength > 0 && (
                        <View
                          style={{
                            position: "absolute",
                            right: 0,
                            top: 0,
                            width: SCROLLBAR_ZONE_WIDTH,
                            height: dimensions.rows * LINE_HEIGHT,
                          }}
                          onStartShouldSetResponder={() => true}
                        >
                          <VirtualScrollbar
                            scrollbackLength={terminalState.scrollbackLength}
                            visibleRows={dimensions.rows}
                            scrollOffset={
                              scrollOffsetRef.current.get(
                                tab.terminalId || "",
                              ) || 0
                            }
                            onScrollOffsetChange={(offset) => {
                              scrollOffsetRef.current.set(
                                tab.terminalId || "",
                                offset,
                              );
                              if (tab.terminalId) {
                                scroll(tab.terminalId, offset);
                              }
                              setScrollRenderKey((k) => k + 1);
                            }}
                            trackHeight={dimensions.rows * LINE_HEIGHT}
                            terminalColors={terminalColors}
                          />
                        </View>
                      )}
                    </View>
                  ) : (
                    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
                      {tab.exited ? (
                        <Text
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: FONT_SIZE,
                            color: terminalColors.fg,
                            opacity: 0.5,
                          }}
                        >
                          {`Process exited with code ${tab.exitCode ?? "?"}`}
                        </Text>
                      ) : (
                        <Loading color={terminalColors.fg} />
                      )}
                    </View>
                  )}
                </View>
                <View style={{ width: TERMINAL_PADDING_RIGHT, backgroundColor: terminalColors.bg }} />
              </TouchableOpacity>
            </View>
            );
          })
        )}
      </View>

      {hasBottomControls && (
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 0,
              right: 0,
            },
            floatingControlsAnimatedStyle,
          ]}
        >
          {/* Toolbar — always visible at the bottom, above the keyboard */}
          <TerminalToolbar
            colors={colors}
            fonts={fonts}
            ctrlActive={ctrlActive}
            altActive={altActive}
            onKeyPress={handleToolbarKey}
            onToggleKeyboard={toggleKeyboard}
            keyboardVisible={keyboardVisible}
            onToggleMicInput={toggleMicInput}
            micInputOpen={micInputVisible}
            micWave={micWave}
            onCancelMicInput={cancelMicInput}
            onSendMicInput={sendMicInput}
            micInputLoading={micInputLoading}
            micDurationMs={micDurationMs}
            onToggleQuickInput={toggleQuickInput}
            quickInputOpen={quickInputVisible}
            quickInputText={quickInputText}
            onQuickInputTextChange={setQuickInputText}
            onSendQuickInput={sendQuickInput}
            quickInputRef={quickInputRef}
          />
        </Animated.View>
      )}
    </View>
  );
}
