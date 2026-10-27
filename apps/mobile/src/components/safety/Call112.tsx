import { Text, View } from 'react-native';
import { notice } from '../../lib/confirm';
import { callEmergency } from '../../lib/emergency';
import { isNative } from '../../lib/platform';
import { spacing, useTheme } from '../../lib/theme';
import { Card, Row, T } from '../ui';
import { BigButton } from './BigButton';

/** "112 anrufen" on a phone; on the computer an explanation that calling needs a phone. */
export function Call112({ subtitle = 'Rettungsdienst, Feuerwehr, Polizei' }: { subtitle?: string }) {
  const t = useTheme();
  if (isNative) {
    return (
      <BigButton
        kind="outline"
        icon="📞"
        title="112 anrufen"
        subtitle={subtitle}
        onPress={() =>
          void callEmergency('112').catch(() => notice('Anruf nicht möglich', 'Bitte wähle 112 direkt in deiner Telefon-App.'))
        }
      />
    );
  }
  return (
    <Card style={{ borderColor: t.danger }}>
      <Row style={{ alignItems: 'flex-start' }} gap={spacing.md}>
        <Text accessible={false} style={{ fontSize: 26 }}>
          📞
        </Text>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="h2" color={t.danger}>
            Notruf 112
          </T>
          <T variant="small">Anrufen geht nur vom Handy aus. Wähle dort die 112: Das klappt in ganz Europa, auch ohne Guthaben.</T>
        </View>
      </Row>
    </Card>
  );
}
