import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';

import { useApp } from '@/state/AppProvider';
import { colors } from '@/ui/theme';

export default function TabsLayout() {
  const { cartCount } = useApp();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 64, paddingTop: 6 },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginTop: 2 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Menu',
          tabBarIcon: ({ color, size }) => <Ionicons name="restaurant" size={size} color={typeof color === "string" ? color : colors.muted} />,
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: 'Cart',
          tabBarBadge: cartCount > 0 ? cartCount : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent, color: colors.accentInk, fontWeight: '800' },
          tabBarIcon: ({ color, size }) => <Ionicons name="bag-handle" size={size} color={typeof color === "string" ? color : colors.muted} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color, size }) => <Ionicons name="receipt" size={size} color={typeof color === "string" ? color : colors.muted} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size} color={typeof color === "string" ? color : colors.muted} />,
        }}
      />
    </Tabs>
  );
}
