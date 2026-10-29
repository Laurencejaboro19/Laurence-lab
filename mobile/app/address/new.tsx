import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { GeoPoint, Zone } from '@/api/types';
import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Field, Notice, Row } from '@/ui/components';
import { colors, naira, radius, type as t } from '@/ui/theme';

export default function NewAddress() {
  const { api, mutateCart } = useApp();
  const [zones, setZones] = useState<Zone[]>([]);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [zoneId, setZoneId] = useState<string | undefined>();
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.zones().then(setZones).catch(() => undefined);
  }, [api]);

  const locate = async () => {
    setLocating(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setError('Location permission was not granted. Pick your area from the list instead.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPoint({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      setZoneId(undefined);
    } catch {
      setError('Could not get your location. Pick your area from the list instead.');
    } finally {
      setLocating(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api.addAddress({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(text.trim() ? { textAddress: text.trim() } : {}),
        ...(point ? { point } : {}),
        ...(!point && zoneId ? { zoneId } : {}),
      });
      await mutateCart((x) => x.setFulfilment({ fulfilment: 'delivery', addressId: a.id })).catch(() => undefined);
      router.back();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canSave = text.trim().length >= 6 && (point !== null || zoneId !== undefined) && !busy;

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {error ? <Notice tone="error" text={error} /> : null}
      <Field label="Label" placeholder="Home, Hostel, Office…" value={label} onChangeText={setLabel} autoCapitalize="words" />
      <Field
        label="Address"
        placeholder="Hall 3, UNIBEN main campus, Ugbowo"
        value={text}
        onChangeText={setText}
        multiline
        style={{ minHeight: 72, textAlignVertical: 'top' }}
        hint="Street, landmark and anything the rider should know."
      />

      <Text style={[t.tiny, { marginBottom: 8 }]}>Delivery area</Text>
      <Pressable onPress={locate} style={({ pressed }) => [s.locate, point && { borderColor: colors.green }, pressed && { opacity: 0.85 }]}>
        <Ionicons name={point ? 'checkmark-circle' : 'navigate'} size={20} color={point ? colors.green : colors.accent} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={t.body}>{point ? 'Location pinned — we will match your zone' : 'Use my current location'}</Text>
          <Text style={t.small}>{point ? `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}` : 'Most accurate fee and ETA'}</Text>
        </View>
        {locating ? <Text style={t.small}>…</Text> : null}
      </Pressable>
      <Text style={[t.small, { textAlign: 'center', marginVertical: 10 }]}>or choose your area</Text>
      {zones.map((z) => {
        const on = !point && zoneId === z.id;
        return (
          <Pressable key={z.id} onPress={() => { setPoint(null); setZoneId(z.id); }} style={({ pressed }) => [s.zone, on && { borderColor: colors.accent, backgroundColor: colors.amberSoft }, pressed && { opacity: 0.85 }]}>
            <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? colors.accent : colors.faint} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={t.h2}>{z.name}</Text>
              <Row>
                <Text style={t.small}>{naira(z.feeKobo)} delivery · ~{z.etaMinutes} min · min. order {naira(z.minOrderKobo)}</Text>
              </Row>
            </View>
          </Pressable>
        );
      })}

      <Button title="Save address" onPress={save} disabled={!canSave} loading={busy} style={{ marginTop: 18 }} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  locate: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  zone: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 8 },
});
