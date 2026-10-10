import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastHost } from '../components/Toasts';
import { Button, Screen, T } from '../components/ui';
import { RuntimeProvider, useSnapshot } from '../lib/store';
import { darkTheme, lightTheme, spacing, ThemeContext } from '../lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <RuntimeProvider loading={<Splash />} failed={(message, retry) => <Failed message={message} retry={retry} />}>
        <ThemedApp />
      </RuntimeProvider>
    </SafeAreaProvider>
  );
}

function ThemedApp() {
  const { settings } = useSnapshot();
  const system = useColorScheme();
  const pref = settings.appearance ?? 'dark';
  const theme = pref === 'light' || (pref === 'system' && system === 'light') ? lightTheme : darkTheme;
  const base = theme.dark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.accent,
      background: theme.bg,
      card: theme.surface,
      text: theme.text,
      border: theme.border,
      notification: theme.accent,
    },
  };

  return (
    <ThemeContext.Provider value={theme}>
      <ThemeProvider value={navTheme}>
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.surface },
            headerTintColor: theme.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.bg },
            headerBackTitle: 'Zurück',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="welcome" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="trip" options={{ presentation: 'modal', title: 'Ankunftszeit teilen' }} />
          <Stack.Screen name="pair" options={{ title: 'Freund hinzufügen' }} />
          <Stack.Screen name="places" options={{ title: 'Meine Orte' }} />
          <Stack.Screen name="plugin" options={{ presentation: 'modal', title: 'Plugin importieren' }} />
          <Stack.Screen name="chat/[key]" options={{ title: 'Chat' }} />
          <Stack.Screen name="contact/[key]" options={{ title: 'Kontakt' }} />
          <Stack.Screen name="template/[id]" options={{ title: 'Automation' }} />
        </Stack>
        <ToastHost />
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}

function Splash() {
  return (
    <View style={{ flex: 1, backgroundColor: darkTheme.bg, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={darkTheme.accent} size="large" />
    </View>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Screen title="Kurz hängen geblieben">
      <T variant="muted">
        Die App konnte ihre verschlüsselten Daten nicht öffnen. Das passiert z. B. direkt nach einem Neustart, solange
        das Handy noch nie entsperrt wurde.
      </T>
      <T variant="small">{message}</T>
      <View style={{ marginTop: spacing.lg }}>
        <Button title="Nochmal versuchen" onPress={retry} />
      </View>
    </Screen>
  );
}
