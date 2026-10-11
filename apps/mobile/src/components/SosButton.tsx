import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { useSnapshot } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';
import { onFilled } from './safety/BigButton';

/**
 * A red, unmistakable SOS button that opens the emergency screen. Sending needs a deliberate
 * hold there, so tapping this is always safe. While my SOS runs it pulses and says "SOS aktiv".
 */
export function SosButton({ compact }: { compact?: boolean }) {
  const t = useTheme();
  const router = useRouter();
  const { state } = useSnapshot();
  const active = !!state.sos;
  const pulse = useRef(new Animated.Value(0)).current;

  // While active, a red ring keeps growing out of the button; the button itself stays fully opaque.
  useEffect(() => {
    pulse.setValue(0);
    if (!active) return;
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const halo = active ? (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        borderRadius: compact ? radius.pill : radius.md,
        borderWidth: 3,
        borderColor: t.danger,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
        transform: [{ scaleX: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, compact ? 1.25 : 1.06] }) }, { scaleY: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, compact ? 1.4 : 1.3] }) }],
      }}
    />
  ) : null;

  const fg = onFilled(t);
  const acks = state.sos?.acks.length ?? 0;
  const label = active ? 'Dein Notruf läuft. Öffnen' : 'SOS: Notruf-Bildschirm öffnen';

  if (compact) {
    return (
      <Pressable
        onPress={() => router.push('/sos')}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={4}
        style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
      >
        {halo}
        <View
          style={{
            minHeight: TOUCH,
            minWidth: TOUCH + 20,
            paddingHorizontal: spacing.md,
            borderRadius: radius.pill,
            backgroundColor: t.danger,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: fg, fontSize: 15, fontWeight: '900', letterSpacing: 1 }}>{active ? '🆘 SOS aktiv' : 'SOS'}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => router.push('/sos')}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, alignSelf: 'stretch' })}
    >
      {halo}
      <View
        style={{
          minHeight: TOUCH + 20,
          borderRadius: radius.md,
          backgroundColor: t.danger,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
        }}
      >
        <Text accessible={false} style={{ fontSize: 26 }}>
          🆘
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: fg, fontSize: 18, fontWeight: '900' }}>{active ? 'SOS aktiv' : 'SOS'}</Text>
          <Text style={{ color: fg, fontSize: 14, fontWeight: '600' }}>
            {active
              ? acks
                ? `${acks === 1 ? '1 Person kümmert sich' : `${acks} Personen kümmern sich`} · Antippen zum Ansehen`
                : 'Dein Notruf läuft · Antippen zum Ansehen'
              : 'Notruf an deine Notfallkontakte'}
          </Text>
        </View>
        <Text style={{ color: fg, fontSize: 22, fontWeight: '700' }} accessible={false}>
          ›
        </Text>
      </View>
    </Pressable>
  );
}
