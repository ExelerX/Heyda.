import { router, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { Button, Card, Row, T } from '../ui';

/** Caps the content width so screens read well in the wide Windows window. */
export function Narrow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }, style]}>{children}</View>;
}

/** Goes back, or to the start screen when there is nothing to go back to (deep link). */
export function goBack(fallback: Href = '/'): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** Friendly state for a deep link that points at nothing. */
export function NotFound({ title, text }: { title: string; text: string }) {
  return (
    <View style={{ gap: spacing.md, paddingTop: spacing.xl }}>
      <Card style={{ alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.md }}>
        <Text style={{ fontSize: 40 }} accessible={false}>
          🔍
        </Text>
        <T variant="h2" style={{ textAlign: 'center' }}>
          {title}
        </T>
        <T variant="muted" style={{ textAlign: 'center' }}>
          {text}
        </T>
        <Button title="Zur Startseite" kind="secondary" onPress={() => router.replace('/')} />
      </Card>
    </View>
  );
}

/** A labelled text input with a character counter near the limit. */
export function Field({
  label,
  value,
  onChangeText,
  maxLength,
  hint,
  multiline,
  style,
  ...rest
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  maxLength: number;
  hint?: string;
  style?: StyleProp<ViewStyle>;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'maxLength' | 'style'>) {
  const t = useTheme();
  const near = value.length > maxLength * 0.8;
  return (
    <View style={[{ gap: spacing.xs }, style]}>
      {label ? <T variant="small">{label}</T> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        multiline={multiline}
        placeholderTextColor={t.textMuted}
        accessibilityLabel={rest.accessibilityLabel ?? label ?? rest.placeholder}
        style={{
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          color: t.text,
          fontSize: 16,
          minHeight: TOUCH + 4,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          textAlignVertical: multiline ? 'top' : 'center',
          ...(multiline ? { maxHeight: 160 } : {}),
        }}
        {...rest}
      />
      {hint || near ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="small" style={{ flex: 1 }}>
            {hint ?? ''}
          </T>
          {near ? <T variant="small">{`${value.length}/${maxLength}`}</T> : null}
        </Row>
      ) : null}
    </View>
  );
}

/** One option of a single choice (radio card). */
export function Choice({
  title,
  detail,
  icon,
  selected,
  onPress,
  disabled,
}: {
  title: string;
  detail?: string;
  icon?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      style={({ pressed }) => ({
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? t.accent : t.border,
        backgroundColor: pressed ? t.surfaceRaised : t.surface,
        borderRadius: radius.md,
        padding: spacing.md,
        minHeight: TOUCH,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
        {icon ? (
          <Text style={{ fontSize: 22 }} accessible={false}>
            {icon}
          </Text>
        ) : null}
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="h2">{title}</T>
          {detail ? <T variant="small">{detail}</T> : null}
        </View>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 2,
            borderColor: selected ? t.accent : t.textMuted,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 2,
          }}
        >
          {selected ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent }} /> : null}
        </View>
      </Row>
    </Pressable>
  );
}

/** Two or three tabs on top of a screen. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', backgroundColor: t.surfaceRaised, borderRadius: radius.md, padding: 4, gap: 4 }}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              minHeight: TOUCH,
              borderRadius: radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? t.accent : 'transparent',
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text style={{ color: on ? t.onAccent : t.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A coloured, tappable banner for things that need attention (SOS, overdue, questions). */
export function Banner({
  icon,
  title,
  text,
  color,
  onPress,
  action,
  strong,
}: {
  icon: string;
  title: string;
  text?: string;
  color: string;
  onPress?: () => void;
  action?: string;
  strong?: boolean;
}) {
  const t = useTheme();
  const body = (
    <Row gap={spacing.md} style={{ alignItems: 'center' }}>
      <Text style={{ fontSize: 26 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h2" color={strong ? t.bg : color}>
          {title}
        </T>
        {text ? (
          <T variant="small" color={strong ? t.bg : t.textMuted}>
            {text}
          </T>
        ) : null}
      </View>
      {action ? (
        <Text style={{ color: strong ? t.bg : color, fontWeight: '800', fontSize: 15 }} accessible={false}>
          {action} ›
        </Text>
      ) : null}
    </Row>
  );
  const box: ViewStyle = {
    borderRadius: radius.md,
    borderWidth: strong ? 0 : 1.5,
    borderColor: color,
    backgroundColor: strong ? color : t.surface,
    padding: spacing.md,
    minHeight: TOUCH,
  };
  if (!onPress) return <View style={box}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, text, action].filter(Boolean).join('. ')}
      style={({ pressed }) => [box, { opacity: pressed ? 0.85 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

/** A row inside a list card: tappable, with a divider above (except the first). */
export function ListRow({
  children,
  onPress,
  label,
  first,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  label?: string;
  first?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const base: ViewStyle = {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: TOUCH + 12,
    justifyContent: 'center',
    borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
    borderTopColor: t.border,
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [base, pressed && { backgroundColor: t.surfaceRaised }, style]}
    >
      {children}
    </Pressable>
  );
}

/** A card holding ListRows edge to edge. */
export function ListCard({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.border,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/** Small round count badge (unread). */
export function CountBadge({ count, label }: { count: number; label?: string }) {
  const t = useTheme();
  if (count <= 0) return null;
  return (
    <View
      accessibilityLabel={label ?? `${count} ungelesen`}
      style={{ minWidth: 24, height: 24, borderRadius: 12, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 }}
    >
      <Text style={{ color: t.onAccent, fontWeight: '800', fontSize: 13 }}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

/** A small icon button for headers (≥ 44 pt). */
export function HeaderButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => ({ minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ fontSize: 20 }}>{icon}</Text>
    </Pressable>
  );
}

/** A labelled line of facts: icon + text (+ optional trailing element). */
export function Fact({ icon, children, color, right }: { icon: string; children: ReactNode; color?: string; right?: ReactNode }) {
  return (
    <Row gap={spacing.sm} style={{ alignItems: 'flex-start' }}>
      <Text style={{ fontSize: 16, width: 24, textAlign: 'center', lineHeight: 22 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1 }}>
        {typeof children === 'string' ? <T color={color}>{children}</T> : children}
      </View>
      {right}
    </Row>
  );
}
