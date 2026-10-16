import { CHECKIN_LABELS, PING_LABELS, type CheckinKind, type PingKind } from '@heyda/core';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useSnapshot } from '../../lib/store';
import { durationLabel } from '../../lib/templates-ui';
import { spacing } from '../../lib/theme';
import { Bullet, Field } from '../setup/kit';
import { Chip, T, Wrap } from '../ui';
import { variablesFor, type Obj } from './catalog';
import { ContactPick, ContactsPick, NumberPick, OptionPick, PickLabel, PlacePick, TimePick, VarText, WeekdayPick } from './pickers';

type Patch = (patch: Obj) => void;

const PING_OPTIONS = (Object.keys(PING_LABELS) as PingKind[]).map((k) => ({
  value: k,
  icon: PING_LABELS[k].emoji,
  label: k === 'custom' ? 'Eigener Text' : PING_LABELS[k].text,
}));
const CHECKIN_OPTIONS = (Object.keys(CHECKIN_LABELS) as CheckinKind[]).map((k) => ({ value: k, icon: CHECKIN_LABELS[k].emoji, label: CHECKIN_LABELS[k].text }));
const ETA_PRESETS = [
  { value: 0, label: 'gleich da' },
  { value: 2, label: '2 Min.' },
  { value: 5, label: '5 Min.' },
  { value: 10, label: '10 Min.' },
  { value: 15, label: '15 Min.' },
  { value: 30, label: '30 Min.' },
];
const DND_PRESETS = [0, 30, 60, 120, 240, 480, 720, 1440].map((m) => ({ value: m, label: m === 0 ? 'Ausschalten' : durationLabel(m) }));
const HOUR_PRESETS = [1, 2, 4, 8, 12, 24].map((h) => ({ value: h, label: `${h} Std.` }));
const STATUS_EMOJIS = ['🏠', '💼', '🏋️', '🎬', '🍽️', '😴', '🚗', '✈️', '📚', '🎉'];
const PLACE_SUGGESTIONS = ['Zuhause', 'Arbeit', 'Schule', 'Supermarkt', 'Sport'];

/** Place names friends actually sent, so a typed name matches theirs. */
function useSeenPlaceNames(): string[] {
  const { statuses } = useSnapshot();
  return useMemo(() => {
    const names = new Set<string>();
    for (const s of Object.values(statuses)) if (s.lastPlace?.placeName) names.add(s.lastPlace.placeName);
    return [...names].slice(0, 8);
  }, [statuses]);
}

export function TriggerParams({ trigger, onPatch }: { trigger: Obj; onPatch: Patch }) {
  const seen = useSeenPlaceNames();
  const on = String(trigger.on);
  if (on === 'me.arrive' || on === 'me.leave') {
    return (
      <View style={{ gap: spacing.xs }}>
        <PickLabel>Welcher Ort?</PickLabel>
        <PlacePick value={trigger.place} onChange={(place) => onPatch({ place })} />
      </View>
    );
  }
  const place = typeof trigger.place === 'string' ? trigger.place : undefined;
  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ gap: spacing.xs }}>
        <PickLabel>Wer?</PickLabel>
        <ContactPick value={trigger.contact} onChange={(contact) => onPatch({ contact })} allowAny />
      </View>
      {(on === 'contact.arrive' || on === 'contact.leave') && (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Wo?</PickLabel>
          <Wrap>
            <Chip label="Egal wo" selected={place === undefined} onPress={() => onPatch({ place: undefined })} />
            {[...new Set([...seen, ...PLACE_SUGGESTIONS])].map((p) => (
              <Chip key={p} icon={seen.includes(p) ? '👀' : undefined} label={p} selected={place === p} onPress={() => onPatch({ place: p })} />
            ))}
          </Wrap>
          <Field value={place ?? ''} onChangeText={(v) => onPatch({ place: v === '' ? undefined : v })} maxLength={60} placeholder="Oder Name eintippen" />
          <T variant="small">So, wie die Person ihren Ort genannt hat. 👀 = kam schon mal bei dir an.</T>
        </View>
      )}
      {on === 'contact.eta_below' && (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Wie nah?</PickLabel>
          <NumberPick value={trigger.minutes} onChange={(minutes) => onPatch({ minutes })} presets={ETA_PRESETS} min={0} max={120} unit="Minuten" label="Minuten" />
        </View>
      )}
      {on === 'contact.trip_end' && (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Wie endet die Fahrt?</PickLabel>
          <OptionPick
            value={trigger.reason}
            onChange={(reason) => onPatch({ reason })}
            options={[
              { value: undefined, label: 'Egal' },
              { value: 'arrived', label: 'Angekommen', icon: '🏁' },
              { value: 'stopped', label: 'Teilen beendet', icon: '✋' },
              { value: 'expired', label: 'Zeit abgelaufen', icon: '⌛' },
            ]}
          />
        </View>
      )}
      {on === 'contact.message' && (
        <Field
          label="Nur wenn dieses Wort vorkommt (freiwillig)"
          value={typeof trigger.contains === 'string' ? trigger.contains : ''}
          onChangeText={(contains) => onPatch({ contains })}
          maxLength={60}
          placeholder="z. B. Hilfe"
        />
      )}
      {on === 'contact.ping' && (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Welcher Ping?</PickLabel>
          <OptionPick value={trigger.kind} onChange={(kind) => onPatch({ kind })} options={[{ value: undefined, label: 'Jeder Ping' }, ...PING_OPTIONS]} />
        </View>
      )}
      {on === 'contact.checkin' && (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Welche Meldung?</PickLabel>
          <OptionPick value={trigger.kind} onChange={(kind) => onPatch({ kind })} options={[{ value: undefined, label: 'Jede Meldung' }, ...CHECKIN_OPTIONS]} />
        </View>
      )}
      {on === 'contact.sos' && <Bullet icon="🔔">Ein Notruf klingelt bei dir sowieso immer laut. Hier lässt du zusätzlich etwas passieren.</Bullet>}
    </View>
  );
}

