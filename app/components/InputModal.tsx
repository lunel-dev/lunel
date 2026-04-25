import { useTheme } from "@/contexts/ThemeContext";
import { typography } from "@/constants/themes";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import ReAnimated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

type InputModalProps = {
  visible: boolean;
  onCancel: () => void;
  onAccept: (value: string) => void;
  title: string;
  description?: string;
  placeholder?: string;
  acceptLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
};

export default function InputModal({
  visible,
  onCancel,
  onAccept,
  title,
  description,
  placeholder,
  acceptLabel,
  cancelLabel,
  initialValue = "",
}: InputModalProps) {
  const { fonts, colors, spacing, radius } = useTheme();
  const [value, setValue] = useState(initialValue);
  const [modalVisible, setModalVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);

  useEffect(() => {
    if (visible) {
      setValue(initialValue);
      setModalVisible(true);
      opacity.value = withTiming(1, { duration: 180 });
      scale.value = withTiming(1, { duration: 180 });
      setTimeout(() => inputRef.current?.focus(), 200);
    } else {
      opacity.value = withTiming(0, { duration: 150 });
      scale.value = withTiming(0.95, { duration: 150 });
      setTimeout(() => setModalVisible(false), 160);
    }
  }, [visible, initialValue]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const dialogStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const handleAccept = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAccept(value);
  };

  const handleCancel = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onCancel();
  };

  if (!modalVisible) return null;

  return (
    <Modal visible animationType="none" transparent onRequestClose={onCancel}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <TouchableWithoutFeedback onPress={handleCancel}>
          <ReAnimated.View style={[styles.overlay, backdropStyle]}>
            <TouchableWithoutFeedback>
              <ReAnimated.View
                style={[
                  styles.dialog,
                  {
                    backgroundColor: colors.bg.base,
                    borderRadius: Platform.OS === "ios" ? 18 : radius.xl,
                    marginHorizontal: spacing[6],
                    maxWidth: 360,
                    alignSelf: "center",
                    width: "100%",
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.border.secondary,
                  },
                  dialogStyle,
                ]}
              >
                <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[5], paddingBottom: spacing[4] }}>
                  <Text style={[styles.title, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                    {title}
                  </Text>
                  {description ? (
                    <Text style={[styles.description, { color: colors.fg.muted, fontFamily: fonts.sans.regular }]}>
                      {description}
                    </Text>
                  ) : null}

                  <TextInput
                    ref={inputRef}
                    value={value}
                    onChangeText={setValue}
                    placeholder={placeholder}
                    placeholderTextColor={colors.fg.muted}
                    onSubmitEditing={handleAccept}
                    returnKeyType="done"
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.bg.raised,
                        borderRadius: Platform.OS === "ios" ? 12 : radius.lg,
                        color: colors.fg.default,
                        fontFamily: fonts.sans.regular,
                        paddingHorizontal: spacing[4],
                        paddingVertical: Platform.OS === "ios" ? spacing[3] : spacing[3] + 2,
                        marginTop: spacing[4],
                        fontSize: typography.body,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: colors.border.secondary,
                      },
                    ]}
                  />
                </View>

                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary }} />
                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    onPress={handleCancel}
                    style={[
                      styles.button,
                      { backgroundColor: "transparent" },
                    ]}
                  >
                    <Text style={[styles.buttonText, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
                      {cancelLabel}
                    </Text>
                  </TouchableOpacity>

                  <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary }} />
                  <TouchableOpacity
                    onPress={handleAccept}
                    style={[
                      styles.button,
                      { backgroundColor: "transparent" },
                    ]}
                  >
                    <Text style={[styles.buttonText, { color: colors.accent.default, fontFamily: fonts.sans.semibold }]}>
                      {acceptLabel}
                    </Text>
                  </TouchableOpacity>
                </View>
              </ReAnimated.View>
            </TouchableWithoutFeedback>
          </ReAnimated.View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.32)",
    paddingHorizontal: 20,
  },
  dialog: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 28,
    elevation: 10,
    overflow: "hidden",
  },
  title: {
    fontSize: 17,
    textAlign: "center",
  },
  description: {
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 18,
  },
  input: {
    fontSize: typography.body,
  },
  buttonRow: {
    flexDirection: "row",
  },
  button: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontSize: 16,
  },
});
