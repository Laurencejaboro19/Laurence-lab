import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MenuItem } from '@/api/types';
import { useApp } from '@/state/AppProvider';
import { emojiFor } from '@/ui/food';
import { Button, Empty, Notice, Pill } from '@/ui/components';
import { colors, naira, radius, type as t } from '@/ui/theme';

export default function MenuScreen() {
  const insets = useSafeAreaInsets();
  const { menu, menuError, refreshMenu, cart, cartCount, config, profile } = useApp();
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<SectionList<MenuItem>>(null);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return menu
      .filter((c) => c.active)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id,
        title: c.name,
        data: c.items.filter(
          (it) =>
            it.active &&
            (!q || it.name.toLowerCase().includes(q) || it.description?.toLowerCase().includes(q) || it.aliases.some((a) => a.includes(q))),
        ),
      }))
      .filter((sec) => sec.data.length > 0);
  }, [menu, query]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshMenu();
    setRefreshing(false);
  };

  const jump = (id: string) => {
    setActiveCat(id);
    const idx = sections.findIndex((sec) => sec.id === id);
    if (idx >= 0) listRef.current?.scrollToLocation({ sectionIndex: idx, itemIndex: 0, viewOffset: 8, animated: true });
  };

  const total = cart?.totals?.subtotalKobo ?? 0;

  return (
    <View style={{ flex: 1 }}>
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <Text style={t.tiny}>{greeting()}{profile ? `, ${profile.displayName.split(' ')[0]}` : ''}</Text>
            <Text style={t.h1}>What are you eating?</Text>
          </View>
          {config && !config.storeOpen ? (
            <View style={s.closed}>
              <Text style={s.closedText}>Closed now</Text>
            </View>
          ) : null}
        </View>
        <View style={s.search}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search jollof, chicken, malt…"
            placeholderTextColor={colors.faint}
            style={s.searchInput}
            returnKeyType="search"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
        {!query ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 4 }}>
            {sections.map((sec) => (
              <Pill key={sec.id} label={sec.title} active={activeCat === sec.id} onPress={() => jump(sec.id)} />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {menuError && menu.length === 0 ? (
        <Empty icon="cloud-offline" title="Menu unavailable" body={menuError} action={<Button title="Try again" onPress={onRefresh} variant="secondary" compact />} />
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(it) => it.id}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: cartCount ? 120 : 32 }}
          onScrollToIndexFailed={() => undefined}
          ListHeaderComponent={menuError ? <Notice tone="warn" text={`Showing the last menu we loaded. ${menuError}`} /> : undefined}
          renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
          renderItem={({ item }) => <ItemCard item={item} />}
          ListEmptyComponent={<Empty icon="search" title="Nothing matches" body="Try a different word, or clear the search." />}
        />
      )}

      {cartCount > 0 ? (
        <Pressable style={[s.cartBar, { bottom: 16 }]} onPress={() => router.push('/cart')}>
          <View style={s.cartCount}>
            <Text style={s.cartCountText}>{cartCount}</Text>
          </View>
          <Text style={s.cartBarText}>View cart</Text>
          <Text style={[s.cartBarText, { marginLeft: 'auto' }]}>{naira(total)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ItemCard({ item }: { item: MenuItem }) {
  const soldOut = item.available !== null && item.available <= 0;
  const from = item.variants.some((v) => v.priceDeltaKobo !== 0);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
      disabled={soldOut}
      style={({ pressed }) => [s.item, pressed && { opacity: 0.9 }, soldOut && { opacity: 0.5 }]}
    >
      <View style={s.thumb}>
        <Text style={{ fontSize: 30 }}>{emojiFor(item)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={t.h2} numberOfLines={1}>{item.name}</Text>
        {item.description ? <Text style={[t.small, { marginTop: 2 }]} numberOfLines={2}>{item.description}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <Text style={s.price}>{from ? 'from ' : ''}{naira(item.priceKobo)}</Text>
          {item.prepMinutes > 0 ? <Text style={[t.small, { marginLeft: 10 }]}>· {item.prepMinutes} min</Text> : null}
          {soldOut ? <Text style={[t.small, { marginLeft: 10, color: colors.red }]}>Sold out</Text> : null}
          {!soldOut && item.available !== null && item.available <= 5 ? <Text style={[t.small, { marginLeft: 10, color: colors.accent }]}>Only {item.available} left</Text> : null}
        </View>
      </View>
      <View style={s.plus}>
        <Ionicons name="add" size={20} color={colors.accentInk} />
      </View>
    </Pressable>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const s = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 8, backgroundColor: colors.bg },
  search: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, height: 46, marginTop: 14, marginBottom: 10 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, marginLeft: 8, height: '100%' },
  section: { ...t.tiny, color: colors.accent, marginTop: 18, marginBottom: 8 },
  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.lg, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.border },
  thumb: { width: 64, height: 64, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  price: { color: colors.text, fontWeight: '700', fontSize: 15 },
  plus: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  cartBar: { position: 'absolute', left: 16, right: 16, backgroundColor: colors.accent, borderRadius: radius.md, height: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  cartBarText: { color: colors.accentInk, fontWeight: '800', fontSize: 16 },
  cartCount: { backgroundColor: colors.accentInk, minWidth: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 10, paddingHorizontal: 6 },
  cartCountText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  closed: { backgroundColor: 'rgba(229,101,92,0.16)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  closedText: { color: colors.red, fontWeight: '700', fontSize: 12 },
});
