import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Order } from '@/api/types';
import { errorMessage, useApp } from '@/state/AppProvider';
import { Badge, Button, Card, Empty, Notice, Row } from '@/ui/components';
import { ACTIVE_STATUSES, colors, naira, STATUS_LABEL, statusColor, type as t } from '@/ui/theme';
import { when } from '@/ui/time';

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const { api, profile } = useApp();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      setOrders((await api.orders()).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, profile]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const active = orders.some((o) => ACTIVE_STATUSES.includes(o.status));
      const id = active ? setInterval(() => void load(), 15_000) : null;
      return () => {
        if (id) clearInterval(id);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  const header = (
    <View style={{ paddingTop: insets.top + 12, paddingBottom: 12 }}>
      <Text style={t.h1}>Your orders</Text>
      {error ? <View style={{ marginTop: 12 }}><Notice tone="error" text={error} /></View> : null}
    </View>
  );

  if (!profile) {
    return <View style={{ paddingHorizontal: 16 }}>{header}<Empty icon="receipt-outline" title="No orders yet" body="Set up your name first, then place your first order." action={<Button title="Get started" compact onPress={() => router.push('/welcome')} />} /></View>;
  }

  return (
    <FlatList
      data={orders}
      keyExtractor={(o) => o.id}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={loading && orders.length > 0} onRefresh={load} tintColor={colors.accent} />}
      ListEmptyComponent={loading ? undefined : <Empty icon="receipt-outline" title="No orders yet" body="Your orders and their live status will appear here." action={<Button title="Browse the menu" variant="secondary" compact onPress={() => router.navigate('/(tabs)')} />} />}
      renderItem={({ item: o }) => (
        <Card style={{ marginBottom: 10 }} onPress={() => router.push({ pathname: '/orders/[id]', params: { id: o.id } })}>
          <Row between>
            <Text style={t.h2}>{o.publicRef}</Text>
            <Badge label={STATUS_LABEL[o.status]} color={statusColor(o.status)} />
          </Row>
          <Text style={[t.small, { marginTop: 6 }]} numberOfLines={2}>
            {o.items.map((i) => `${i.quantity}× ${i.nameSnapshot}`).join(', ')}
          </Text>
          <Row between style={{ marginTop: 10 }}>
            <Text style={t.small}>{when(o.placedAt)} · {o.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
            <Text style={[t.body, { fontWeight: '700' }]}>{naira(o.totalKobo)}</Text>
          </Row>
        </Card>
      )}
    />
  );
}


