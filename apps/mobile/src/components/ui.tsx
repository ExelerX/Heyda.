import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

const tap = () => {
  if (Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => {});
};

type TextVariant = 'title' | 'h2' | 'body' | 'muted' | 'small' | 'big';

export function T({
  children,
  variant = 'body',
  style,
  color,
  numberOfLines,
}: {
  children: ReactNode;
  variant?: TextVariant;
  style?: StyleProp<TextStyle>;
  color?: string;
  numberOfLines?: number;
}) {
  const t = useTheme();
  const base: Record<TextVariant, TextStyle> = {
    title: { fontSize: 30, fontWeight: '800', color: t.text, letterSpacing: -0.5 },
    big: { fontSize: 24, fontWeight: '800', color: t.text },
    h2: { fontSize: 17, fontWeight: '700', color: t.text },
    body: { fontSize: 16, color: t.text, lineHeight: 22 },
    muted: { fontSize: 15, color: t.textMuted, lineHeight: 21 },
    small: { fontSize: 13, color: t.textMuted, lineHeight: 18 },
  };
  return (
    <Text
      style={[base[variant], color ? { color } : null, style]}
      numberOfLines={numberOfLines}
      accessibilityRole={variant === 'title' || variant === 'h2' ? 'header' : undefined}
    >
      {children}
    </Text>
  );
}

/** A screen with safe-area padding and an optional large title. Scrolls by default. */
export function Screen({
  title,
  right,
  children,
  scroll = true,
  edges = ['top'],
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
}) {
  const t = useTheme();
  const header = title ? (
    <View style={styles.header}>
      <T variant="title">{title}</T>
      {right}
    </View>
  ) : null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={edges}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {header}
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          {header && <View style={{ paddingHorizontal: spacing.lg }}>{header}</View>}
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

export function Card({ children, style, onPress, label }: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  label?: string;
}) {
  const t = useTheme();
  const box: ViewStyle = {
    backgroundColor: t.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    padding: spacing.lg,
    gap: spacing.sm,
  };
  if (!onPress) return <View style={[box, style]}>{children}</View>;
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [box, pressed && { backgroundColor: t.surfaceRaised }, style]}
    >
      {children}
    </Pressable>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  busy,
  style,
  compact,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  icon?: string;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const t = useTheme();
  const colors: Record<ButtonKind, { bg: string; fg: string; border?: string }> = {
    primary: { bg: t.accent, fg: t.onAccent },
    secondary: { bg: t.surfaceRaised, fg: t.text, border: t.border },
    danger: { bg: 'transparent', fg: t.danger, border: t.danger },
    ghost: { bg: 'transparent', fg: t.accent },
  };
  const c = colors[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: c.bg, borderColor: c.border ?? c.bg, opacity: off ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <Text style={{ color: c.fg, fontSize: compact ? 15 : 17, fontWeight: '700' }} numberOfLines={1}>
          {icon ? `${icon}  ` : ''}
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, icon }: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? t.accent : t.surfaceRaised,
          borderColor: selected ? t.accent : t.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={{ color: selected ? t.onAccent : t.text, fontSize: 15, fontWeight: '600' }}>
        {icon ? `${icon} ` : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function Row({ children, style, gap = spacing.sm }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Wrap({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>{children}</View>;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2">{title}</T>
        {action}
      </Row>
      {children}
    </View>
  );
}

const AVATAR_COLORS = ['#4A3B7A', '#1F5C52', '#7A4A1F', '#1F4A7A', '#7A1F4A', '#4A6A1F', '#6A3B2F'];

export function Avatar({ name, keyHex, size = 44 }: { name: string; keyHex: string; size?: number }) {
  const n = parseInt(keyHex.slice(0, 6), 16) || 0;
  const bg = AVATAR_COLORS[n % AVATAR_COLORS.length];
  return (
    <View
      accessible={false}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: '#F2F4F7', fontWeight: '800', fontSize: size * 0.42 }}>
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

export function Toggle({ label, detail, value, onChange }: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTheme();
  const set = (v: boolean) => {
    tap();
    onChange(v);
  };
  return (
    <Row style={{ minHeight: TOUCH }} gap={0}>
      {/* Tapping the text switches too: the switch alone is a small target. It is a sibling, not a
          parent of the switch (a tap there must not count twice), and screen readers and the
          keyboard keep using the switch itself, which carries the label. */}
      <Pressable
        onPress={() => set(!value)}
        accessible={false}
        tabIndex={-1}
        style={{ flex: 1, gap: 2, minHeight: TOUCH, justifyContent: 'center', paddingRight: spacing.md }}
      >
        <T>{label}</T>
        {detail ? <T variant="small">{detail}</T> : null}
      </Pressable>
      <Switch
        value={value}
        onValueChange={set}
        // react-native-web draws it 40×20 by default (also in the Windows app); the phones' own are bigger.
        style={Platform.OS === 'web' ? { height: 28 } : undefined}
        trackColor={{ true: t.accent, false: t.border }}
        thumbColor="#FFFFFF"
        // react-native-web colours the "on" thumb separately (not in the native types).
        {...((Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {}) as object)}
        accessibilityLabel={label}
      />
    </Row>
  );
}

export function Empty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: ReactNode }) {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.md }}>
      <Text style={{ fontSize: 40 }} accessible={false}>
        {icon}
      </Text>
      <T variant="h2" style={{ textAlign: 'center' }}>
        {title}
      </T>
      <T variant="muted" style={{ textAlign: 'center' }}>
        {text}
      </T>
      {action}
    </Card>
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={{ borderRadius: radius.pill, borderWidth: 1, borderColor: color, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ color, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, backgroundColor: t.surfaceRaised, borderRadius: radius.sm, padding: spacing.md }}>
      <Text accessible={false}>💡</Text>
      <T variant="small" style={{ flex: 1 }} color={t.textMuted}>
        {children}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl * 2, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm, marginTop: spacing.sm },
  button: {
    minHeight: TOUCH + 8,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonCompact: { minHeight: TOUCH, paddingHorizontal: spacing.md },
  chip: { minHeight: TOUCH, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
});
