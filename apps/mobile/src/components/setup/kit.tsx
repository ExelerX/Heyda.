import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions, type StyleProp, type ViewStyle } from 'react-native';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { Card, T } from '../ui';

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Caps the content width so screens read well in the wide Windows window. */
export function Narrow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md }, style]}>{children}</View>;
}

/** A labelled text input in the app's look. */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  multiline,
  secure,
  hint,
  error,
  counter,
  keyboardType,
  autoCapitalize = 'sentences',
  autoFocus,
  onSubmitEditing,
  right,
  mono,
  minHeight,
  editable = true,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  secure?: boolean;
  hint?: string;
  error?: string;
  counter?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  right?: ReactNode;
  mono?: boolean;
  minHeight?: number;
  editable?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? (
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} accessibilityRole="text">
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          backgroundColor: t.surface,
          borderColor: error ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          opacity: editable ? 1 : 0.6,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.textMuted}
          maxLength={maxLength}
          multiline={multiline}
          secureTextEntry={secure}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={!secure && !mono && autoCapitalize !== 'none'}
          autoFocus={autoFocus}
          editable={editable}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={label ?? placeholder}
          accessibilityHint={hint}
          style={{
            flex: 1,
            color: t.text,
            fontSize: mono ? 14 : 17,
            fontFamily: mono ? MONO : undefined,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            minHeight: minHeight ?? (multiline ? 110 : TOUCH + 6),
            textAlignVertical: multiline ? 'top' : 'center',
          }}
        />
        {right}
      </View>
      {error ? (
        <T variant="small" color={t.danger}>
          {error}
        </T>
      ) : hint || (counter && maxLength) ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <T variant="small" style={{ flex: 1 }}>
            {hint ?? ''}
          </T>
          {counter && maxLength ? <T variant="small">{`${value.length}/${maxLength}`}</T> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Password input with a show/hide button. */
export function PasswordField(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}) {
  const t = useTheme();
  const [show, setShow] = useState(false);
  return (
    <Field
      {...props}
      secure={!show}
      autoCapitalize="none"
      maxLength={200}
      right={
        <Pressable
          onPress={() => setShow((s) => !s)}
          accessibilityRole="button"
          accessibilityLabel={show ? 'Passwort verbergen' : 'Passwort anzeigen'}
          style={{ minHeight: TOUCH, minWidth: TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md }}
        >
          <Text style={{ color: t.accent, fontWeight: '700', fontSize: 14 }}>{show ? 'Verbergen' : 'Zeigen'}</Text>
        </Pressable>
      }
    />
  );
}

/** One line in a menu: icon, title, optional detail, and a chevron when tappable. */
export function MenuRow({
  icon,
  title,
  detail,
  value,
  onPress,
  first,
  tone,
}: {
  icon: string;
  title: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  first?: boolean;
  tone?: 'warn' | 'danger';
}) {
  const t = useTheme();
  const color = tone === 'danger' ? t.danger : tone === 'warn' ? t.accent : t.textMuted;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={[title, detail, value].filter(Boolean).join(', ')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: TOUCH + 12,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        backgroundColor: pressed ? t.surfaceRaised : 'transparent',
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.border,
      })}
    >
      <Text style={{ fontSize: 22, width: 30, textAlign: 'center' }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T>{title}</T>
        {detail ? (
          <T variant="small" color={tone ? color : undefined}>
            {detail}
          </T>
        ) : null}
      </View>
      {value ? <T variant="small">{value}</T> : null}
      {onPress ? (
        <Text style={{ color: t.textMuted, fontSize: 22, marginLeft: spacing.xs }} accessible={false}>
          ›
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A card that holds MenuRows edge to edge. */
export function MenuGroup({ children }: { children: ReactNode }) {
  return <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>{children}</Card>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View
      style={{ gap: spacing.xs }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
    >
      <View style={{ height: 8, borderRadius: radius.pill, backgroundColor: t.surfaceRaised, overflow: 'hidden' }}>
        <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: t.accent, borderRadius: radius.pill }} />
      </View>
      {label ? <T variant="small">{`${label} ${Math.round(pct * 100)} %`}</T> : null}
    </View>
  );
}

/** Icon plus text, for short explanations and "what's inside" lists. */
export function Bullet({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
      <Text style={{ fontSize: 16, lineHeight: 22, width: 22, textAlign: 'center' }} accessible={false}>
        {icon}
      </Text>
      <T variant="muted" style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

/** A warning or error box. Colour plus an icon and words, never colour alone. */
export function Banner({ tone = 'info', icon, title, children }: { tone?: 'info' | 'warn' | 'danger' | 'success'; icon?: string; title?: string; children?: ReactNode }) {
  const t = useTheme();
  const color = { info: t.info, warn: t.accent, danger: t.danger, success: t.success }[tone];
  const glyph = icon ?? { info: 'ℹ️', warn: '⚠️', danger: '⛔', success: '✅' }[tone];
  return (
    <View
      accessible
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={{ flexDirection: 'row', gap: spacing.md, borderWidth: 1, borderColor: color, backgroundColor: t.surface, borderRadius: radius.md, padding: spacing.md }}
    >
      <Text style={{ fontSize: 18, lineHeight: 22 }} accessible={false}>
        {glyph}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        {title ? (
          <T variant="h2" color={color}>
            {title}
          </T>
        ) : null}
        {typeof children === 'string' ? <T variant="small" color={t.text}>{children}</T> : children}
      </View>
    </View>
  );
}

/** Numbered step in an explanation ("1. Öffne …"). */
export function Step({ n, children }: { n: number; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.surfaceRaised, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: t.accent, fontWeight: '800', fontSize: 13 }}>{n}</Text>
      </View>
      <T variant="muted" style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

/** Big, spaced digits to compare between two screens. */
export function Digits({ value, label }: { value: string; label: string }) {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value.split('').join(' ')}`}
      style={{ alignSelf: 'center', backgroundColor: t.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, paddingVertical: spacing.md, paddingHorizontal: spacing.xl }}
    >
      <Text style={{ color: t.text, fontSize: 34, fontWeight: '800', letterSpacing: 6, fontFamily: MONO, textAlign: 'center' }}>{value}</Text>
    </View>
  );
}

/** Friendly "this does not exist (anymore)" state for bad deep links. */
export function NotFound({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
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
      {action}
    </Card>
  );
}

/** A plain error message from anything thrown. */
export function errorText(e: unknown, fallback = 'Das hat leider nicht geklappt.'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}

/** One route param as a string (expo-router can give arrays for repeated params). */
export function param(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}
