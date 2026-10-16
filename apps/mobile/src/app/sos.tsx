import { contactLabel, type Contact, type MySos } from '@heyda/core';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BigButton, onFilled } from '../components/safety/BigButton';
import { Call112 } from '../components/safety/Call112';
import { ContactPicker, NoContacts, stillContacts } from '../components/safety/ContactPicker';
import { Field } from '../components/safety/Field';
import { HoldButton } from '../components/safety/HoldButton';
import { ago, hhmm } from '../components/safety/time';
import { Avatar, Button, Card, Hint, Row, T, Wrap } from '../components/ui';
import { confirm, notice } from '../lib/confirm';
import { callEmergency, callPhone, sendSosSms, smsAvailable } from '../lib/emergency';
import { locationSupported } from '../lib/location';
import { isNative } from '../lib/platform';
import { useRuntime, useSnapshot, useTick } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';

const COUNTDOWN_S = 5;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** Full-screen emergency screen: send an SOS, follow a running one, end it. */
export default function SosScreen() {
  const t = useTheme();
  const { state } = useSnapshot();
  const [ended, setEnded] = useState<'safe' | 'cancelled'>();
  const sos = state.sos;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'bottom', 'left', 'right']}>
      <TopBar running={!!sos} />
      {sos ? (
        <ActiveSos sos={sos} onEnded={setEnded} />
      ) : ended ? (
        <EndedView reason={ended} onAgain={() => setEnded(undefined)} />
      ) : (
        <StartSos />
      )}
    </SafeAreaView>
  );
}

function TopBar({ running }: { running: boolean }) {
  const t = useTheme();
  const pill = {
    minHeight: TOUCH,
    minWidth: TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  return (
    <Row style={{ justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.sm, minHeight: TOUCH + 8 }}>
      <T variant="h2" color={t.danger} style={{ flexShrink: 1 }}>
        {running ? '🆘 Notruf läuft' : '🆘 Notruf'}
      </T>
      <Row>
        {isNative && (
          // Always in reach, whatever is on screen. The phone app still asks before it dials.
          <Pressable
            onPress={() => void callEmergency('112').catch(() => notice('Anruf nicht möglich', 'Bitte wähle 112 direkt in deiner Telefon-App.'))}
            accessibilityRole="button"
            accessibilityLabel="112 anrufen"
            hitSlop={6}
            style={({ pressed }) => ({ ...pill, borderColor: t.danger, backgroundColor: pressed ? t.surfaceRaised : t.surface })}
          >
            <Text style={{ color: t.danger, fontSize: 15, fontWeight: '800' }}>📞 112</Text>
          </Pressable>
        )}
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={running ? 'Schließen. Der Notruf läuft weiter.' : 'Schließen'}
          hitSlop={6}
          style={({ pressed }) => ({ ...pill, borderColor: t.border, backgroundColor: pressed ? t.surfaceRaised : t.surface })}
        >
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>✕ Schließen</Text>
          {running ? <Text style={{ color: t.textMuted, fontSize: 11 }}>läuft weiter</Text> : null}
        </Pressable>
      </Row>
    </Row>
  );
}

function Body({ children, scrollEnabled = true }: { children: ReactNode; scrollEnabled?: boolean }) {
  return (
    <ScrollView
      scrollEnabled={scrollEnabled}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl * 2 }}
    >
      <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: spacing.lg }}>{children}</View>
    </ScrollView>
  );
}

// ---- not active: send ---------------------------------------------------------------------------

