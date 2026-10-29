import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppProvider, useApp } from '@/state/AppProvider';
import { colors } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** A strip above everything (never overlapping content) while the kitchen is simulated. */
function DemoRibbon() {
  const { mode } = useApp();
  const insets = useSafeAreaInsets();
  if (mode !== 'demo') return null;
  return (
    <View style={[s.ribbon, { paddingTop: insets.top }]}>
      <Text style={s.ribbonText}>DEMO · simulated kitchen, no real payments</Text>
    </View>
  );
}

function Shell() {
  const { ready } = useApp();
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <View style={s.root}>
      <View style={s.phone}>
        <DemoRibbon />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="item/[id]" options={{ presentation: 'modal', title: '' }} />
          <Stack.Screen name="cart" options={{ title: 'Your cart' }} />
          <Stack.Screen name="checkout" options={{ title: 'Checkout' }} />
          <Stack.Screen name="address/new" options={{ presentation: 'modal', title: 'Delivery address' }} />
          <Stack.Screen name="orders/[id]" options={{ title: 'Order' }} />
        </Stack>
      </View>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Platform.OS === 'web' ? '#070604' : colors.bg, alignItems: 'center' },
  phone: {
    flex: 1,
    width: '100%',
    backgroundColor: colors.bg,
    ...(Platform.OS === 'web'
      ? { maxWidth: 430, borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border }
      : {}),
  },
  ribbon: { backgroundColor: colors.accent, alignItems: 'center', paddingBottom: 4 },
  ribbonText: { color: colors.accentInk, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, paddingTop: 4 },
});
