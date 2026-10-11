import { Alert, Platform } from 'react-native';

/**
 * A yes/no question that works everywhere. React Native's Alert does nothing on the web
 * (and so in the Windows app), so the web uses the browser's own dialog.
 */
export function confirm(input: { title: string; message?: string; ok: string; cancel?: string; destructive?: boolean }): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' && window.confirm([input.title, input.message].filter(Boolean).join('\n\n')));
  }
  return new Promise((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        { text: input.cancel ?? 'Abbrechen', style: 'cancel', onPress: () => resolve(false) },
        { text: input.ok, style: input.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** A short message with one button. */
export function notice(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert([title, message].filter(Boolean).join('\n\n'));
    return;
  }
  Alert.alert(title, message);
}
