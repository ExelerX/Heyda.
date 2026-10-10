import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from '../../lib/store';
import { useTheme } from '../../lib/theme';

const icon = (glyph: string) =>
  function TabIcon({ focused }: { focused: boolean }) {
    return <Text style={{ fontSize: 20, lineHeight: 24, opacity: focused ? 1 : 0.55 }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSnapshot();
  if (!settings.onboarded) return <Redirect href="/welcome" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        // Explicit height: emoji icons are taller than the default icon box.
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopColor: t.border,
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600', lineHeight: 16, minHeight: 16 },
        tabBarIconStyle: { height: 26, flexGrow: 0 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Start', tabBarIcon: icon('🏠') }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats', tabBarIcon: icon('💬') }} />
      <Tabs.Screen name="automations" options={{ title: 'Automationen', tabBarIcon: icon('⚡') }} />
      <Tabs.Screen name="me" options={{ title: 'Ich', tabBarIcon: icon('🙂') }} />
    </Tabs>
  );
}
