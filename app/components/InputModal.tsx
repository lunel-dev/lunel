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
                    backgroundColor: colors.bg.raised,
                    borderRadius: radius["2xl"],
                    padding: spacing[5],
                    marginHorizontal: spacing[6],
                  },
                  dialogStyle,
                ]}
              >
                <Text style={[styles.title, { color: colors.fg.default, fontFamily: fonts.sans.bold }]}>
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
                      backgroundColor: colors.bg.base,
                      borderRadius: radius.xl,
                      color: colors.fg.default,
                      fontFamily: fonts.sans.regular,
                      paddingHorizontal: spacing[4],
                      paddingVertical: spacing[4],
                      marginTop: spacing[4],
                      fontSize: typography.body,
                    },
                  ]}
                />

                <View style={[styles.buttonRow, { marginTop: spacing[4], gap: spacing[3] }]}>
                  <TouchableOpacity
                    onPress={handleCancel}
                    style={[
                      styles.button,
                      { backgroundColor: colors.bg.base, borderRadius: radius.xl },
                    ]}
                  >
                    <Text style={[styles.buttonText, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
                      {cancelLabel}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={handleAccept}
                    style={[
                      styles.button,
                      { backgroundColor: colors.bg.subtle ?? colors.bg.base, borderRadius: radius.xl },
                    ]}
                  >
                    <Text style={[styles.buttonText, { color: colors.fg.default, fontFamily: fonts.sans.semibold }]}>
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
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  dialog: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 12,
  },
  title: {
    fontSize: typography.heading,
    fontWeight: "700",
  },
  description: {
    fontSize: typography.body,
    marginTop: 6,
    opacity: 0.75,
  },
  input: {
    fontSize: typography.body,
  },
  buttonRow: {
    flexDirection: "row",
  },
  button: {
    flex: 1,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontSize: typography.body,
    fontWeight: "600",
  },
});