function StartSos() {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, isDemo } = useSnapshot();
  const { width } = useWindowDimensions();
  const emergency = runtime.node.emergencyContacts();
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState(state.sosMessage ?? '');
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const sending = useRef(false);

  const recipients = emergency.length ? emergency.map((c) => c.key) : stillContacts(picked, state.contacts);
  const noContacts = state.contacts.length === 0;

  async function send() {
    if (sending.current || !recipients.length) return;
    sending.current = true;
    setBusy(true);
    setCountdown(null);
    try {
      await runtime.triggerSos({ text: text.trim() || undefined, recipients });
    } catch (e) {
      notice('Notruf nicht gesendet', `${errorText(e)}\n\nIm Zweifel: Ruf 112 an.`);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  // Screen reader path: a 5-second countdown that can be cancelled.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      void send();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const size = Math.max(180, Math.min(240, width - 140));

  return (
    <Body scrollEnabled={!holding}>
      <View style={{ gap: spacing.xs }}>
        <T variant="title">Hilfe holen</T>
        <T variant="muted">Deine Notfallkontakte bekommen sofort einen lauten Alarm, auch wenn ihr Handy auf leise steht.</T>
      </View>

      {isDemo && <Hint>Demo: Der Alarm geht nur an die Demo-Freunde. Du kannst es gefahrlos ausprobieren.</Hint>}

      {countdown !== null ? (
        <Card style={{ alignItems: 'center', gap: spacing.md, borderColor: t.danger, borderWidth: 2 }}>
          <T variant="h2" style={{ textAlign: 'center' }}>
            Notruf wird gesendet in
          </T>
          <Text
            style={{ color: t.danger, fontSize: 72, fontWeight: '900' }}
            accessibilityLiveRegion="assertive"
            accessibilityLabel={`${countdown} Sekunden`}
          >
            {countdown}
          </Text>
          <BigButton title="Abbrechen" kind="secondary" onPress={() => setCountdown(null)} style={{ alignSelf: 'stretch' }} />
          <Button title="Sofort senden" kind="danger" compact onPress={() => void send()} />
        </Card>
      ) : (
        <HoldButton
          size={size}
          busy={busy}
          disabled={!recipients.length}
          disabledText={noContacts ? 'Füge zuerst Kontakte hinzu oder ruf die 112 an.' : 'Wähle unten zuerst, wer den Alarm bekommt.'}
          onHoldChange={setHolding}
          onComplete={() => void send()}
          onAccessibleActivate={() => setCountdown(COUNTDOWN_S)}
        />
      )}

      {noContacts ? (
        <NoContacts text="Ein Notruf geht an Menschen aus deinen Kontakten. Füge zuerst jemanden hinzu. Die 112 kannst du immer anrufen." />
      ) : emergency.length ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="h2">Geht an</T>
            <Button title="Ändern" kind="ghost" compact onPress={() => router.push('/safety')} />
          </Row>
          <Wrap>
            {emergency.map((c) => (
              <RecipientTag key={c.key} contact={c} />
            ))}
          </Wrap>
        </Card>
      ) : (
        <Card>
          <T variant="h2">Wer soll den Alarm bekommen?</T>
          <T variant="small">Du hast noch keine Notfallkontakte. Wähle jetzt, wer ihn bekommt.</T>
          <ContactPicker contacts={state.contacts} selected={recipients} onChange={setPicked} label="Empfänger des Notrufs" />
          <Button title="Notfallkontakte festlegen" kind="ghost" compact onPress={() => router.push('/safety')} />
        </Card>
      )}

      {!noContacts && (
        <Field
          label="Nachricht (optional)"
          value={text}
          onChangeText={setText}
          placeholder="z. B. Ich brauche Hilfe, bitte ruf mich an!"
          maxLength={200}
          multiline
          counter
        />
      )}

      {!noContacts && (
        <Row style={{ alignItems: 'flex-start' }}>
          <Text accessible={false} style={{ fontSize: 18 }}>
            📍
          </Text>
          <T variant="small" style={{ flex: 1 }}>
            {isDemo
              ? 'Im Demo-Modus wird kein echter Standort verwendet.'
              : locationSupported
                ? 'Dein genauer Standort wird mitgeschickt und eine Stunde lang aktualisiert, auch im Geistmodus.'
                : 'Dein genauer Standort wird mitgeschickt, wenn dieses Gerät ihn kennt. Am Computer ist das meist nicht der Fall.'}
          </T>
        </Row>
      )}

      <Call112 />
    </Body>
  );
}

function RecipientTag({ contact }: { contact: Contact }) {
  const t = useTheme();
  return (
    <Row
      gap={spacing.xs}
      style={{
        backgroundColor: t.surfaceRaised,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: t.border,
        paddingLeft: 4,
        paddingRight: spacing.md,
        paddingVertical: 4,
      }}
    >
      <Avatar name={contactLabel(contact)} keyHex={contact.key} size={28} />
      <T>{contactLabel(contact)}</T>
    </Row>
  );
}

// ---- active -------------------------------------------------------------------------------------

