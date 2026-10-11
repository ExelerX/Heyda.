import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { spacing, useTheme } from '../../lib/theme';
import { onFilled } from './BigButton';

const TICK_MS = 30;

/**
 * The big round SOS control. It only fires after being held for `holdMs` (a ring fills up),
 * so a touch in the pocket or a stray tap never sends anything. Screen reader users get a
 * countdown with a cancel button instead (`onAccessibleActivate`), since holding is awkward there.
 */
export function HoldButton({
  onComplete,
  onHoldChange,
  onAccessibleActivate,
  disabled,
  busy,
  holdMs = 2000,
  size = 220,
}: {
  onComplete: () => void;
  onHoldChange?: (holding: boolean) => void;
  onAccessibleActivate?: () => void;
  disabled?: boolean;
  busy?: boolean;
  holdMs?: number;
  size?: number;
}) {
  const t = useTheme();
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const [tapHint, setTapHint] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedAt = useRef(0);
  const done = useRef(false);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = undefined;
  };

  const pressIn = () => {
    if (disabled || busy || timer.current) return;
    done.current = false;
    startedAt.current = Date.now();
    setHolding(true);
    setTapHint(false);
    onHoldChange?.(true);
    if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - startedAt.current) / holdMs);
      setProgress(p);
      if (p >= 1 && !done.current) {
        done.current = true;
        stop();
        setHolding(false);
        onHoldChange?.(false);
        if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        onComplete();
      }
    }, TICK_MS);
  };

  const pressOut = () => {
    if (done.current || !timer.current) return;
    const held = Date.now() - startedAt.current;
    stop();
    setHolding(false);
    setProgress(0);
    onHoldChange?.(false);
    if (held < holdMs) {
      setTapHint(true);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setTapHint(false), 3500);
    }
  };

  // Reset the ring once sending is over (e.g. it failed and can be tried again).
  useEffect(() => {
    if (!busy) setProgress(0);
  }, [busy]);

  const stroke = 12;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const inner = size - stroke * 2 - 12;
  const fg = onFilled(t);
  const secondsLeft = Math.max(0, (holdMs * (1 - progress)) / 1000);
  const sub = busy ? 'Wird gesendet …' : holding ? `Halten … ${secondsLeft.toFixed(1).replace('.', ',')} s` : 'Gedrückt halten';

  return (
    <View style={{ alignItems: 'center', gap: spacing.md }}>
      <Pressable
        onPressIn={pressIn}
        onPressOut={pressOut}
        disabled={disabled || busy}
        accessibilityRole="button"
        accessibilityLabel="SOS senden"
        accessibilityHint={`${Math.round(holdMs / 1000)} Sekunden gedrückt halten, bis der Ring voll ist.`}
        accessibilityState={{ disabled: !!disabled, busy: !!busy }}
        accessibilityActions={[{ name: 'activate', label: 'SOS mit 5-Sekunden-Countdown senden' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate' && !disabled && !busy) onAccessibleActivate?.();
        }}
        style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1 }}
      >
        <View style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }} pointerEvents="none">
          <Svg width={size} height={size}>
            <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.surfaceRaised} strokeWidth={stroke} fill="none" />
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke={t.text}
              strokeWidth={stroke}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - progress)}
            />
          </Svg>
        </View>
        <View
          pointerEvents="none"
          style={{
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            backgroundColor: t.danger,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale: holding ? 0.96 : 1 }],
            shadowColor: t.danger,
            shadowOpacity: 0.6,
            shadowRadius: 24,
            elevation: 8,
          }}
        >
          <Text style={{ color: fg, fontSize: Math.round(inner * 0.3), fontWeight: '900', letterSpacing: 2 }}>SOS</Text>
          {busy ? (
            <ActivityIndicator color={fg} style={{ marginTop: 4 }} />
          ) : (
            <Text style={{ color: fg, fontSize: 15, fontWeight: '700', marginTop: 2 }}>{sub}</Text>
          )}
        </View>
      </Pressable>
      <Text
        style={{ color: tapHint ? t.danger : t.textMuted, fontSize: 15, fontWeight: tapHint ? '700' : '400', textAlign: 'center' }}
        accessibilityLiveRegion="polite"
      >
        {busy
          ? 'Dein Notruf wird gesendet …'
          : tapHint
            ? 'Länger halten: so lange, bis der Ring voll ist.'
            : `${Math.round(holdMs / 1000)} Sekunden gedrückt halten, bis der Ring voll ist.`}
      </Text>
    </View>
  );
}
