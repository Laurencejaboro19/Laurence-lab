import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { OrderDetail, OrderStatus } from '@/api/types';
import { errorMessage, useApp } from '@/state/AppProvider';
import { Badge, Button, Card, Divider, Notice, Row } from '@/ui/components';
import { ACTIVE_STATUSES, CANCELLABLE, colors, naira, STATUS_LABEL, statusColor, type as t } from '@/ui/theme';
import { when } from '@/ui/time';

const DELIVERY_STEPS: { status: OrderStatus; title: string; body: string }[] = [
  { status: 'PAID', title: 'Payment confirmed', body: 'Paystack told us your payment went through.' },
  { status: 'ACCEPTED', title: 'Kitchen accepted', body: 'Your order is in the queue.' },
  { status: 'PREPARING', title: 'Cooking', body: 'The kitchen is on it.' },
  { status: 'READY', title: 'Packed', body: 'Waiting for the rider.' },
  { status: 'DISPATCHED', title: 'On the way', body: 'The rider has left with your order.' },
  { status: 'DELIVERED', title: 'Delivered', body: 'Enjoy your meal.' },
];
const PICKUP_STEPS = DELIVERY_STEPS.filter((s) => s.status !== 'DISPATCHED').map((s) =>
  s.status === 'READY' ? { ...s, title: 'Ready for pickup', body: 'Come and collect it at the counter.' } : s.status === 'DELIVERED' ? { ...s, title: 'Collected', body: 'Enjoy your meal.' } : s,
);

