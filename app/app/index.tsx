import AsyncStorage from "@react-native-async-storage/async-storage";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

export default function Index() {
  const [target, setTarget] = useState<"/onboarding" | "/auth" | null>(null);

  useEffect(() => {
    AsyncStorage.getItem("@lunel_onboarding_done").then((val) => {
      setTarget(val === "true" ? "/auth" : "/onboarding");
    });
  }, []);

  if (!target) return <View style={{ flex: 1 }} />;
  return <Redirect href={target} />;
}
