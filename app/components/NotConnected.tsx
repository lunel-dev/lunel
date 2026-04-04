import React from 'react';
import { Text, View } from 'react-native';
import { ThemeColors } from '@/constants/themes';

interface NotConnectedProps {
  colors: ThemeColors;
  fonts: any;
}

export default function NotConnected({ colors, fonts }: NotConnectedProps) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{
        fontSize: 20,
        fontFamily: fonts.sans.semibold,
        color: colors.fg.default,
        letterSpacing: 0.5,
      }}>
        No active connection
      </Text>
      <Text style={{
        fontSize: 12,
        fontFamily: fonts.sans.regular,
        color: colors.fg.subtle,
        marginTop: 4,
        letterSpacing: 0.3,
        textAlign: 'center',
      }}>
        Choose a server in Settings, start your CLI session, then connect from the home screen.
      </Text>
    </View>
  );
}
