import { useTheme } from "@/contexts/ThemeContext";
import Entypo from "@expo/vector-icons/Entypo";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useRouter } from "expo-router";
import {
  Bot,
  FolderGit2,
  QrCode,
  Smartphone,
  SquareTerminal,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Image,
  Linking,
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
    description: "Ship from anywhere.",
    color: "#6366f1",
  },
  {
    id: "2",
    Icon: Smartphone as LucideIcon,
    label: "Choose Your Path",
    title: "Two Ways to Use Lunel",
    description: "",
    color: "#6366f1",
  },
  {
    id: "3",
    Icon: Bot as LucideIcon,
    label: "Code Smarter",
    title: "AI-Powered Assistant",
    description:
      "Get intelligent code completions, refactoring suggestions, and an AI chat that understands your codebase.",
    color: "#8b5cf6",
  },
  {
    id: "4",
    Icon: SquareTerminal as LucideIcon,
    label: "Full Shell Access",
    title: "Real Terminal",
    description:
      "A complete terminal emulator with SSH access to your machine, or spin up secure cloud sandboxes instantly.",
    color: "#06b6d4",
  },
  {
    id: "5",
    Icon: FolderGit2 as LucideIcon,
    label: "Complete Workflow",
    title: "Files, Editor & Git",
    description:
      "Browse your file system, edit code with syntax highlighting across 11+ languages, and commit with built-in Git.",
    color: "#10b981",
  },
  {
    id: "6",
    Icon: QrCode as LucideIcon,
    label: "Secure Connection",
    title: "Pair in Seconds",
    description:
      "Scan a QR code to securely connect to your machine. Your code, your environment — always with you.",
    color: "#f59e0b",
  },
];

const midW = Math.round(SCREEN_WIDTH * 0.52);
const midH = Math.round(midW * 16 / 9);
const sideW = Math.round(SCREEN_WIDTH * 0.42);
const sideH = Math.round(sideW * 16 / 9);
const sideOffset = Math.round(SCREEN_WIDTH * 0.20);

