import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { notice } from '../lib/confirm';
import { onToast, type Toast } from '../lib/notifications';
import { isNative } from '../lib/platform';
import { useContactName, useRuntime, useSnapshot, useTick } from '../lib/store';
import { radius, spacing, TOUCH, useTheme } from '../lib/theme';
import { myWatchDue, routeForToast } from './safety/alerts';
import { onFilled } from './safety/BigButton';
import { ago, hhmm } from './safety/time';

/** Long buzz, pause, long buzz; repeated until the alarm is dismissed. */
const PATTERN = [0, 900, 500, 900, 500];
const MAX_QUEUE = 20;

/**
 * Full-screen red alarm for SOS alerts and overdue "Pass auf mich auf" watches while the app
 * is open. Several alarms queue up and are shown one after another. Vibrates on phones until
 * dismissed; once the queue is empty nothing is rendered, so it never blocks other screens.
 */
export function AlarmOverlay() {
  const t = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const insets = useSafeAreaInsets();
  const { state, statuses } = useSnapshot();
  const nameOf = useContactName();
  const now = useTick(15_000);
  const [queue, setQueue] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onToast((toast) => {
        if (toast.level !== 'alarm') return;
        setQueue((q) => (q.some((x) => x.id === toast.id) ? q : [...q, toast].slice(-MAX_QUEUE)));
      }),
    [],
  );

  const current = queue[0];
  const alert = current?.alert;
  const owner = alert?.ref?.sosOwner;
  const who = alert?.from ? nameOf(alert.from) : owner ? nameOf(owner) : undefined;
  const ownWatchId = current ? myWatchDue(current.id) : undefined;

  // The emergency may be over by the time someone looks, or no more updates come: say so and stop buzzing.
  let resolved: string | undefined;
  // They removed me as a contact: no more updates, which does not mean the emergency is over.
  let noMoreUpdates = false;
  if (owner && owner !== state.self.key) {
    const s = statuses[owner]?.sos;
    if (s && s.sosId === alert?.ref?.sosId && s.endedAt) {
      noMoreUpdates = s.endReason === 'removed';
      resolved =
        s.endReason === 'safe'
          ? `${who} ist inzwischen in Sicherheit.`
          : noMoreUpdates
            ? `Du bekommst von ${who} keine Notruf-Updates mehr. Ob der Notruf vorbei ist, weißt du damit nicht.`
            : `${who} hat den Notruf abgebrochen.`;
    }
  } else if (alert?.from && alert.ref?.watchId) {
    const watchId = alert.ref.watchId;
    if (!(statuses[alert.from]?.watches ?? []).some((w) => w.watchId === watchId)) resolved = `${who} hat sich inzwischen gemeldet.`;
  } else if (ownWatchId && !state.watches.some((w) => w.watchId === ownWatchId)) {
    resolved = 'Erledigt: Du hast dich gemeldet.';
  }

  const ringing = !!current && !resolved;
  useEffect(() => {
    if (!ringing || !isNative) return;
    Vibration.vibrate(PATTERN, true);
    return () => Vibration.cancel();
  }, [ringing, current?.id]);

  useEffect(() => {
    if (current) AccessibilityInfo.announceForAccessibility(`${current.title}. ${current.body}`);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;

  const dismiss = () => setQueue((q) => q.slice(1));
  const view = () => {
    const target = routeForToast(alert, runtime.getSnapshot().state.self.key);
    dismiss();
    router.push(target);
  };
  const imOk = async () => {
    if (!ownWatchId) return;
    setBusy(true);
    try {
      await runtime.node.endWatch(ownWatchId, 'ok');
      dismiss();
    } catch (e) {
      notice('Das hat nicht geklappt', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fg = onFilled(t);
  const sos = alert?.category === 'sos' || !!owner;
  const at = alert?.at;
  const more = queue.length - 1;
  // The big icon already says it; don't repeat a leading ⏰/🆘 from the alert title.
  const title = current.title.replace(/^(⏰|🆘)\s*/u, '');
  // Once resolved, calm colours; while ringing, white-on-red (or dark-on-red in dark mode).
  const text = resolved ? t.text : fg;
  const muted = resolved ? t.textMuted : fg;
  const plate = resolved ? t.bg : t.danger;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={dismiss}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
    >
      <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: plate, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: spacing.xl }}>
          <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: spacing.lg, alignItems: 'center' }}>
            <Text accessible={false} style={{ fontSize: 76 }}>
              {resolved ? (noMoreUpdates ? 'ℹ️' : '✅') : sos ? '🆘' : '⏰'}
            </Text>
            <Text accessibilityRole="header" style={{ color: text, fontSize: 30, fontWeight: '900', textAlign: 'center' }}>
              {title}
            </Text>
            {current.body ? (
              <Text style={{ color: muted, fontSize: 19, fontWeight: '600', textAlign: 'center' }}>{current.body}</Text>
            ) : null}
            {at ? (
              <Text style={{ color: muted, fontSize: 15, textAlign: 'center' }}>
                {hhmm(at)} Uhr · {ago(at, now)}
              </Text>
            ) : null}
            {resolved ? (
              <Text style={{ color: noMoreUpdates ? t.text : t.success, fontSize: 19, fontWeight: '800', textAlign: 'center' }} accessibilityLiveRegion="polite">
                {resolved}
              </Text>
            ) : null}

            <View style={{ alignSelf: 'stretch', gap: spacing.md, marginTop: spacing.lg }}>
              {ownWatchId && !resolved ? (
                <OverlayButton title="✅ Mir geht's gut" filled fg={text} bg={plate} busy={busy} onPress={() => void imOk()} />
              ) : null}
              <OverlayButton
                title={ownWatchId ? 'Öffnen' : 'Ansehen'}
                filled={!ownWatchId || !!resolved}
                fg={text}
                bg={plate}
                onPress={view}
              />
              <OverlayButton title="Schließen" fg={text} bg={plate} onPress={dismiss} />
            </View>
            {more > 0 ? (
              <Text style={{ color: muted, fontSize: 15, fontWeight: '700' }}>
                {more === 1 ? 'Danach: 1 weiterer Alarm' : `Danach: ${more} weitere Alarme`}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Filled buttons invert the colours (plate colour on a text-coloured button); outline buttons keep them. */
function OverlayButton({
  title,
  onPress,
  filled,
  fg,
  bg,
  busy,
}: {
  title: string;
  onPress: () => void;
  filled?: boolean;
  fg: string;
  bg: string;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ busy: !!busy }}
      style={({ pressed }) => ({
        minHeight: TOUCH + 16,
        borderRadius: radius.md,
        borderWidth: 2,
        borderColor: fg,
        backgroundColor: filled ? fg : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        opacity: busy ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: filled ? bg : fg, fontSize: 19, fontWeight: '800' }}>{busy ? '…' : title}</Text>
    </Pressable>
  );
}
