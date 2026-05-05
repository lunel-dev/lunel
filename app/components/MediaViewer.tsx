import { useTheme } from "@/contexts/ThemeContext";
import { ArrowLeft } from "lucide-react-native";
import { Image, Modal, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type MediaViewerProps = {
  visible: boolean;
  imageUri: string;
  onClose: () => void;
};

export default function MediaViewer({ visible, imageUri, onClose }: MediaViewerProps) {
  const { colors } = useTheme();
  const { top: topInset } = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.bg.base, justifyContent: "center", alignItems: "center" }}>
        <View
          style={{
            position: "absolute",
            top: topInset + 8,
            left: 16,
            right: 16,
            zIndex: 10,
            alignItems: "flex-start",
          }}
        >
          <Pressable
            onPress={onClose}
            style={{
              width: 40,
              height: 40,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 20,
              backgroundColor: colors.bg.elevated,
            }}
          >
            <ArrowLeft size={20} color={colors.fg.default} strokeWidth={2.2} />
          </Pressable>
        </View>
        <Image
          source={{ uri: imageUri }}
          style={{
            width,
            height: height * 0.78,
          }}
          resizeMode="contain"
        />
      </View>
    </Modal>
  );
}