function ActiveSos({ sos, onEnded }: { sos: MySos; onEnded: (r: 'safe' | 'cancelled') => void }) {
  const t = useTheme();
  const runtime = useRuntime();
  const { state, settings, isDemo } = useSnapshot();
  const now = useTick(5000);
  const [busy, setBusy] = useState<'safe' | 'cancelled' | 'renew' | 'more' | 'sms'>();
  const [smsOk, setSmsOk] = useState(false);
  const [smsDone, setSmsDone] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void smsAvailable().then((ok) => alive && setSmsOk(ok));
    return () => {
      alive = false;
    };
  }, []);

  const fallback = runtime.node.sosFallback();
  const showSms = settings.smsFallback && smsOk && !!fallback?.phones.length;
  const fix = runtime.node.freshFix(10 * 60_000);
  const locationLive = now < sos.locationUntil;
  const fg = onFilled(t);

  const rows = sos.recipients
    .map((key) => ({ key, contact: state.contacts.find((c) => c.key === key), ack: sos.acks.find((a) => a.key === key) }))
    .sort((a, b) => Number(!!b.ack) - Number(!!a.ack));
  const others = state.contacts.filter((c) => !sos.recipients.includes(c.key));
  const helping = sos.acks.length;

  async function end(reason: 'safe' | 'cancelled') {
    if (reason === 'cancelled') {
      const ok = await confirm({
        title: 'War es ein Fehlalarm?',
        message: 'Alle, die den Alarm bekommen haben, erfahren, dass es ein Versehen war.',
        ok: 'Ja, Fehlalarm',
        cancel: 'Nein, Notruf läuft weiter',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(reason);
    try {
      await runtime.node.endSos(reason);
      onEnded(reason);
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function sms() {
    setBusy('sms');
    try {
      const r = await sendSosSms(runtime);
      if (r === 'sent') setSmsDone(true);
      else if (r === 'no-numbers') notice('Keine Telefonnummern', 'Trag in den Notfall-Einstellungen Telefonnummern für deine Notfallkontakte ein.');
      else if (r === 'unavailable') notice('SMS nicht möglich', 'Auf diesem Gerät kann keine SMS verschickt werden.');
    } catch (e) {
      notice('SMS nicht möglich', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function renew(recipients?: string[]) {
    setBusy(recipients ? 'more' : 'renew');
    try {
      await runtime.triggerSos(recipients ? { recipients } : {});
      if (recipients) {
        setExtra([]);
        setShowMore(false);
      }
    } catch (e) {
      notice('Das hat nicht geklappt', errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  let locationText: string;
  if (isDemo) locationText = 'Im Demo-Modus wird kein echter Standort gesendet.';
  else if (!locationLive) locationText = `Standort-Updates sind seit ${hhmm(sos.locationUntil)} beendet.`;
  else if (fix) locationText = `Dein genauer Standort wurde gesendet und wird bis ${hhmm(sos.locationUntil)} aktualisiert.`;
  else if (!locationSupported) locationText = 'Dieses Gerät kennt deinen Standort nicht. Der Notruf ging ohne Standort raus.';
  else locationText = 'Dein Standort ist gerade nicht bekannt. Er wird nachgeschickt, sobald dein Handy ihn hat.';

  return (
    <Body>
      <View
        accessibilityRole="summary"
        style={{ backgroundColor: t.danger, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm }}
      >
        <Text style={{ color: fg, fontSize: 28, fontWeight: '900' }}>Dein Notruf läuft</Text>
        <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>
          seit {hhmm(sos.startedAt)} Uhr · {ago(sos.startedAt, now)}
        </Text>
        <Text style={{ color: fg, fontSize: 16 }}>
          {helping
            ? `${helping === 1 ? '1 Person kümmert sich' : `${helping} Personen kümmern sich`} um dich.`
            : `${sos.recipients.length === 1 ? '1 Person wurde' : `${sos.recipients.length} Personen wurden`} alarmiert. Warte auf Antwort …`}
        </Text>
        {sos.text ? <Text style={{ color: fg, fontSize: 16, fontStyle: 'italic' }}>„{sos.text}“</Text> : null}
      </View>

      <Card>
        <Row style={{ alignItems: 'flex-start' }}>
          <Text accessible={false} style={{ fontSize: 18 }}>
            📍
          </Text>
          <T variant="small" style={{ flex: 1 }}>
            {locationText}
          </T>
        </Row>
        {!isDemo && !locationLive && (
          <Button title="Standort wieder senden" icon="📍" kind="secondary" compact busy={busy === 'renew'} onPress={() => void renew()} />
        )}
      </Card>

      <View style={{ gap: spacing.sm }}>
        <T variant="h2">Alarmiert</T>
        {rows.map(({ key, contact, ack }) => {
          const name = contact ? contactLabel(contact) : 'Unbekannt';
          return (
            <Card key={key} style={ack ? { borderColor: t.success, borderWidth: 1 } : undefined}>
              <Row gap={spacing.md}>
                <Avatar name={name} keyHex={key} size={40} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="h2">{name}</T>
                  {ack ? (
                    <T variant="small" color={t.success}>
                      ✅ kümmert sich · {ago(ack.at, now)}
                    </T>
                  ) : (
                    <T variant="small">Alarmiert · noch keine Antwort</T>
                  )}
                  {ack?.text ? <T>„{ack.text}“</T> : null}
                </View>
                {isNative && contact?.phone ? (
                  <Button title="Anrufen" icon="📞" kind="secondary" compact onPress={() => void callPhone(contact.phone!).catch(() => {})} />
                ) : null}
              </Row>
            </Card>
          );
        })}
      </View>

      <BigButton
        kind="safe"
        icon="✅"
        title="Ich bin in Sicherheit"
        subtitle="Beendet den Notruf für alle"
        busy={busy === 'safe'}
        disabled={!!busy && busy !== 'safe'}
        onPress={() => void end('safe')}
      />

      {showSms && (
        <Card style={{ borderColor: t.info, borderWidth: 1 }}>
          <T variant="h2">Auch per SMS senden?</T>
          <T variant="small">
            Für alle, die gerade kein Internet haben. Dein Handy öffnet eine fertige SMS mit deinem Standort, du drückst nur noch
            auf Senden.
          </T>
          <BigButton
            kind="secondary"
            icon="✉️"
            title={smsDone ? 'SMS nochmal öffnen' : 'Auch per SMS senden'}
            subtitle={`an ${fallback!.phones.length === 1 ? '1 Nummer' : `${fallback!.phones.length} Nummern`}`}
            busy={busy === 'sms'}
            onPress={() => void sms()}
          />
          {smsDone && (
            <T variant="small" color={t.success}>
              ✓ SMS vorbereitet
            </T>
          )}
        </Card>
      )}

      <Call112 />

      {others.length > 0 && (
        <Card>
          {!showMore ? (
            <Button title="Weitere Kontakte alarmieren" icon="➕" kind="secondary" compact onPress={() => setShowMore(true)} />
          ) : (
            <>
              <T variant="h2">Wen noch alarmieren?</T>
              <ContactPicker contacts={others} selected={stillContacts(extra, others)} onChange={setExtra} label="Weitere Empfänger" />
              <Button
                title="Auch alarmieren"
                icon="🆘"
                kind="danger"
                disabled={!stillContacts(extra, others).length}
                busy={busy === 'more'}
                onPress={() => void renew(stillContacts(extra, others))}
              />
            </>
          )}
        </Card>
      )}

      <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
        <BigButton
          kind="quiet"
          title="Fehlalarm"
          subtitle="Versehentlich ausgelöst? Hier abbrechen."
          busy={busy === 'cancelled'}
          disabled={!!busy && busy !== 'cancelled'}
          onPress={() => void end('cancelled')}
        />
        <T variant="small" style={{ textAlign: 'center' }}>
          Du kannst diesen Bildschirm schließen. Der Notruf läuft weiter, bis du ihn beendest.
        </T>
      </View>
    </Body>
  );
}

// ---- ended -----------------------------------------------------------------------------------------

function EndedView({ reason, onAgain }: { reason: 'safe' | 'cancelled'; onAgain: () => void }) {
  const t = useTheme();
  return (
    <Body>
      <Card style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl }}>
        <Text accessible={false} style={{ fontSize: 56 }}>
          {reason === 'safe' ? '💚' : '👍'}
        </Text>
        <T variant="big" style={{ textAlign: 'center' }}>
          {reason === 'safe' ? 'Schön, dass du in Sicherheit bist' : 'Fehlalarm gemeldet'}
        </T>
        <T variant="muted" style={{ textAlign: 'center' }}>
          {reason === 'safe'
            ? 'Der Notruf ist beendet. Alle, die ihn bekommen haben, wissen jetzt Bescheid.'
            : 'Alle, die den Alarm bekommen haben, wissen jetzt, dass es ein Versehen war.'}
        </T>
        <BigButton title="Fertig" kind="primary" onPress={close} style={{ alignSelf: 'stretch' }} />
        <Button title="Neuen Notruf senden" kind="ghost" compact onPress={onAgain} />
      </Card>
      <T variant="small" style={{ textAlign: 'center' }} color={t.textMuted}>
        Magst du kurz Bescheid sagen, was los war? Das beruhigt deine Leute.
      </T>
    </Body>
  );
}
