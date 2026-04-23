import { useTheme } from "@/contexts/ThemeContext";
import { typography } from "@/constants/themes";
import * as Haptics from "expo-haptics";
import { X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import ReAnimated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

type InfoSheetProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: React.ReactNode;
};

export default function InfoSheet({ visible, onClose, title, description, children }: InfoSheetProps) {
  const { fonts, colors } = useTheme();
  const [modalVisible, setModalVisible] = useState(false);
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const backdropOpacity = useSharedValue(0);
  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      translateY.value = SCREEN_HEIGHT;
      translateY.value = withTiming(0, { duration: 200 });
      backdropOpacity.value = withTiming(1, { duration: 200 });
    } else {
      backdropOpacity.value = withTiming(0, { duration: 200 });
      translateY.value = withTiming(SCREEN_HEIGHT, { duration: 200 }, () => {
        runOnJS(hideModal)();
      });
    }
  }, [visible, hideModal, translateY, backdropOpacity]);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 800) {
        translateY.value = withTiming(SCREEN_HEIGHT, { duration: 300 }, () => {
          runOnJS(onClose)();
        });
      } else {
        translateY.value = withTiming(0, { duration: 200 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  if (!modalVisible) return null;

  return (
    <Modal visible animationType="none" transparent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <TouchableWithoutFeedback onPress={onClose}>
            <ReAnimated.View style={[sheetStyles.overlay, backdropStyle]}>
              <TouchableWithoutFeedback>
                <GestureDetector gesture={pan}>
                  <ReAnimated.View style={[sheetStyles.sheet, { backgroundColor: colors.bg.base }, animatedStyle]}>
                    {/* Handle */}
                    <View style={[sheetStyles.handle, { backgroundColor: colors.border.main }]} />

                    {/* Header */}
                    <View style={sheetStyles.header}>
                      <View style={{ flex: 1 }}>
                        <Text style={[sheetStyles.title, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>{title}</Text>
                        <Text style={[sheetStyles.subtitle, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>{description}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          onClose();
                        }}
                        style={[sheetStyles.closeButton, { backgroundColor: colors.bg.raised, borderColor: colors.border.secondary }]}
                      >
                        <X size={20} color={colors.fg.default} strokeWidth={2} />
                      </TouchableOpacity>
                    </View>

                    {/* Content */}
                    {children}
                  </ReAnimated.View>
                </GestureDetector>
              </TouchableWithoutFeedback>
            </ReAnimated.View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 0,
    maxHeight: "80%",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignSelf: "center",
    marginBottom: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  title: {
    fontSize: typography.heading,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  subtitle: {
    fontSize: typography.caption,
    color: "rgba(255,255,255,0.4)",
    marginTop: 3,
  },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
