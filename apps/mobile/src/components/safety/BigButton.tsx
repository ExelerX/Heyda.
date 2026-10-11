import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, spacing, TOUCH, useTheme, type Theme } from '../../lib/theme';

/** Text colour on a filled danger/success surface, from the theme tokens (contrast >= 4.5:1). */
export function onFilled(t: Theme): string {
  return t.dark ? t.bg : t.surface;
}

export type BigKind = 'sos' | 'safe' | 'primary' | 'secondary' | 'outline' | 'quiet';

/**
 * A large, easy-to-hit button for the safety screens: filled red ("sos"), filled green
 * ("safe"), accent ("primary"), raised ("secondary"), red outline ("outline") or plain ("quiet").
 */
export function BigButton({
  title,
  subtitle,
  icon,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  label,
  hint,
  style,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  onPress: () => void;
  kind?: BigKind;
  disabled?: boolean;
  busy?: boolean;
  /** Screen reader label, if it should differ from title and subtitle. */
  label?: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const palette: Record<BigKind, { bg: string; fg: string; sub: string; border: string }> = {
    sos: { bg: t.danger, fg: onFilled(t), sub: onFilled(t), border: t.danger },
    safe: { bg: t.success, fg: onFilled(t), sub: onFilled(t), border: t.success },
    primary: { bg: t.accent, fg: t.onAccent, sub: t.onAccent, border: t.accent },
    secondary: { bg: t.surfaceRaised, fg: t.text, sub: t.textMuted, border: t.border },
    outline: { bg: 'transparent', fg: t.danger, sub: t.textMuted, border: t.danger },
    quiet: { bg: 'transparent', fg: t.textMuted, sub: t.textMuted, border: t.border },
  };
  const c = palette[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={() => {
        if (Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, subtitle].filter(Boolean).join('. ')}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        {
          minHeight: TOUCH + 18,
          borderRadius: radius.md,
          borderWidth: kind === 'outline' ? 2 : 1,
          borderColor: c.border,
          backgroundColor: c.bg,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.md,
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !off ? 0.99 : 1 }],
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <>
          {icon ? (
            <Text style={{ fontSize: 24 }} accessible={false}>
              {icon}
            </Text>
          ) : null}
          <View style={{ flexShrink: 1, alignItems: icon ? 'flex-start' : 'center' }}>
            <Text style={{ color: c.fg, fontSize: 18, fontWeight: '800', textAlign: icon ? 'left' : 'center' }}>{title}</Text>
            {subtitle ? (
              <Text style={{ color: c.sub, fontSize: 14, marginTop: 2, opacity: 0.9, textAlign: icon ? 'left' : 'center' }}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </>
      )}
    </Pressable>
  );
}
