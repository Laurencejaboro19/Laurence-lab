import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Divider, Notice, Row, Stepper } from '@/ui/components';
import { emojiFor } from '@/ui/food';
import { colors, naira, radius, type as t } from '@/ui/theme';

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { menu, mutateCart, profile } = useApp();
  const item = useMemo(() => menu.flatMap((c) => c.items).find((it) => it.id === id), [menu, id]);
  const [variantId, setVariantId] = useState<string | undefined>(() => item?.variants.find((v) => v.active)?.id);
  const [addons, setAddons] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!item) {
    return (
      <View style={{ padding: 24 }}>
        <Text style={t.body}>This item is no longer on the menu.</Text>
      </View>
    );
  }

  const variant = item.variants.find((v) => v.id === variantId);
  const unit = item.priceKobo + (variant?.priceDeltaKobo ?? 0) + item.addons.filter((a) => addons.includes(a.id)).reduce((sum, a) => sum + a.priceKobo, 0);
  const max = item.available === null ? 20 : Math.max(1, Math.min(20, item.available));

  const add = async () => {
    if (!profile) {
      router.replace('/welcome');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await mutateCart((api) =>
        api.addToCart({ itemId: item.id, quantity: qty, ...(variantId ? { variantId } : {}), ...(addons.length ? { addonIds: addons } : {}) }),
      );
      router.back();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: item.name }} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 140 }}>
        <View style={s.hero}>
          <Text style={{ fontSize: 72 }}>{emojiFor(item)}</Text>
        </View>
        <Text style={t.h1}>{item.name}</Text>
        {item.description ? <Text style={[t.body, { color: colors.muted, marginTop: 6 }]}>{item.description}</Text> : null}
        <Row style={{ marginTop: 10 }}>
          <Text style={[t.h2, { color: colors.accent }]}>{naira(item.priceKobo)}</Text>
          {item.prepMinutes > 0 ? <Text style={[t.small, { marginLeft: 12 }]}>Ready in about {item.prepMinutes} min</Text> : null}
        </Row>

        {item.variants.filter((v) => v.active).length > 0 ? (
          <>
            <Divider />
            <Text style={[t.tiny, { marginBottom: 10 }]}>Size</Text>
            {item.variants
              .filter((v) => v.active)
              .map((v) => (
                <Option key={v.id} label={v.name} price={v.priceDeltaKobo ? `+${naira(v.priceDeltaKobo)}` : 'included'} selected={variantId === v.id} onPress={() => setVariantId(v.id)} radio />
              ))}
          </>
        ) : null}

        {item.addons.filter((a) => a.active).length > 0 ? (
          <>
            <Divider />
            <Text style={[t.tiny, { marginBottom: 10 }]}>Extras</Text>
            {item.addons
              .filter((a) => a.active)
              .map((a) => (
                <Option
                  key={a.id}
                  label={a.name}
                  price={`+${naira(a.priceKobo)}`}
                  selected={addons.includes(a.id)}
                  onPress={() => setAddons((cur) => (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]))}
                />
              ))}
          </>
        ) : null}
        {error ? <View style={{ marginTop: 16 }}><Notice tone="error" text={error} /></View> : null}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Stepper value={qty} min={1} max={max} onChange={setQty} />
        <Button title={`Add · ${naira(unit * qty)}`} onPress={add} loading={busy} style={{ flex: 1, marginLeft: 12 }} />
      </View>
    </View>
  );
}

function Option({ label, price, selected, onPress, radio }: { label: string; price: string; selected: boolean; onPress: () => void; radio?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.option, selected && { borderColor: colors.accent, backgroundColor: colors.amberSoft }, pressed && { opacity: 0.85 }]}>
      <View style={[s.check, radio && { borderRadius: 11 }, selected && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
        {selected ? <View style={[s.checkInner, radio && { borderRadius: 4 }]} /> : null}
      </View>
      <Text style={[t.body, { flex: 1, marginLeft: 12 }]}>{label}</Text>
      <Text style={[t.small, selected && { color: colors.text }]}>{price}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  hero: { height: 160, borderRadius: radius.lg, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  option: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 8 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  checkInner: { width: 8, height: 8, borderRadius: 2, backgroundColor: colors.accentInk },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', padding: 16, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border },
});