export function ConditionParams({ condition, onPatch }: { condition: Obj; onPatch: Patch }) {
  switch (condition.if) {
    case 'time_between':
      return (
        <View style={{ gap: spacing.md }}>
          <TimePick label="Ab" value={condition.from} onChange={(from) => onPatch({ from })} />
          <TimePick label="Bis" value={condition.to} onChange={(to) => onPatch({ to })} />
          <T variant="small">Über Mitternacht geht auch, z. B. 22:00 bis 06:00.</T>
        </View>
      );
    case 'weekday':
      return <WeekdayPick value={condition.days} onChange={(days) => onPatch({ days })} />;
    default:
      return <PlacePick value={condition.place} onChange={(place) => onPatch({ place })} />;
  }
}

export function ActionParams({ action, trigger, onPatch }: { action: Obj; trigger: Obj | undefined; onPatch: Patch }) {
  const vars = variablesFor(trigger);
  switch (action.do) {
    case 'notify':
      return (
        <View style={{ gap: spacing.md }}>
          <VarText label="Überschrift" value={action.title} onChange={(title) => onPatch({ title })} maxLength={60} vars={vars} />
          <VarText label="Text" value={action.body} onChange={(body) => onPatch({ body })} maxLength={200} vars={vars} multiline />
        </View>
      );
    case 'send_ping':
      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>An wen?</PickLabel>
            <ContactPick value={action.to} onChange={(to) => onPatch({ to })} />
          </View>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Welcher Ping?</PickLabel>
            <OptionPick value={action.kind} onChange={(kind) => onPatch({ kind })} options={PING_OPTIONS} />
          </View>
          {action.kind === 'custom' && <VarText label="Eigener Text" value={action.text} onChange={(text) => onPatch({ text })} maxLength={280} vars={vars} optional placeholder="👋" />}
        </View>
      );
    case 'send_message':
      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>An wen?</PickLabel>
            <ContactPick value={action.to} onChange={(to) => onPatch({ to })} />
          </View>
          <VarText label="Nachricht" value={action.text} onChange={(text) => onPatch({ text })} maxLength={280} vars={vars} multiline placeholder="z. B. Bin gleich da!" />
        </View>
      );
    case 'send_checkin':
      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>An wen?</PickLabel>
            <ContactsPick value={action.to} onChange={(to) => onPatch({ to })} />
          </View>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Was melden?</PickLabel>
            <OptionPick value={action.kind} onChange={(kind) => onPatch({ kind })} options={CHECKIN_OPTIONS} />
          </View>
          <VarText label="Eigener Text" value={action.text} onChange={(text) => onPatch({ text })} maxLength={140} vars={vars} optional />
        </View>
      );
    case 'set_dnd':
      return (
        <View style={{ gap: spacing.xs }}>
          <PickLabel>Ruhemodus</PickLabel>
          <NumberPick value={action.minutes} onChange={(minutes) => onPatch({ minutes })} presets={DND_PRESETS} min={0} max={1440} unit="Minuten" label="Dauer in Minuten" />
          <T variant="small">Notrufe kommen immer durch, auch im Ruhemodus.</T>
        </View>
      );
    case 'set_status':
      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Emoji</PickLabel>
            <Wrap>
              <Chip label="Keins" selected={!action.emoji} onPress={() => onPatch({ emoji: undefined })} />
              {STATUS_EMOJIS.map((e) => (
                <Chip key={e} label={e} selected={action.emoji === e} onPress={() => onPatch({ emoji: e })} />
              ))}
            </Wrap>
          </View>
          <VarText label="Status-Text" value={action.text} onChange={(text) => onPatch({ text })} maxLength={80} vars={vars} placeholder="z. B. Zuhause" />
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Wie lange?</PickLabel>
            <NumberPick value={action.hours} onChange={(hours) => onPatch({ hours })} presets={HOUR_PRESETS} min={1} max={24} unit="Stunden" label="Stunden" />
          </View>
        </View>
      );
    case 'start_trip':
      return (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Mit wem?</PickLabel>
            <ContactsPick value={action.to} onChange={(to) => onPatch({ to })} />
          </View>
          <View style={{ gap: spacing.xs }}>
            <PickLabel>Wohin?</PickLabel>
            <PlacePick value={action.destination} onChange={(destination) => onPatch({ destination })} />
          </View>
          <Bullet icon="🔒">Automationen teilen nur die Ankunftszeit, nie deinen Standort. Dein Gerät zeigt an, solange geteilt wird, und du kannst jederzeit stoppen.</Bullet>
        </View>
      );
    default:
      return null;
  }
}
