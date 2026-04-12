import { useTheme } from "@/contexts/ThemeContext";
import { useRouter } from "expo-router";
import {
  Bot,
  FolderGit2,
  QrCode,
  Smartphone,
  SquareTerminal,
} from "lucide-react-native";
import { useRef, useState } from "react";
import {
  Dimensions,
  FlatList,
  Pressable,
  Text,
  View,
  ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type LucideIcon = React.ComponentType<{
  size: number;
  color: string;
  strokeWidth?: number;
}>;

type Page = {
  id: string;
  Icon: LucideIcon;
  label: string;
  title: string;
  description: string;
  color: string;
};

const PAGES: Page[] = [
  {
    id: "1",
    Icon: Smartphone as LucideIcon,
    label: "Your Mobile IDE",
    title: "Welcome to Lunel",
    description:
      "Code on your phone, run on your machine or in secure cloud sandboxes. Full development power in your pocket.",
    color: "#6366f1",
  },
  {
    id: "2",
    Icon: Bot as LucideIcon,
    label: "Code Smarter",
    title: "AI-Powered Assistant",
    description:
      "Get intelligent code completions, refactoring suggestions, and an AI chat that understands your codebase.",
    color: "#8b5cf6",
  },
  {
    id: "3",
    Icon: SquareTerminal as LucideIcon,
    label: "Full Shell Access",
    title: "Real Terminal",
    description:
      "A complete terminal emulator with SSH access to your machine, or spin up secure cloud sandboxes instantly.",
    color: "#06b6d4",
  },
  {
    id: "4",
    Icon: FolderGit2 as LucideIcon,
    label: "Complete Workflow",
    title: "Files, Editor & Git",
    description:
      "Browse your file system, edit code with syntax highlighting across 11+ languages, and commit with built-in Git.",
    color: "#10b981",
  },
  {
    id: "5",
    Icon: QrCode as LucideIcon,
    label: "Secure Connection",
    title: "Pair in Seconds",
    description:
      "Scan a QR code to securely connect to your machine. Your code, your environment — always with you.",
    color: "#f59e0b",
  },
];

function OnboardingPage({ page }: { page: Page }) {
  const { colors, fonts } = useTheme();
  const { Icon } = page;

  return (
    <View
      style={{
        width: SCREEN_WIDTH,
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 36,
      }}
    >
      {/* Icon illustration — two nested circles */}
      <View
        style={{
          width: 176,
          height: 176,
          borderRadius: 88,
          backgroundColor: page.color + "14",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 52,
        }}
      >
        <View
          style={{
            width: 116,
            height: 116,
            borderRadius: 58,
            backgroundColor: page.color + "22",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={50} color={page.color} strokeWidth={1.5} />
        </View>
      </View>

      {/* Label */}
      <Text
        style={{
          fontSize: 11,
          fontFamily: fonts.sans.semibold,
          color: page.color,
          textTransform: "uppercase",
          letterSpacing: 2,
          marginBottom: 14,
          textAlign: "center",
        }}
      >
        {page.label}
      </Text>

      {/* Title */}
      <Text
        style={{
          fontSize: 28,
          fontFamily: fonts.sans.semibold,
          color: colors.fg.default,
          textAlign: "center",
          marginBottom: 16,
          lineHeight: 36,
        }}
      >
        {page.title}
      </Text>

      {/* Description */}
      <Text
        style={{
          fontSize: 15,
          fontFamily: fonts.sans.regular,
          color: colors.fg.muted,
          textAlign: "center",
          lineHeight: 24,
          maxWidth: 296,
        }}
      >
        {page.description}
      </Text>
    </View>
  );
}

export default function OnboardingScreen() {
  const { colors, fonts, radius } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  const currentPage = PAGES[currentIndex];
  const isLastPage = currentIndex === PAGES.length - 1;

  const handleComplete = () => {
    router.replace("/auth");
  };

  const handleNext = () => {
    if (!isLastPage) {
      const nextIndex = currentIndex + 1;
      flatListRef.current?.scrollToIndex({ index: nextIndex, animated: true });
      setCurrentIndex(nextIndex);
    } else {
      handleComplete();
    }
  };

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        setCurrentIndex(viewableItems[0].index);
      }
    }
  ).current;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      {/* Swipeable Pages */}
      <FlatList
        ref={flatListRef}
        data={PAGES}
        renderItem={({ item }) => <OnboardingPage page={item} />}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ viewAreaCoveragePercentThreshold: 50 }}
        style={{ flex: 1 }}
        scrollEventThrottle={16}
      />

      {/* Bottom Controls */}
      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 24),
          paddingTop: 8,
          gap: 16,
        }}
      >
        {/* Page Dot Indicators */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 6,
            height: 8,
          }}
        >
          {PAGES.map((_, i) => (
            <View
              key={i}
              style={{
                width: i === currentIndex ? 22 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor:
                  i === currentIndex
                    ? currentPage.color
                    : colors.fg.default + "1a",
              }}
            />
          ))}
        </View>

        {/* Continue / Get Started Button */}
        <Pressable
          onPress={handleNext}
          style={({ pressed }) => ({
            backgroundColor: currentPage.color,
            borderRadius: radius.md,
            paddingVertical: 16,
            alignItems: "center",
            opacity: pressed ? 0.82 : 1,
          })}
        >
          <Text
            style={{
              fontSize: 16,
              fontFamily: fonts.sans.semibold,
              color: "#ffffff",
              letterSpacing: 0.3,
            }}
          >
            {isLastPage ? "Get Started" : "Continue"}
          </Text>
        </Pressable>

        {/* Skip */}
        {!isLastPage && (
          <Pressable
            onPress={handleComplete}
            style={({ pressed }) => ({
              alignItems: "center",
              paddingVertical: 4,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Text
              style={{
                fontSize: 14,
                fontFamily: fonts.sans.medium,
                color: colors.fg.subtle,
              }}
            >
              Skip for now
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
