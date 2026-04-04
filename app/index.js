require("@expo/metro-runtime");

const React = require("react");
const Constants = require("expo-constants");
const Linking = require("expo-linking");
const { Platform } = require("react-native");
const { ctx } = require("expo-router/_ctx");
const { ExpoRoot } = require("expo-router/build/ExpoRoot");
const { Head } = require("expo-router/build/head");
const { renderRootComponent } = require("expo-router/build/renderRootComponent");

const fallbackScheme =
  Constants.expoConfig?.scheme ||
  Constants.expoConfig?.ios?.scheme ||
  Constants.expoConfig?.ios?.bundleIdentifier ||
  "lunel";

const originalCreateURL = Linking.createURL.bind(Linking);

Linking.createURL = function patchedCreateURL(path, options) {
  try {
    return originalCreateURL(path, options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("no custom scheme defined")
    ) {
      const normalizedPath = typeof path === "string" ? path : "";
      const cleanPath = normalizedPath.replace(/^\/+/, "");
      return cleanPath ? `${fallbackScheme}://${cleanPath}` : `${fallbackScheme}://`;
    }

    throw error;
  }
};

function App() {
  const initialLocation = Platform.OS === "web" ? undefined : "/auth";

  return React.createElement(
    Head.Provider,
    null,
    React.createElement(ExpoRoot, {
      context: ctx,
      location: initialLocation,
    })
  );
}

renderRootComponent(App);
