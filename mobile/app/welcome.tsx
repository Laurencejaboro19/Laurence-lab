import { router } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Field, Notice } from '@/ui/components';
import { colors, type as t } from '@/ui/theme';

const PHONE_RE = /^(\+234|0)[789][01]\d{8}$/;

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { signIn, mode, config } = useApp();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneOk = phone.trim() === '' || PHONE_RE.test(phone.replace(/\s/g, ''));
  const canGo = name.trim().length >= 2 && phoneOk && !busy;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn({ displayName: name.trim(), phone: phone.replace(/\s/g, '') });
      router.replace('/(tabs)');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[s.wrap, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.logo}>
          <Text style={s.logoText}>LL</Text>
        </View>
        <Text style={t.display}>{config?.brand ?? 'Laurence Lab'}</Text>
        <Text style={[t.body, { color: colors.muted, marginTop: 6, marginBottom: 28 }]}>
          Party-style jollof, grilled proteins and cold drinks — delivered across Benin City or ready for pickup.
        </Text>

        {mode === 'demo' ? (
          <Notice tone="warn" icon="flask" text="Demo mode: the kitchen is simulated and nothing is charged. Orders you place here move through every stage on their own." />
        ) : null}

        <Field
          label="Your name"
          placeholder="e.g. Osas"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoComplete="name"
          returnKeyType="next"
        />
        <Field
          label="Phone number (for the rider)"
          placeholder="0803 456 7890"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
          hint={!phoneOk ? 'Enter a valid Nigerian number, e.g. 08031234567' : 'Optional now — needed before your first delivery.'}
        />
        {error ? <Notice tone="error" text={error} /> : null}
        <Button title="Start ordering" onPress={go} disabled={!canGo} loading={busy} icon="arrow-forward" />
        <Text style={[t.small, { textAlign: 'center', marginTop: 16 }]}>
          No password. Your orders stay on this phone; we only use your number to reach you about a delivery.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, flexGrow: 1, justifyContent: 'center' },
  logo: { width: 64, height: 64, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  logoText: { color: colors.accentInk, fontWeight: '900', fontSize: 24, letterSpacing: -1 },
});
