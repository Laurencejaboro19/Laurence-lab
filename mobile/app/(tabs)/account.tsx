import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { API_BASE_URL } from '@/api/client';
import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Card, Divider, Field, Notice, Row } from '@/ui/components';
import { colors, type as t } from '@/ui/theme';

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { profile, customer, api, mode, config, signOut, refreshCustomer, setForceDemo } = useApp();
  const [phone, setPhone] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [forceDemo, setForceDemoLocal] = useState(mode === 'demo');

  useFocusEffect(
    useCallback(() => {
      refreshCustomer().catch(() => undefined);
    }, [refreshCustomer]),
  );

  const savePhone = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.updateMe({ phone: phone.replace(/\s/g, '') });
      await refreshCustomer();
      setEditing(false);
      setMsg({ tone: 'success', text: 'Phone number updated.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    const go = async () => {
      await signOut();
      router.replace('/welcome');
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Start over on this device? Your order history stays on the server but will not show here.')) void go();
      return;
    }
    Alert.alert('Start over?', 'Your order history stays on our side but will not show on this phone.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Start over', style: 'destructive', onPress: () => void go() },
    ]);
  };

  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: 40 }}>
      <Text style={t.h1}>Account</Text>

      <Card style={{ marginTop: 16 }}>
        <Row>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: colors.accentInk, fontWeight: '900', fontSize: 20 }}>{(profile?.displayName ?? 'G').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ marginLeft: 14, flex: 1 }}>
            <Text style={t.h2}>{profile?.displayName ?? 'Guest'}</Text>
            <Text style={t.small}>{customer?.phoneE164 ?? profile?.phone ?? 'No phone number yet'}</Text>
            {customer ? <Text style={t.small}>{customer.orderCount} order{customer.orderCount === 1 ? '' : 's'}</Text> : null}
          </View>
        </Row>
        {!profile ? <Button title="Set up" compact onPress={() => router.push('/welcome')} style={{ marginTop: 14 }} /> : null}
        {profile ? (
          <>
            <Divider />
            {editing ? (
              <>
                <Field label="Phone number" placeholder="0803 456 7890" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
                <Row>
                  <Button title="Save" compact onPress={savePhone} loading={busy} disabled={!/^(\+234|0)[789][01]\d{8}$/.test(phone.replace(/\s/g, ''))} />
                  <Button title="Cancel" compact variant="ghost" onPress={() => setEditing(false)} style={{ marginLeft: 8 }} />
                </Row>
              </>
            ) : (
              <Button title={customer?.phoneE164 ? 'Change phone number' : 'Add phone number'} compact variant="secondary" icon="call" onPress={() => { setPhone(customer?.phoneE164 ?? ''); setEditing(true); }} />
            )}
            {msg ? <View style={{ marginTop: 12 }}><Notice tone={msg.tone} text={msg.text} /></View> : null}
          </>
        ) : null}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <Text style={[t.tiny, { marginBottom: 10 }]}>Laurence Lab</Text>
        <Line icon="time" text="Open daily 9:00 – 21:00" />
        <Line icon="location" text="Ugbowo, Benin City · delivering to Ugbowo, Ekosodin, Uselu, GRA, Ring Road, Sapele Road" />
        <Line icon="chatbubbles" text="Order by chat instead: @LaurencelabBot on Telegram" onPress={() => Linking.openURL('https://t.me/LaurencelabBot')} />
      </Card>

      <Card style={{ marginTop: 12 }}>
        <Text style={[t.tiny, { marginBottom: 10 }]}>About this app</Text>
        <Row between>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={t.body}>Demo mode</Text>
            <Text style={t.small}>Simulated kitchen and payments. Turns itself on when the server is unreachable. Restart the app after changing this.</Text>
          </View>
          <Switch value={forceDemo} onValueChange={async (v) => { setForceDemoLocal(v); await setForceDemo(v); }} trackColor={{ true: colors.accent, false: colors.border }} thumbColor="#fff" />
        </Row>
        <Divider />
        <Text style={t.small}>Mode: {mode === 'live' ? `live (${config?.paymentMode === 'test' ? 'Paystack test' : 'Paystack live'})` : 'demo'}</Text>
        <Text style={t.small}>Server: {API_BASE_URL.replace(/^https?:\/\//, '')}</Text>
        <Text style={t.small}>Version {version} · {Platform.OS}</Text>
      </Card>

      {profile ? <Button title="Start over on this device" variant="ghost" onPress={reset} style={{ marginTop: 18 }} /> : null}
    </ScrollView>
  );
}

function Line({ icon, text, onPress }: { icon: keyof typeof Ionicons.glyphMap; text: string; onPress?: () => void }) {
  return (
    <Row style={{ marginBottom: 10, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={16} color={colors.accent} style={{ marginTop: 2 }} />
      <Text onPress={onPress} style={[t.small, { color: onPress ? colors.accent : colors.text, marginLeft: 10, flex: 1 }]}>{text}</Text>
    </Row>
  );
}
