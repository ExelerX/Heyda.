import { contactLabel } from '@heyda/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSnapshot } from '../../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../../lib/theme';
import { Field } from '../setup/kit';
import { Chip, T, Wrap } from '../ui';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/** Small caption above a picker. */
export function PickLabel({ children }: { children: string }) {
  return (
    <T variant="small" style={{ fontWeight: '700' }}>
      {children}
    </T>
  );
}

function NoContacts() {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => router.push('/pair')}
      accessibilityRole="button"
      accessibilityLabel="Noch keine Freunde. Freund hinzufügen"
      style={{ minHeight: TOUCH, justifyContent: 'center' }}
    >
      <T variant="small">
        Noch keine Freunde. <Text style={{ color: t.accent, fontWeight: '700' }}>Freund hinzufügen ›</Text>
      </T>
    </Pressable>
  );
}

/** One person, optionally "jemand" (anyone I'm connected to). */
export function ContactPick({ value, onChange, allowAny }: { value: unknown; onChange: (key: string) => void; allowAny?: boolean }) {
  const { state } = useSnapshot();
  const known = typeof value === 'string' && (value === 'any' || state.contacts.some((c) => c.key === value));
  return (
    <View style={{ gap: spacing.xs }}>
      <Wrap>
        {allowAny && <Chip icon="👥" label="jemand" selected={value === 'any'} onPress={() => onChange('any')} />}
        {state.contacts.map((c) => (
          <Chip key={c.key} label={contactLabel(c)} selected={value === c.key} onPress={() => onChange(c.key)} />
        ))}
      </Wrap>
      {!state.contacts.length && <NoContacts />}
      {typeof value === 'string' && value !== '' && !known && <T variant="small">Diese Person ist nicht mehr in deinen Kontakten. Wähle jemand anderen.</T>}
    </View>
  );
}

/** Several people (at most `max`). */
export function ContactsPick({ value, onChange, max = 10 }: { value: unknown; onChange: (keys: string[]) => void; max?: number }) {
  const { state } = useSnapshot();
  const chosen = Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as string[]) : [];
  return (
    <View style={{ gap: spacing.xs }}>
      <Wrap>
        {state.contacts.map((c) => {
          const on = chosen.includes(c.key);
          return (
            <Chip
              key={c.key}
              icon={on ? '✓' : undefined}
              label={contactLabel(c)}
              selected={on}
              onPress={() => onChange(on ? chosen.filter((k) => k !== c.key) : chosen.length < max ? [...chosen, c.key] : chosen)}
            />
          );
        })}
      </Wrap>
      {!state.contacts.length && <NoContacts />}
      {chosen.length >= max && <T variant="small">{`Höchstens ${max} Personen.`}</T>}
    </View>
  );
}

/** One of my places, with a shortcut to create one. */
export function PlacePick({ value, onChange }: { value: unknown; onChange: (id: string) => void }) {
  const { state } = useSnapshot();
  const missing = typeof value === 'string' && value !== '' && !state.places.some((p) => p.id === value);
  return (
    <View style={{ gap: spacing.xs }}>
      <Wrap>
        {state.places.map((p) => (
          <Chip key={p.id} icon="📍" label={p.name} selected={value === p.id} onPress={() => onChange(p.id)} />
        ))}
        <Chip icon="➕" label="Neuer Ort" onPress={() => router.push('/place/new')} />
      </Wrap>
      {!state.places.length && <T variant="small">Du hast noch keine Orte. Lege z. B. „Zuhause“ an, dann geht es hier weiter.</T>}
      {missing && <T variant="small">Dieser Ort wurde gelöscht. Wähle einen anderen.</T>}
    </View>
  );
}

/** A row of choices. */
export function OptionPick<V extends string | number | undefined>({ options, value, onChange }: {
  options: { value: V; label: string; icon?: string }[];
  value: unknown;
  onChange: (v: V) => void;
}) {
  return (
    <Wrap>
      {options.map((o) => (
        <Chip key={String(o.value)} icon={o.icon} label={o.label} selected={value === o.value} onPress={() => onChange(o.value)} />
      ))}
    </Wrap>
  );
}

