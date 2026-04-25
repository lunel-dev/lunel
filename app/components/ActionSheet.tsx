import { useTheme } from "@/contexts/ThemeContext";
import { typography } from "@/constants/themes";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import ReAnimated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

export type ActionSheetOption = {
  label: string;
  destructive?: boolean;
  onPress: () => void;
};

type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  options: ActionSheetOption[];
};

export default function ActionSheet({ visible, onClose, title, options }: ActionSheetProps) {
  const { fonts, colors, spacing, radius } = useTheme();
  const [modalVisible, setModalVisible] = useState(false);
  const translateY = useSharedValue(300);
  const backdropOpacity = useSharedValue(0);
  const hideModal = useCallback(() => setModalVisible(false), []);

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      translateY.value = 300;
      translateY.value = withTiming(0, { duration: 220 });
      backdropOpacity.value = withTiming(1, { duration: 220 });
    } else {
      backdropOpacity.value = withTiming(0, { duration: 180 });
      translateY.value = withTiming(300, { duration: 180 }, () => {
        runOnJS(hideModal)();
      });
    }
  }, [visible, hideModal, translateY, backdropOpacity]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  if (!modalVisible) return null;

  return (
    <Modal visible animationType="none" transparent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <ReAnimated.View style={[styles.overlay, backdropStyle]}>
          <TouchableWithoutFeedback>
            <ReAnimated.View
              style={[
                styles.sheet,
                {
                  backgroundColor: colors.bg.raised,
                  borderTopLeftRadius: radius["2xl"],
                  borderTopRightRadius: radius["2xl"],
                  paddingBottom: 32,
                  paddingHorizontal: spacing[4],
                  paddingTop: spacing[3],
                },
                sheetStyle,
              ]}
            >
              {/* Handle */}
              <View style={[styles.handle, { backgroundColor: colors.fg.default + "26" }]} />

              {title ? (
                <Text style={[styles.title, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
                  {title}
                </Text>
              ) : null}

              {options.map((opt, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onClose();
                    opt.onPress();
                  }}
                  style={[
                    styles.option,
                    {
                      backgroundColor: colors.bg.base,
                      borderRadius: radius.xl,
                      marginBottom: spacing[2],
                      paddingVertical: spacing[4],
                      paddingHorizontal: spacing[4],
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.optionText,
                      {
                        fontFamily: fonts.sans.semibold,
                        color: opt.destructive ? "#ef4444" : colors.fg.default,
                      },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ReAnimated.View>
          </TouchableWithoutFeedback>
        </ReAnimated.View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    overflow: "hidden",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    alignSelf: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: typography.caption,
    textAlign: "center",
    marginBottom: 12,
  },
  option: {
    alignItems: "center",
  },
  optionText: {
    fontSize: typography.body,
  },
});