export default function OrderScreen() {
  const { id, justPlaced, payUrl } = useLocalSearchParams<{ id: string; justPlaced?: string; payUrl?: string }>();
  const { api, mode } = useApp();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api.order(id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the order is moving (payment pending, cooking, on the way).
  const active = order ? ACTIVE_STATUSES.includes(order.status) : true;
  useEffect(() => {
    if (!active) return;
    const every = order?.status === 'PLACED' ? 4_000 : 10_000;
    const h = setInterval(() => void load(), every);
    return () => clearInterval(h);
  }, [active, order?.status, load]);

  const cancel = () => {
    const doIt = async () => {
      setCancelling(true);
      try {
        await api.cancelOrder(id, 'customer_cancelled');
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setCancelling(false);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Cancel this order?')) void doIt();
      return;
    }
    Alert.alert('Cancel this order?', 'If you have already paid, the refund goes back to the same card or account.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel order', style: 'destructive', onPress: () => void doIt() },
    ]);
  };

  const pay = async () => {
    const url = order?.payment?.authorizationUrl ?? payUrl;
    if (!url) return;
    if (Platform.OS === 'web') window.open(url, '_blank', 'noopener');
    else await WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url));
  };

  if (!order) {
    return (
      <View style={{ padding: 20 }}>
        <Stack.Screen options={{ title: 'Order' }} />
        {error ? <Notice tone="error" text={error} /> : <Text style={t.small}>Loading…</Text>}
      </View>
    );
  }

  const steps = order.fulfilment === 'pickup' ? PICKUP_STEPS : DELIVERY_STEPS;
  const reached = steps.findIndex((s) => s.status === order.status);
  const terminalBad = ['CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(order.status);
  const refunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.status);
  const awaitingPayment = order.status === 'PLACED';
  const addr = order.addressSnapshot as { label?: string; text?: string; textAddress?: string; zone?: string } | null;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: order.publicRef }} />
      {justPlaced === '1' && awaitingPayment ? (
        <Notice tone={mode === 'demo' ? 'info' : 'warn'} icon="card" text={mode === 'demo' ? 'Order placed. In the demo, payment confirms itself in a few seconds and the kitchen takes it from there.' : 'Order placed. Finish paying on the Paystack page — this screen updates by itself once the payment lands.'} />
      ) : null}
      {error ? <Notice tone="error" text={error} /> : null}

      <Card>
        <Row between>
          <View>
            <Text style={t.tiny}>Order</Text>
            <Text style={t.h1}>{order.publicRef}</Text>
          </View>
          <Badge label={STATUS_LABEL[order.status]} color={statusColor(order.status)} />
        </Row>
        <Text style={[t.small, { marginTop: 6 }]}>
          {when(order.placedAt)} · {order.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}
          {order.etaMinutes && active && !awaitingPayment ? ` · ETA ~${order.etaMinutes} min` : ''}
        </Text>
        {awaitingPayment && mode === 'live' ? (
          <Button title="Pay now with Paystack" icon="card" onPress={pay} style={{ marginTop: 14 }} />
        ) : null}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <Text style={[t.tiny, { marginBottom: 12 }]}>Progress</Text>
        {terminalBad ? (
          <Row>
            <View style={[s.dot, { backgroundColor: colors.red }]}><Ionicons name="close" size={14} color="#fff" /></View>
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={t.h2}>{STATUS_LABEL[order.status]}</Text>
              <Text style={t.small}>{order.status === 'EXPIRED' ? 'Payment did not arrive in time, so the kitchen released your items.' : order.status === 'REJECTED' ? 'The kitchen could not take this order. Any payment is refunded automatically.' : 'This order was cancelled.'}</Text>
            </View>
          </Row>
        ) : (
          steps.map((st, i) => {
            const done = reached >= i || refunded || order.status === 'DELIVERED';
            const current = reached === i;
            return (
              <View key={st.status} style={{ flexDirection: 'row' }}>
                <View style={{ alignItems: 'center' }}>
                  <View style={[s.dot, done ? { backgroundColor: current ? colors.accent : colors.green } : { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border }]}>
                    {done && !current ? <Ionicons name="checkmark" size={14} color={colors.accentInk} /> : null}
                    {current ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accentInk }} /> : null}
                  </View>
                  {i < steps.length - 1 ? <View style={[s.rail, done && !current && { backgroundColor: colors.green }]} /> : null}
                </View>
                <View style={{ marginLeft: 12, flex: 1, paddingBottom: i < steps.length - 1 ? 18 : 0 }}>
                  <Text style={[t.body, { fontWeight: '700', color: done ? colors.text : colors.muted }]}>{st.title}</Text>
                  <Text style={t.small}>{st.body}</Text>
                </View>
              </View>
            );
          })
        )}
        {refunded ? <View style={{ marginTop: 12 }}><Notice tone="success" text={`${STATUS_LABEL[order.status]} — the money goes back to the card or account you paid with.`} /></View> : null}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <Text style={[t.tiny, { marginBottom: 10 }]}>Items</Text>
        {order.items.map((it) => (
          <Row key={it.id} between style={{ marginBottom: 8 }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={t.body}>{it.quantity}× {it.nameSnapshot}{it.variantSnapshot ? ` (${it.variantSnapshot})` : ''}</Text>
              {it.addonsSnapshot.length ? <Text style={t.small}>+ {it.addonsSnapshot.map((a) => a.name).join(', ')}</Text> : null}
            </View>
            <Text style={t.body}>{naira(it.lineTotalKobo)}</Text>
          </Row>
        ))}
        <Divider />
        <Row between><Text style={t.small}>Subtotal</Text><Text style={t.body}>{naira(order.subtotalKobo)}</Text></Row>
        <Row between style={{ marginTop: 4 }}><Text style={t.small}>Delivery</Text><Text style={t.body}>{naira(order.deliveryFeeKobo)}</Text></Row>
        {order.discountKobo > 0 ? <Row between style={{ marginTop: 4 }}><Text style={[t.small, { color: colors.green }]}>Discount</Text><Text style={[t.body, { color: colors.green }]}>−{naira(order.discountKobo)}</Text></Row> : null}
        <Row between style={{ marginTop: 8 }}><Text style={t.h2}>Total</Text><Text style={t.h2}>{naira(order.totalKobo)}</Text></Row>
        {order.payment ? <Text style={[t.small, { marginTop: 8 }]}>Payment {order.payment.status}{order.payment.mode === 'test' ? ' (test mode)' : ''} · ref {order.payment.reference}</Text> : null}
      </Card>

      {order.fulfilment === 'delivery' && addr ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={[t.tiny, { marginBottom: 6 }]}>Deliver to</Text>
          <Text style={t.h2}>{addr.label ?? 'Address'}</Text>
          {addr.text ?? addr.textAddress ? <Text style={t.small}>{addr.text ?? addr.textAddress}</Text> : null}
          {addr.zone ? <Text style={t.small}>{addr.zone}</Text> : null}
        </Card>
      ) : null}
      {order.customerNote ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={[t.tiny, { marginBottom: 6 }]}>Your note</Text>
          <Text style={t.body}>{order.customerNote}</Text>
        </Card>
      ) : null}

      {CANCELLABLE.includes(order.status) ? (
        <Button title="Cancel order" variant="danger" onPress={cancel} loading={cancelling} style={{ marginTop: 18 }} />
      ) : null}
      <Button title="Back to orders" variant="ghost" onPress={() => router.navigate('/(tabs)/orders')} style={{ marginTop: 10 }} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  dot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rail: { width: 2, flex: 1, backgroundColor: colors.border, marginVertical: 4 },
});
