import type { Alert } from '@heyda/core';
import { Text, View } from 'react-native';
import { spacing, useTheme } from '../../lib/theme';
import { Row, T } from '../ui';
import { alertIcon } from './describe';
import { ago } from './format';
import { ListRow } from './kit';

/** One line of the activity list: icon by category, title, text and how long ago. */
export function ActivityRow({ alert, now, onPress, first }: { alert: Alert; now: number; onPress: () => void; first?: boolean }) {
  const t = useTheme();
  const loud = alert.level === 'alarm';
  const when = ago(alert.at, now);
  return (
    <ListRow first={first} onPress={onPress} label={`${alert.title}. ${alert.body}. ${when}`}>
      <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
        <View style={{ width: 28, alignItems: 'center' }}>
          <Text style={{ fontSize: 20, lineHeight: 24 }} accessible={false}>
            {alertIcon(alert)}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }} gap={spacing.sm}>
            <T variant="h2" numberOfLines={2} style={{ flex: 1, fontSize: 15 }} color={loud ? t.danger : undefined}>
              {alert.title}
            </T>
            <T variant="small">{when}</T>
          </Row>
          {alert.body ? (
            <T variant="muted" numberOfLines={3}>
              {alert.body}
            </T>
          ) : null}
        </View>
      </Row>
    </ListRow>
  );
}
