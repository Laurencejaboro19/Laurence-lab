import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage, useApp } from '@/state/AppProvider';
import { Button, Card, Empty, Notice, Row, Stepper } from '@/ui/components';
import { colors, naira, type as t } from '@/ui/theme';

export default function CartScreen() {
  const insets = useSafeAreaInsets();
  const { cart, cartBusy, mutateCart, refreshCart, profile } = useApp();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) refreshCart().catch(() => undefined);
  }, [profile, refreshCart]);

  const lines = cart?.totals?.lines ?? [];
  const cartLines = cart?.cart.lines ?? [];

  const setQty = async (lineId: string, q: number) => {
    setError(null);
    try {
      await mutateCart((api) => api.setLineQuantity(lineId, q));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!profile) {
    return <Empty icon="person-circle-outline" title="Tell us who you are" body="Add your name so we can hold a cart for you." action={<Button title="Get started" onPress={() => router.push('/welcome')} compact />} />;
  }

  if (cartLines.length === 0) {
    return <Empty icon="bag-handle-outline" title="Your cart is empty" body="Add something from the menu and it will show up here." action={<Button title="Browse the menu" onPress={() => router.navigate('/(tabs)')} variant="secondary" compact />} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: 160 }}>
        {error ? <Notice tone="error" text={error} /> : null}
        <Card style={{ paddingVertical: 4 }}>
          {cartLines.map((cl, i) => {
            const priced = lines[i]; // the server prices lines in cart order
            return (
              <View key={cl.id} style={[s.line, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={t.h2}>{priced?.name ?? 'Item'}</Text>
                  {priced?.variantName ? <Text style={t.small}>{priced.variantName}</Text> : null}
                  {priced?.addons.length ? <Text style={t.small}>+ {priced.addons.map((a) => a.name).join(', ')}</Text> : null}
                  <Text style={[t.small, { color: colors.text, marginTop: 4 }]}>{priced ? naira(priced.lineTotalKobo) : ''}</Text>
                </View>
                <Stepper value={cl.quantity} onChange={(q) => setQty(cl.id, q)} busy={cartBusy} />
              </View>
            );
          })}
        </Card>

        <Button title="Add more items" variant="ghost" icon="add" onPress={() => router.navigate('/(tabs)')} style={{ marginTop: 14 }} />

        {cart?.totals ? (
          <Card style={{ marginTop: 14 }}>
            <Row between><Text style={t.small}>Subtotal</Text><Text style={t.body}>{naira(cart.totals.subtotalKobo)}</Text></Row>
            <Row between style={{ marginTop: 6 }}>
              <Text style={t.small}>Delivery</Text>
              <Text style={t.small}>{cart.cart.fulfilment === 'delivery' && cart.zone ? naira(cart.totals.deliveryFeeKobo) : 'set at checkout'}</Text>
            </Row>
            {cart.totals.discountKobo > 0 ? (
              <Row between style={{ marginTop: 6 }}><Text style={[t.small, { color: colors.green }]}>Discount {cart.promo?.code}</Text><Text style={[t.body, { color: colors.green }]}>−{naira(cart.totals.discountKobo)}</Text></Row>
            ) : null}
            <Row between style={{ marginTop: 10 }}>
              <Text style={t.h2}>Total</Text>
              <Text style={t.h2}>{naira(cart.totals.totalKobo)}</Text>
            </Row>
          </Card>
        ) : null}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Button title="Go to checkout" icon="arrow-forward" onPress={() => router.push('/checkout')} disabled={cartBusy} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border },
});
