import { Text, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { Avatar } from '../ui';

/** Avatar for a contact, or a group icon for "g:" threads. Optional live dot. */
export function ThreadAvatar({ thread, name, size = 44, live }: { thread: string; name: string; size?: number; live?: boolean }) {
  const t = useTheme();
  const group = thread.startsWith('g:');
  return (
    <View style={{ width: size, height: size }}>
      {group ? (
        <View
          accessible={false}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: t.surfaceRaised,
            borderWidth: 1,
            borderColor: t.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: size * 0.45 }}>👥</Text>
        </View>
      ) : (
        <Avatar name={name} keyHex={thread} size={size} />
      )}
      {live ? (
        <View
          accessible={false}
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: size * 0.36,
            height: size * 0.36,
            borderRadius: size * 0.18,
            backgroundColor: t.success,
            borderWidth: 2,
            borderColor: t.surface,
          }}
        />
      ) : null}
    </View>
  );
}
