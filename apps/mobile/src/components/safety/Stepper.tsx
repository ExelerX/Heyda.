import { Platform, Pressable, Text, View } from 'react-native';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { T } from '../ui';

const WEB = Platform.OS === 'web';

/**
 * A number with − and + buttons, no keyboard needed. Screen readers can swipe up/down to adjust.
 * In the browser and the Windows app it is a slider for the keyboard (arrow keys, Home, End) and
 * screen readers, which react-native-web doesn't make of `adjustable` by itself.
 */
export function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit: string;
}) {
  const t = useTheme();
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  const btn = (sign: -1 | 1) => {
    const off = sign < 0 ? value <= min : value >= max;
    return (
      <Pressable
        onPress={() => set(value + sign * step)}
        disabled={off}
        accessible={false}
        importantForAccessibility="no"
        // Not a tab stop of its own (unnamed in the browser); the slider takes the keys.
        tabIndex={-1}
        style={({ pressed }) => ({
          width: TOUCH,
          height: TOUCH,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: pressed ? t.surface : t.surfaceRaised,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: off ? 0.4 : 1,
        })}
      >
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>{sign < 0 ? '−' : '+'}</Text>
      </Pressable>
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: `${value} ${unit}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === 'increment' ? step : -step))}
      {...((WEB
        ? {
            focusable: true,
            'aria-valuemin': min,
            'aria-valuemax': max,
            'aria-valuenow': value,
            'aria-valuetext': `${value} ${unit}`,
            onKeyDown: (e: { key: string; preventDefault: () => void }) => {
              const keys: Record<string, number | undefined> = { ArrowUp: value + step, ArrowRight: value + step, ArrowDown: value - step, ArrowLeft: value - step, Home: min, End: max };
              const next = keys[e.key];
              if (next === undefined) return;
              e.preventDefault();
              set(next);
            },
          }
        : {}) as object)}
      style={{ flex: 1, gap: spacing.xs, alignItems: 'center' }}
    >
      <T variant="small">{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {btn(-1)}
        <Text style={{ color: t.text, fontSize: 24, fontWeight: '800', minWidth: 44, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        {btn(1)}
      </View>
      <T variant="small">{unit}</T>
    </View>
  );
}
