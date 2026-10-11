import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onToast, type Toast } from '../lib/notifications';
import { useRuntime } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';
import { routeForToast } from './safety/alerts';

const SHOW_MS = 4500;
const MAX_VISIBLE = 3;
const SWIPE_OUT = 70;

/**
 * In-app banners for things that happen while the app is open. Alarms (SOS, overdue watches)
 * are left to the full-screen AlarmOverlay. Tap a banner to open what it is about; swipe it
 * away or press × to dismiss.
 */
export function ToastHost() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const runtime = useRuntime();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const remove = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  };

  useEffect(() => {
    const map = timers.current;
    const off = onToast((toast) => {
      if (toast.level === 'alarm') return;
      setToasts((list) => [...list.filter((x) => x.id !== toast.id), toast].slice(-MAX_VISIBLE));
      const prev = map.get(toast.id);
      if (prev) clearTimeout(prev);
      map.set(
        toast.id,
        setTimeout(() => {
          map.delete(toast.id);
          setToasts((list) => list.filter((x) => x.id !== toast.id));
        }, SHOW_MS),
      );
    });
    return () => {
      off();
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  if (!toasts.length) return null;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + spacing.sm,
        left: spacing.md,
        right: spacing.md,
        alignItems: 'center',
        gap: spacing.sm,
      }}
    >
      {toasts.map((toast) => (
        <Banner
          key={toast.id}
          toast={toast}
          onOpen={() => {
            remove(toast.id);
            router.push(routeForToast(toast.alert, runtime.getSnapshot().state.self.key));
          }}
          onDismiss={() => remove(toast.id)}
        />
      ))}
    </View>
  );
}

function Banner({ toast, onOpen, onDismiss }: { toast: Toast; onOpen: () => void; onDismiss: () => void }) {
  const t = useTheme();
  const dx = useRef(new Animated.Value(0)).current;
  const dy = useRef(new Animated.Value(0)).current;
  const native = Platform.OS !== 'web';

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 || g.dy < -8,
      onPanResponderMove: (_e, g) => {
        dx.setValue(g.dx);
        dy.setValue(Math.min(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dx) > SWIPE_OUT || g.dy < -SWIPE_OUT / 2) {
          onDismissRef.current();
          return;
        }
        Animated.parallel([
          Animated.spring(dx, { toValue: 0, useNativeDriver: native }),
          Animated.spring(dy, { toValue: 0, useNativeDriver: native }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        dx.setValue(0);
        dy.setValue(0);
      },
    }),
  ).current;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const quiet = toast.level === 'silent';
  return (
    <Animated.View
      {...pan.panHandlers}
      style={{
        width: '100%',
        maxWidth: 560,
        transform: [{ translateX: dx }, { translateY: dy }],
        opacity: dx.interpolate({ inputRange: [-200, 0, 200], outputRange: [0.2, 1, 0.2], extrapolate: 'clamp' }),
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'stretch',
          backgroundColor: t.surfaceRaised,
          borderColor: quiet ? t.border : t.accent,
          borderWidth: 1,
          borderRadius: radius.md,
          shadowColor: '#000',
          shadowOpacity: 0.4,
          shadowRadius: 12,
          elevation: 6,
        }}
      >
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${toast.title}. ${toast.body}`}
          accessibilityHint="Öffnet die Nachricht"
          accessibilityLiveRegion="polite"
          style={({ pressed }) => ({ flex: 1, padding: spacing.md, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
            {toast.title}
          </Text>
          {toast.body ? (
            <Text style={{ color: t.textMuted, fontSize: 14, marginTop: 2 }} numberOfLines={2}>
              {toast.body}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Hinweis schließen"
          hitSlop={6}
          style={({ pressed }) => ({
            width: TOUCH,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: t.textMuted, fontSize: 18, fontWeight: '700' }}>✕</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
