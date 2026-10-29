import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Address, Fulfilment, Zone } from '@/api/types';
import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Card, Field, Notice, Row } from '@/ui/components';
import { colors, naira, radius, type as t } from '@/ui/theme';

export default function CheckoutScreen() {
  const insets = useSafeAreaInsets();
  const { api, cart, mutateCart, refreshCart, config, customer, refreshCustomer, mode } = useApp();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [note, setNote] = useState(cart?.cart.note ?? '');
  const [promo, setPromo] = useState(cart?.cart.promoCode ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<'promo' | 'place' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fulfilment = cart?.cart.fulfilment ?? null;

  const load = useCallback(async () => {
    try {
      const [a, z] = await Promise.all([api.addresses(), api.zones()]);
      setAddresses(a);
      setZones(z);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      void load();
      void refreshCart().catch(() => undefined);
    }, [load, refreshCart]),
  );

  // Default to delivery with the default address the first time through.
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    if (!cart || fulfilment !== null || defaulted) return;
    setDefaulted(true);
    const def = addresses.find((a) => a.isDefault) ?? addresses[0];
    void mutateCart((x) => x.setFulfilment({ fulfilment: 'delivery', ...(def ? { addressId: def.id } : {}) })).catch(() => undefined);
  }, [cart, fulfilment, addresses, mutateCart, defaulted]);

  const choose = async (f: Fulfilment, addressId?: string) => {
    setError(null);
    try {
      await mutateCart((x) => x.setFulfilment({ fulfilment: f, ...(f === 'delivery' && addressId ? { addressId } : {}), ...(note ? { note } : {}) }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const applyPromo = async () => {
    setBusy('promo');
    setError(null);
    try {
      await mutateCart((x) => x.applyPromo(promo.trim() ? promo.trim().toUpperCase() : null));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const needsPhone = !customer?.phoneE164;
  const phoneOk = !needsPhone || /^(\+234|0)[789][01]\d{8}$/.test(phone.replace(/\s/g, ''));

  const place = async () => {
    if (!cart) return;
    setBusy('place');
    setError(null);
    try {
      if (needsPhone) {
        await api.updateMe({ phone: phone.replace(/\s/g, '') });
        await refreshCustomer();
      }
      if (fulfilment) await mutateCart((x) => x.setFulfilment({ fulfilment, ...(cart.cart.addressId ? { addressId: cart.cart.addressId } : {}), note: note.trim() }));
      const result = await api.checkout();
      await refreshCart().catch(() => undefined);
      if (mode === 'demo') {
        router.replace({ pathname: '/orders/[id]', params: { id: result.order.id, justPlaced: '1' } });
        return;
      }
      // Hand off to Paystack. On native the return page deep-links back; on web it stays in the tab.
      if (Platform.OS === 'web') {
        window.open(result.paymentUrl, '_blank', 'noopener');
      } else {
        const redirect = Linking.createURL('/orders');
        await WebBrowser.openAuthSessionAsync(result.paymentUrl, redirect, { preferEphemeralSession: false }).catch(() => undefined);
      }
      router.replace({ pathname: '/orders/[id]', params: { id: result.order.id, justPlaced: '1', payUrl: result.paymentUrl } });
    } catch (err) {
      setError(errorMessage(err));
      await refreshCart().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  if (!cart || cart.cart.lines.length === 0) {
    return (
      <View style={{ padding: 24 }}>
        <Notice text="Your cart is empty." />
        <Button title="Back to menu" variant="secondary" onPress={() => router.navigate('/(tabs)')} />
      </View>
    );
  }

  const problems = cart.problems.filter((p) => !(fulfilment === 'delivery' && cart.cart.addressId && /address/i.test(p) && cart.zone));
  const canPlace = problems.length === 0 && !!fulfilment && phoneOk && busy === null && (config?.storeOpen ?? true);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 170 }} keyboardShouldPersistTaps="handled">
        {config && !config.storeOpen ? <Notice tone="warn" text="We are closed right now. You can still browse; ordering opens with the kitchen." /> : null}
        {error ? <Notice tone="error" text={error} /> : null}

        <Text style={s.label}>How do you want it?</Text>
        <Row style={{ marginBottom: 16 }}>
          <Toggle icon="bicycle" label="Delivery" sub="30–45 min" active={fulfilment === 'delivery'} onPress={() => choose('delivery', cart.cart.addressId ?? addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id)} />
          <View style={{ width: 10 }} />
          <Toggle icon="storefront" label="Pickup" sub="No delivery fee" active={fulfilment === 'pickup'} onPress={() => choose('pickup')} />
        </Row>

        {fulfilment === 'delivery' ? (
          <>
            <Row between style={{ marginBottom: 8 }}>
              <Text style={s.label}>Deliver to</Text>
              <Pressable onPress={() => router.push('/address/new')} hitSlop={8}>
                <Text style={{ color: colors.accent, fontWeight: '700' }}>+ New address</Text>
              </Pressable>
            </Row>
            {addresses.length === 0 ? (
              <Card onPress={() => router.push('/address/new')}>
                <Row>
                  <Ionicons name="location" size={20} color={colors.accent} />
                  <Text style={[t.body, { marginLeft: 10, flex: 1 }]}>Add a delivery address to see your fee and ETA.</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                </Row>
              </Card>
            ) : (
              addresses.map((a) => {
                const zone = zones.find((z) => z.id === a.zoneId);
                const selected = cart.cart.addressId === a.id;
                return (
                  <Pressable key={a.id} onPress={() => choose('delivery', a.id)} style={({ pressed }) => [s.addr, selected && { borderColor: colors.accent, backgroundColor: colors.amberSoft }, pressed && { opacity: 0.85 }]}>
                    <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? colors.accent : colors.faint} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={t.h2}>{a.label}</Text>
                      {a.textAddress ? <Text style={t.small} numberOfLines={2}>{a.textAddress}</Text> : null}
                      <Text style={[t.small, { color: zone ? colors.text : colors.red, marginTop: 2 }]}>
                        {zone ? `${zone.name.replace(/\s—.*/, '')} · ${naira(zone.feeKobo)} · ~${zone.etaMinutes} min` : 'Outside our delivery area'}
                      </Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </>
        ) : null}

        {fulfilment === 'pickup' ? (
          <Card style={{ marginBottom: 6 }}>
            <Row>
              <Ionicons name="storefront" size={20} color={colors.accent} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={t.h2}>Pick up at Laurence Lab</Text>
                <Text style={t.small}>Ugbowo, Benin City · we message you when it is ready.</Text>
              </View>
            </Row>
          </Card>
        ) : null}

        {needsPhone ? (
          <>
            <Text style={[s.label, { marginTop: 18 }]}>Phone number</Text>
            <Field placeholder="0803 456 7890" value={phone} onChangeText={setPhone} keyboardType="phone-pad" hint="The rider or kitchen calls this number if they need you." />
          </>
        ) : null}

        <Text style={[s.label, { marginTop: 12 }]}>Note for the kitchen or rider</Text>
        <Field placeholder="e.g. No pepper. Gate is the blue one." value={note} onChangeText={setNote} multiline numberOfLines={2} style={{ minHeight: 64, textAlignVertical: 'top' }} />

        <Text style={s.label}>Promo code</Text>
        <Row>
          <Field placeholder={mode === 'demo' ? 'Try WELCOME10' : 'Enter a code'} value={promo} onChangeText={setPromo} autoCapitalize="characters" style={{ flex: 1 }} />
          <View style={{ width: 10 }} />
          <Button title={cart.promo ? 'Update' : 'Apply'} variant="secondary" compact onPress={applyPromo} loading={busy === 'promo'} style={{ marginBottom: 14, minHeight: 50 }} />
        </Row>
        {cart.promo ? <Notice tone="success" text={`${cart.promo.code} applied — ${cart.promo.kind === 'percent' ? `${cart.promo.value}% off` : `${naira(cart.promo.value)} off`}.`} /> : null}

        {cart.totals ? (
          <Card>
            <Row between><Text style={t.small}>Subtotal</Text><Text style={t.body}>{naira(cart.totals.subtotalKobo)}</Text></Row>
            <Row between style={{ marginTop: 6 }}><Text style={t.small}>Delivery fee</Text><Text style={t.body}>{fulfilment === 'delivery' && !cart.zone ? '—' : naira(cart.totals.deliveryFeeKobo)}</Text></Row>
            {cart.totals.discountKobo > 0 ? <Row between style={{ marginTop: 6 }}><Text style={[t.small, { color: colors.green }]}>Discount</Text><Text style={[t.body, { color: colors.green }]}>−{naira(cart.totals.discountKobo)}</Text></Row> : null}
            <Row between style={{ marginTop: 10 }}><Text style={t.h2}>Total to pay</Text><Text style={[t.h2, { color: colors.accent }]}>{naira(cart.totals.totalKobo)}</Text></Row>
          </Card>
        ) : null}

        {problems.map((p) => <View key={p} style={{ marginTop: 10 }}><Notice tone="warn" text={cap(p)} /></View>)}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Row style={{ marginBottom: 10 }}>
          <Ionicons name="lock-closed" size={14} color={colors.muted} />
          <Text style={[t.small, { marginLeft: 6 }]}>
            {mode === 'demo' ? 'Demo: payment is simulated.' : `Paid securely through Paystack${config?.paymentMode === 'test' ? ' (test mode — no real charge)' : ''}: card, transfer or USSD.`}
          </Text>
        </Row>
        <Button title={cart.totals ? `Place order · ${naira(cart.totals.totalKobo)}` : 'Place order'} onPress={place} disabled={!canPlace} loading={busy === 'place'} icon="card" />
      </View>
    </View>
  );
}

function Toggle({ icon, label, sub, active, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; sub: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.toggle, active && { borderColor: colors.accent, backgroundColor: colors.amberSoft }, pressed && { opacity: 0.85 }]}>
      <Ionicons name={icon} size={22} color={active ? colors.accent : colors.muted} />
      <Text style={[t.h2, { marginTop: 8 }]}>{label}</Text>
      <Text style={t.small}>{sub}</Text>
    </Pressable>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const s = StyleSheet.create({
  label: { ...t.tiny, marginBottom: 8 },
  toggle: { flex: 1, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  addr: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 8 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border },
});
