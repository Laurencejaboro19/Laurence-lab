import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';

import { colors, radius, type as t } from './theme';

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  icon,
  style,
  compact,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: ViewStyle;
  compact?: boolean;
}) {
  const off = disabled || loading;
  const bg =
    variant === 'primary' ? colors.accent : variant === 'danger' ? 'rgba(229,101,92,0.14)' : variant === 'secondary' ? colors.surface2 : 'transparent';
  const fg = variant === 'primary' ? colors.accentInk : variant === 'danger' ? colors.red : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [
        s.btn,
        compact && s.btnCompact,
        { backgroundColor: bg, opacity: off ? 0.55 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginRight: 8 }} /> : null}
          <Text style={[s.btnText, { color: fg }, compact && { fontSize: 14 }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void }) {
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [s.card, style, pressed && { opacity: 0.9 }]}>
        {children}
      </Pressable>
    );
  return <View style={[s.card, style]}>{children}</View>;
}

export function Field(props: TextInputProps & { label?: string; hint?: string }) {
  const { label, hint, style, ...rest } = props;
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={[t.tiny, { marginBottom: 6 }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.faint}
        selectionColor={colors.accent}
        style={[s.input, style]}
        {...rest}
      />
      {hint ? <Text style={[t.small, { marginTop: 6 }]}>{hint}</Text> : null}
    </View>
  );
}

export function Pill({ label, active, onPress, color }: { label: string; active?: boolean; onPress?: () => void; color?: string }) {
  const c = color ?? colors.accent;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.pill,
        active ? { backgroundColor: c, borderColor: c } : { borderColor: colors.border },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={[s.pillText, { color: active ? colors.accentInk : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[s.badge, { backgroundColor: color + '22', borderColor: color + '55' }]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={[s.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function Row({ children, style, between }: { children: React.ReactNode; style?: ViewStyle; between?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, between && { justifyContent: 'space-between' }, style]}>{children}</View>;
}

export function Stepper({ value, onChange, min = 0, max = 50, busy }: { value: number; onChange: (n: number) => void; min?: number; max?: number; busy?: boolean }) {
  const Btn = ({ name, onPress, disabled }: { name: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean }) => (
    <Pressable onPress={onPress} disabled={disabled || busy} hitSlop={8} style={({ pressed }) => [s.stepBtn, (disabled || busy) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
      <Ionicons name={name} size={18} color={colors.text} />
    </Pressable>
  );
  return (
    <Row style={s.stepper}>
      <Btn name={value <= 1 && min === 0 ? 'trash-outline' : 'remove'} onPress={() => onChange(value - 1)} disabled={value <= min} />
      <Text style={s.stepValue}>{value}</Text>
      <Btn name="add" onPress={() => onChange(value + 1)} disabled={value >= max} />
    </Row>
  );
}

export function Notice({ text, tone = 'info', icon }: { text: string; tone?: 'info' | 'warn' | 'error' | 'success'; icon?: keyof typeof Ionicons.glyphMap }) {
  const c = tone === 'error' ? colors.red : tone === 'warn' ? colors.accent : tone === 'success' ? colors.green : colors.blue;
  return (
    <View style={[s.notice, { borderColor: c + '66', backgroundColor: c + '14' }]}>
      <Ionicons name={icon ?? (tone === 'error' ? 'alert-circle' : tone === 'success' ? 'checkmark-circle' : 'information-circle')} size={18} color={c} />
      <Text style={[t.small, { color: colors.text, flex: 1, marginLeft: 8 }]}>{text}</Text>
    </View>
  );
}

export function Empty({ icon, title, body, action }: { icon: keyof typeof Ionicons.glyphMap; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Ionicons name={icon} size={30} color={colors.accent} />
      </View>
      <Text style={[t.h2, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[t.small, { textAlign: 'center', marginTop: 6, maxWidth: 280 }]}>{body}</Text> : null}
      {action ? <View style={{ marginTop: 18 }}>{action}</View> : null}
    </View>
  );
}

export function Divider() {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 }} />;
}

export function IconButton({ name, onPress, style, color }: { name: keyof typeof Ionicons.glyphMap; onPress?: () => void; style?: ViewStyle; color?: string } & PressableProps) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [s.iconBtn, style, pressed && { opacity: 0.7 }]}>
      <Ionicons name={name} size={20} color={color ?? colors.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', paddingHorizontal: 18 },
  btnCompact: { minHeight: 40, paddingHorizontal: 14 },
  btnText: { fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16, borderWidth: 1, borderColor: colors.border },
  input: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, marginRight: 8 },
  pillText: { fontSize: 14, fontWeight: '600' },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  stepper: { backgroundColor: colors.surface2, borderRadius: radius.pill, padding: 4 },
  stepBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stepValue: { minWidth: 32, textAlign: 'center', color: colors.text, fontWeight: '700', fontSize: 16 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, borderRadius: radius.md, borderWidth: 1, marginBottom: 12 },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.amberSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
