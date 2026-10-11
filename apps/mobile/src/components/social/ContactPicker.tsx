import { contactLabel, type Contact } from '@heyda/core';
import { Pressable, Text, View } from 'react-native';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { Avatar, T } from '../ui';
import { sortContacts } from './contacts';

/**
 * Pick several contacts: one row each with avatar and a check box.
 * `max` limits the selection; rows beyond it are disabled until one is unticked.
 */
export function ContactPicker({
  contacts,
  selected,
  onChange,
  max,
  note,
}: {
  contacts: Contact[];
  selected: string[];
  onChange: (keys: string[]) => void;
  max?: number;
  /** Extra line under a name, e.g. "teilt schon live". */
  note?: (c: Contact) => string | undefined;
}) {
  const t = useTheme();
  const full = max !== undefined && selected.length >= max;
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : full ? selected : [...selected, key]);
  const sorted = sortContacts(contacts);
  const all = sorted.length > 1 && (max === undefined || sorted.length <= max);

  return (
    <View style={{ gap: spacing.sm }}>
      {all ? (
        <Pressable
          onPress={() => onChange(selected.length === sorted.length ? [] : sorted.map((c) => c.key))}
          accessibilityRole="button"
          style={{ alignSelf: 'flex-start', minHeight: TOUCH, justifyContent: 'center' }}
        >
          <Text style={{ color: t.accent, fontWeight: '700', fontSize: 15 }}>
            {selected.length === sorted.length ? 'Keinen auswählen' : 'Alle auswählen'}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ backgroundColor: t.surface, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, overflow: 'hidden' }}>
        {sorted.map((c, i) => {
          const on = selected.includes(c.key);
          const disabled = !on && full;
          const name = contactLabel(c);
          const extra = note?.(c);
          return (
            <Pressable
              key={c.key}
              onPress={() => toggle(c.key)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityLabel={extra ? `${name}, ${extra}` : name}
              accessibilityState={{ checked: on, disabled }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                minHeight: TOUCH + 12,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: t.border,
                backgroundColor: pressed ? t.surfaceRaised : 'transparent',
                opacity: disabled ? 0.45 : 1,
              })}
            >
              <Avatar name={name} keyHex={c.key} size={36} />
              <View style={{ flex: 1 }}>
                <T numberOfLines={1}>{`${c.favorite ? '⭐ ' : ''}${name}`}</T>
                {extra ? <T variant="small">{extra}</T> : null}
              </View>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  borderWidth: 2,
                  borderColor: on ? t.accent : t.textMuted,
                  backgroundColor: on ? t.accent : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {on ? <Text style={{ color: t.onAccent, fontWeight: '900', fontSize: 15 }}>✓</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {max !== undefined && contacts.length > max ? (
        <T variant="small">{`${selected.length} von höchstens ${max} ausgewählt`}</T>
      ) : null}
    </View>
  );
}
