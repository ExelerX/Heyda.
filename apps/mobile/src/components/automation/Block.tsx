import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { T } from '../ui';

/** The coloured label of a rule part: "Wenn", "Und nur wenn", "Dann". */
export function PartLabel({ text, color, hint }: { text: string; color: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md }}>
      <View style={{ backgroundColor: color, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 }}>
        <Text style={{ color: t.dark ? t.bg : t.surface, fontWeight: '900', fontSize: 13, letterSpacing: 0.5 }} accessibilityRole="header">
          {text.toUpperCase()}
        </Text>
      </View>
      {hint ? (
        <T variant="small" style={{ flex: 1 }}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

/**
 * One puzzle piece: a coloured edge with a little nub on top, an icon and title, and
 * its settings inside. Pieces stack like a jigsaw: trigger, conditions, actions.
 */
export function Block({ color, icon, title, onChange, onRemove, children, changeLabel = 'Ändern' }: {
  color: string;
  icon: string;
  title: string;
  onChange?: () => void;
  onRemove?: () => void;
  children?: ReactNode;
  changeLabel?: string;
}) {
  const t = useTheme();
  return (
    <View style={{ paddingTop: 6 }}>
      <View
        accessible={false}
        style={{ position: 'absolute', top: 0, left: 22, width: 30, height: 12, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: color }}
      />
      <View
        style={{
          backgroundColor: t.surface,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: t.border,
          borderLeftWidth: 6,
          borderLeftColor: color,
          padding: spacing.md,
          gap: spacing.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text style={{ fontSize: 22 }} accessible={false}>
            {icon}
          </Text>
          <T variant="h2" style={{ flex: 1 }}>
            {title}
          </T>
          {onChange ? (
            <Pressable
              onPress={onChange}
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${changeLabel}`}
              style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: spacing.sm }}
            >
              <Text style={{ color: t.accent, fontWeight: '700' }}>{changeLabel}</Text>
            </Pressable>
          ) : null}
          {onRemove ? (
            <Pressable
              onPress={onRemove}
              accessibilityRole="button"
              accessibilityLabel={`${title} entfernen`}
              style={{ minHeight: TOUCH, minWidth: TOUCH, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: t.danger, fontSize: 18, fontWeight: '700' }}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        {children}
      </View>
    </View>
  );
}

/** A tappable piece in the block catalog. */
export function BlockOption({ color, icon, title, detail, onPress, selected }: {
  color: string;
  icon: string;
  title: string;
  detail: string;
  onPress: () => void;
  selected?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${detail}`}
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: 220,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: TOUCH + 12,
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? color : t.border,
        borderLeftWidth: 6,
        borderLeftColor: color,
        backgroundColor: pressed ? t.surfaceRaised : t.surface,
      })}
    >
      <Text style={{ fontSize: 22 }} accessible={false}>
        {icon}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontWeight: '700' }}>{title}</T>
        <T variant="small">{detail}</T>
      </View>
    </Pressable>
  );
}

/** The thin line that joins puzzle parts. */
export function Connector({ color }: { color: string }) {
  return <View accessible={false} style={{ width: 3, height: 14, marginLeft: 35, backgroundColor: color, opacity: 0.6, borderRadius: 2 }} />;
}

/** A dashed "add a piece" button. */
export function AddPiece({ label, color, onPress, disabled }: { label: string; color: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: TOUCH + 4,
        borderRadius: radius.md,
        borderWidth: 2,
        borderStyle: 'dashed',
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontWeight: '800', fontSize: 16 }}>{`＋ ${label}`}</Text>
    </Pressable>
  );
}