function WelcomePage() {
  const { colors, fonts, isDark } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  const giftShake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Phone slide animation
    Animated.loop(
      Animated.sequence([
        Animated.delay(3000),
        Animated.timing(anim, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.delay(800),
        Animated.timing(anim, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();

    // Gift shake: still 2.5s → rapid wiggle → repeat
    Animated.loop(
      Animated.sequence([
        Animated.delay(2500),
        Animated.timing(giftShake, { toValue: 1,  duration: 70, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(giftShake, { toValue: -1, duration: 70, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(giftShake, { toValue: 0,  duration: 70, easing: Easing.linear, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const giftRotate = giftShake.interpolate({ inputRange: [-1, 1], outputRange: ["-18deg", "18deg"] });

  const leftRotate = anim.interpolate({ inputRange: [0, 1], outputRange: ["-8deg", "0deg"] });
  const rightRotate = anim.interpolate({ inputRange: [0, 1], outputRange: ["8deg", "0deg"] });
  const leftX = anim.interpolate({ inputRange: [0, 1], outputRange: [-sideOffset, 0] });
  const rightX = anim.interpolate({ inputRange: [0, 1], outputRange: [sideOffset, 0] });

  return (
    <View style={{ width: SCREEN_WIDTH, flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Pressable
        onPress={() => Linking.openURL("https://github.com/lunel-dev/lunel")}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.bg.raised, marginBottom: 32, opacity: pressed ? 0.6 : 1, borderWidth: 0.5, borderColor: colors.border.main })}
      >
        <FontAwesome name="github" size={14} color={colors.fg.default} />
        <Text style={{ fontSize: 12, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Open Source</Text>
      </Pressable>

      <View style={{ width: SCREEN_WIDTH, height: midH, alignItems: "center", justifyContent: "center", overflow: "visible" }}>
        <Animated.Image
          source={isDark ? require("@/assets/images/onboarding/1/right-dark.png") : require("@/assets/images/onboarding/1/right.png")}
          style={{ position: "absolute", width: sideW, height: sideH, transform: [{ translateX: leftX }, { translateY: 16 }, { rotate: leftRotate }] }}
          resizeMode="contain"
        />
        <Animated.Image
          source={isDark ? require("@/assets/images/onboarding/1/left-dark.png") : require("@/assets/images/onboarding/1/left.png")}
          style={{ position: "absolute", width: sideW, height: sideH, transform: [{ translateX: rightX }, { translateY: 16 }, { rotate: rightRotate }] }}
          resizeMode="contain"
        />
        <Image
          source={isDark ? require("@/assets/images/onboarding/1/middle-dark.png") : require("@/assets/images/onboarding/1/middle.png")}
          style={{ position: "absolute", width: midW, height: midH }}
          resizeMode="contain"
        />
      </View>

      <View style={{ alignItems: "center", paddingHorizontal: 32, gap: 10, marginTop: 24 }}>
        <Text style={{ fontSize: 25, fontFamily: fonts.sans.semibold, color: colors.fg.default, textAlign: "center", lineHeight: 32 }}>
          Lunel
        </Text>
        <Text style={{ fontSize: 14, fontFamily: fonts.sans.regular, color: colors.fg.muted, textAlign: "center", lineHeight: 22, maxWidth: 280, marginTop: -3 }}>
          lunel brings your whole dev environment in your pocket
        </Text>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.bg.raised }}>
            <MaterialCommunityIcons name="shield-lock" size={14} color={colors.fg.default} />
            <Text style={{ fontSize: 12, fontFamily: fonts.sans.medium, color: colors.fg.default }}>End-to-end encryption</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.bg.raised, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}>
            <Animated.View style={{ transform: [{ rotate: giftRotate }] }}>
              <Ionicons name="gift" size={14} color={colors.fg.default} />
            </Animated.View>
            <Text style={{ fontSize: 12, fontFamily: fonts.sans.semibold, color: colors.fg.default }}>Free</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const CONNECT_COLOR = "#8b5cf6";
const CLOUD_COLOR = "#38bdf8";

function ProductModePage() {
  const { colors, fonts, isDark } = useTheme();

  return (
    <View style={{ width: SCREEN_WIDTH, flex: 1, paddingHorizontal: 28 }}>

      {/* Top — heading + tags */}
      <View style={{ paddingTop: 35, marginBottom: 44 }}>
        <Text style={{ fontSize: 25, fontFamily: fonts.sans.semibold, color: colors.fg.default, lineHeight: 32, marginBottom: 4 }}>
          Two ways to ship
        </Text>
        <Text style={{ fontSize: 14, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 22, marginBottom: 16 }}>
          Connect your machine or code straight from the cloud
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.bg.raised }}>
            <Ionicons name="scan-outline" size={13} color={colors.fg.default} />
            <Text style={{ fontSize: 12, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Scan to connect</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.bg.raised }}>
            <Entypo name="cloud" size={13} color={colors.fg.default} />
            <Text style={{ fontSize: 12, fontFamily: fonts.sans.medium, color: colors.fg.default }}>Cloud sandbox</Text>
          </View>
        </View>
      </View>

      {/* Lunel Connect */}
      <View style={{ flexDirection: "row", gap: 18, marginBottom: 36 }}>
        {/* Icon */}
        <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: CONNECT_COLOR + "18", alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="scan-outline" size={24} color={CONNECT_COLOR} />
        </View>

        {/* Content */}
        <View style={{ flex: 1, paddingTop: 4 }}>
          <Text style={{ fontSize: 19, fontFamily: fonts.sans.semibold, color: colors.fg.default, marginBottom: 6 }}>
            Lunel Connect
          </Text>
          <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 21, marginBottom: 14 }}>
            Run one command and scan. Your terminal, editor, and git — all live on your phone. Everything stays on your machine.
          </Text>
          {/* Command pill */}
          <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: CONNECT_COLOR + "12" }}>
            <Ionicons name="terminal-outline" size={12} color={CONNECT_COLOR} />
            <Text style={{ fontFamily: fonts.mono.regular, fontSize: 12, color: CONNECT_COLOR }}>npx lunel-cli</Text>
          </View>
        </View>
      </View>

      {/* Lunel Cloud */}
      <View style={{ flexDirection: "row", gap: 18 }}>
        {/* Icon — no connector below */}
        <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: CLOUD_COLOR + "18", alignItems: "center", justifyContent: "center" }}>
          <Entypo name="cloud" size={24} color={CLOUD_COLOR} />
        </View>

        {/* Content */}
        <View style={{ flex: 1, paddingTop: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Text style={{ fontSize: 19, fontFamily: fonts.sans.semibold, color: colors.fg.default }}>
              Lunel Cloud
            </Text>
            <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: CLOUD_COLOR + "18" }}>
              <Text style={{ fontSize: 9, fontFamily: fonts.sans.semibold, color: CLOUD_COLOR, letterSpacing: 0.6 }}>COMING SOON</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, fontFamily: fonts.sans.regular, color: colors.fg.muted, lineHeight: 21 }}>
            No laptop? No problem. Spin up a secure cloud sandbox instantly — zero setup, code from anywhere.
          </Text>
        </View>
      </View>

    </View>
  );
}

function OnboardingPage({ page }: { page: Page }) {
  const { colors, fonts } = useTheme();
  const { Icon } = page;

  if (page.id === "1") {
    return <WelcomePage />;
  }

  if (page.id === "2") {
    return <ProductModePage />;
  }

  return (
    <View style={{ width: SCREEN_WIDTH, flex: 1 }}>
      <View style={{ alignItems: "center", justifyContent: "center", flex: 1 }}>
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
      </View>

      <View style={{ paddingHorizontal: 36, paddingBottom: 28, alignItems: "center" }}>
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
    </View>
  );
}

export default function OnboardingScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);

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
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
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

      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: Math.max(insets.bottom, 24),
          paddingTop: 8,
          gap: 16,
        }}
      >
        {/* Dot indicators */}
        <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, height: 8, marginBottom: 8 }}>
          {PAGES.map((_, i) => (
            <View
              key={i}
              style={{
                width: i === currentIndex ? 22 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === currentIndex ? colors.accent.default : colors.fg.default + "1a",
              }}
            />
          ))}
        </View>

        <Pressable
          onPress={handleNext}
          style={({ pressed }) => ({
            backgroundColor: colors.accent.default,
            borderRadius: 16,
            paddingVertical: 16,
            alignItems: "center",
            opacity: pressed ? 0.82 : 1,
          })}
        >
          <Text style={{ fontSize: 16, fontFamily: fonts.sans.semibold, color: "#ffffff", letterSpacing: 0.3 }}>
            {isLastPage ? "Get Started" : "Continue"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
