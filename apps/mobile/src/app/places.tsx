import { contactLabel } from '@heyda/core';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Narrow } from '../components/setup/kit';
import { TileMap } from '../components/TileMap';
import { Button, Card, Empty, Hint, Row, Screen, Section, T } from '../components/ui';
import { notice } from '../lib/confirm';
import { currentLocationAccess, locationSupported, MAX_REGIONS, requestLocationAccess, type LocationAccess } from '../lib/location';
import { isDesktop } from '../lib/platform';
import { useSnapshot } from '../lib/store';
import { spacing, useTheme } from '../lib/theme';

export default function Places() {
  const t = useTheme();
  const { state, settings, isDemo } = useSnapshot();
  const [access, setAccess] = useState<LocationAccess>();
  const full = state.places.length >= MAX_REGIONS;

  useEffect(() => {
    if (locationSupported && !isDemo) void currentLocationAccess().then(setAccess).catch(() => {});
  }, [isDemo]);

  async function askAlways() {
    try {
      const a = await requestLocationAccess();
      setAccess(a);
      if (a !== 'always') notice('Noch nicht „Immer“', 'Öffne die Einstellungen deines Handys → Heyda. → Standort und wähle „Immer erlauben“.');
    } catch {
      notice('Das hat nicht geklappt', 'Öffne die Einstellungen deines Handys → Heyda. → Standort.');
    }
  }

  const viewersOf = (placeId: string) =>
    state.contacts.filter((c) => state.grants.some((g) => g.contactKey === c.key && g.placeIds.includes(placeId)));

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Meine Orte' }} />
      <Narrow>
        <Hint>
          Deine Orte bleiben auf deinem Gerät. Freunde, denen du einen Ort freigibst, bekommen nur „ist angekommen“ oder „ist losgegangen“ mit dem Namen. Nie die Koordinaten.
        </Hint>

        {isDemo && <Banner tone="info" icon="🎮">Demo: Die Orte liegen um einen erfundenen Punkt in Berlin. Dein echter Standort wird nicht benutzt.</Banner>}
        {!isDemo && isDesktop && (
          <Banner tone="info" icon="💻">
            Am PC gibt es kein GPS. Anlegen und Bearbeiten geht hier trotzdem: Deine Orte gleichen sich mit deinem Handy ab, und das Handy erkennt Ankunft und Abfahrt.
          </Banner>
        )}
        {access && access !== 'always' && state.places.length > 0 && (
          <Banner tone="warn" title="Ankunft wird noch nicht erkannt">
            <T variant="small" color={t.text}>
              Damit dein Handy Ankunft und Abfahrt auch bei geschlossener App bemerkt, braucht Heyda. den Standort „Immer erlauben“.
            </T>
            <Button title="Standort erlauben" kind="ghost" compact onPress={() => void askAlways()} style={{ alignSelf: 'flex-start' }} />
          </Banner>
        )}

        {settings.mapEnabled && state.places.length > 0 && (
          <TileMap
            height={220}
            markers={state.places.map((p) => ({ id: p.id, lat: p.center.lat, lon: p.center.lon, label: p.name, kind: 'place' as const, accuracyM: p.radiusM }))}
          />
        )}

        {state.places.length === 0 ? (
          <Empty
            icon="📍"
            title="Noch keine Orte"
            text="Speichere z. B. Zuhause, die Arbeit oder die Schule. Dann können Freunde, die du auswählst, „ist angekommen“ bekommen, und deine Automationen reagieren darauf."
            action={<Button title="Ersten Ort anlegen" icon="📍" onPress={() => router.push('/place/new')} />}
          />
        ) : (
          state.places.map((p) => {
            const viewers = viewersOf(p.id);
            return (
              <Card key={p.id} onPress={() => router.push(`/place/${encodeURIComponent(p.id)}`)} label={`${p.name}, ${p.radiusM} Meter, bearbeiten`}>
                <Row gap={spacing.md}>
                  <Text style={{ fontSize: 24 }} accessible={false}>
                    📍
                  </Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T variant="h2">{p.name}</T>
                    <T variant="small">{`Umkreis ${p.radiusM} m`}</T>
                    <T variant="small" color={viewers.length ? t.text : t.textMuted}>
                      {viewers.length ? `🔔 Bescheid bekommen: ${viewers.map(contactLabel).join(', ')}` : '🔕 Niemand bekommt Bescheid'}
                    </T>
                  </View>
                  <Text style={{ color: t.textMuted, fontSize: 22 }} accessible={false}>
                    ›
                  </Text>
                </Row>
              </Card>
            );
          })
        )}

        {state.places.length > 0 && (
          <Section title="Neuer Ort">
            {full ? (
              <Banner tone="warn" title={`Höchstens ${MAX_REGIONS} Orte`}>
                {`Dein Handy kann nur ${MAX_REGIONS} Orte gleichzeitig überwachen. Lösche einen, um einen neuen anzulegen.`}
              </Banner>
            ) : (
              <Button title="Neuen Ort anlegen" icon="➕" onPress={() => router.push('/place/new')} />
            )}
            <T variant="small">{`${state.places.length} von ${MAX_REGIONS} Orten. Mehr kann ein Handy nicht gleichzeitig überwachen.`}</T>
          </Section>
        )}
      </Narrow>
    </Screen>
  );
}