/** Whole minutes with presets and a field for other values. */
export function NumberPick({ value, onChange, presets, min, max, unit, label }: {
  value: unknown;
  onChange: (n: number) => void;
  presets: { value: number; label: string }[];
  min: number;
  max: number;
  unit: string;
  label: string;
}) {
  const t = useTheme();
  const n = typeof value === 'number' ? value : undefined;
  const isPreset = presets.some((p) => p.value === n);
  const [custom, setCustom] = useState(n !== undefined && !isPreset ? String(n) : '');
  const [open, setOpen] = useState(n !== undefined && !isPreset);
  const customNum = Number(custom);
  const customBad = custom !== '' && (!Number.isInteger(customNum) || customNum < min || customNum > max);
  return (
    <View style={{ gap: spacing.xs }}>
      <Wrap>
        {presets.map((p) => (
          <Chip
            key={p.value}
            label={p.label}
            selected={n === p.value && !open}
            onPress={() => {
              setOpen(false);
              onChange(p.value);
            }}
          />
        ))}
        <Chip label="Andere…" selected={open} onPress={() => setOpen(true)} />
      </Wrap>
      {open && (
        <Field
          label={`${label} (${min} bis ${max} ${unit})`}
          value={custom}
          keyboardType="number-pad"
          maxLength={5}
          onChangeText={(v) => {
            const digits = v.replace(/\D/g, '');
            setCustom(digits);
            const num = Number(digits);
            if (digits !== '' && Number.isInteger(num) && num >= min && num <= max) onChange(num);
          }}
          error={customBad ? `Bitte eine Zahl von ${min} bis ${max}.` : undefined}
        />
      )}
      {open && !customBad && custom === '' && <T variant="small" color={t.textMuted}>Gib eine Zahl ein.</T>}
    </View>
  );
}

const TIME_PRESETS = ['06:00', '08:00', '12:00', '17:00', '18:00', '20:00', '22:00'];

/** A time of day as HH:MM, typed or picked. */
export function TimePick({ value, onChange, label }: { value: unknown; onChange: (v: string) => void; label: string }) {
  const text = typeof value === 'string' ? value : '';
  return (
    <View style={{ gap: spacing.xs }}>
      <Field
        label={label}
        value={text}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        placeholder="22:00"
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, '').slice(0, 4);
          onChange(digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits);
        }}
        error={text.length >= 4 && !isTime(text) ? 'Bitte als Uhrzeit, z. B. 07:30 oder 22:00.' : undefined}
      />
      <Wrap>
        {TIME_PRESETS.map((p) => (
          <Chip key={p} label={p} selected={text === p} onPress={() => onChange(p)} />
        ))}
      </Wrap>
    </View>
  );
}

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export function WeekdayPick({ value, onChange }: { value: unknown; onChange: (days: number[]) => void }) {
  const t = useTheme();
  const days = Array.isArray(value) ? (value.filter((d) => typeof d === 'number') as number[]) : [];
  const same = (a: number[]) => a.length === days.length && a.every((d) => days.includes(d));
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {DAYS.map((d, i) => {
          const n = i + 1;
          const on = days.includes(n);
          return (
            <Pressable
              key={d}
              onPress={() => onChange(on ? days.filter((x) => x !== n) : [...days, n].sort())}
              accessibilityRole="checkbox"
              accessibilityLabel={DAY_NAMES[i]}
              accessibilityState={{ checked: on }}
              style={{
                minWidth: TOUCH,
                minHeight: TOUCH,
                borderRadius: radius.sm,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: on ? t.info : t.surfaceRaised,
                borderWidth: 1,
                borderColor: on ? t.info : t.border,
              }}
            >
              <Text style={{ color: on ? t.bg : t.text, fontWeight: '700' }}>{d}</Text>
            </Pressable>
          );
        })}
      </View>
      <Wrap>
        <Chip label="Werktags" selected={same([1, 2, 3, 4, 5])} onPress={() => onChange([1, 2, 3, 4, 5])} />
        <Chip label="Wochenende" selected={same([6, 7])} onPress={() => onChange([6, 7])} />
        <Chip label="Jeden Tag" selected={same([1, 2, 3, 4, 5, 6, 7])} onPress={() => onChange([1, 2, 3, 4, 5, 6, 7])} />
      </Wrap>
    </View>
  );
}

export const VARIABLE_TEXT: Record<string, string> = {
  contact: 'Person',
  place: 'Ort',
  eta: 'Ankunftszeit',
  destination: 'Ziel',
  text: 'Nachricht',
};

/** A text field with tappable placeholders like {{contact}} that the app fills in when the rule fires. */
export function VarText({ label, value, onChange, maxLength, vars, multiline, placeholder, optional }: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
  maxLength: number;
  vars: string[];
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
}) {
  const text = typeof value === 'string' ? value : '';
  return (
    <View style={{ gap: spacing.xs }}>
      <Field
        label={optional ? `${label} (freiwillig)` : label}
        value={text}
        onChangeText={onChange}
        maxLength={maxLength}
        multiline={multiline}
        minHeight={multiline ? 80 : undefined}
        placeholder={placeholder}
        counter
      />
      {vars.length > 0 && (
        <View style={{ gap: spacing.xs }}>
          <T variant="small">Einsetzen (wird beim Auslösen ersetzt):</T>
          <Wrap>
            {vars.map((v) => (
              <Chip
                key={v}
                icon="＋"
                label={VARIABLE_TEXT[v] ?? v}
                onPress={() => onChange(`${text}${text && !text.endsWith(' ') ? ' ' : ''}{{${v}}}`.slice(0, maxLength))}
              />
            ))}
          </Wrap>
        </View>
      )}
    </View>
  );
}
