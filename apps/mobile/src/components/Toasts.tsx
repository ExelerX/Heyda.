import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onToast, type Toast } from '../lib/notifications';
import { radius, spacing, useTheme } from '../lib/theme';

const SHOW_MS = 4500;

/** In-app banners for things that happen while the app is open. */
export function ToastHost() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(
    () =>
      onToast((toast) => {
        setToasts((list) => [...list.slice(-2), toast]);
        setTimeout(() => setToasts((list) => list.filter((x) => x.id !== toast.id)), SHOW_MS);
      }),
    [],
  );

  if (!toasts.length) return null;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: insets.top + spacing.sm, left: spacing.md, right: spacing.md, gap: spacing.sm }}
    >
      {toasts.map((toast) => (
        <Pressable
          key={toast.id}
          onPress={() => setToasts((list) => list.filter((x) => x.id !== toast.id))}
          accessibilityRole="alert"
          accessibilityLabel={`${toast.title}. ${toast.body}`}
          style={{
            backgroundColor: t.surfaceRaised,
            borderColor: t.accent,
            borderWidth: 1,
            borderRadius: radius.md,
            padding: spacing.md,
            shadowColor: '#000',
            shadowOpacity: 0.4,
            shadowRadius: 12,
            elevation: 6,
          }}
        >
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{toast.title}</Text>
          <Text style={{ color: t.textMuted, fontSize: 14, marginTop: 2 }}>{toast.body}</Text>
        </Pressable>
      ))}
    </View>
  );
}
