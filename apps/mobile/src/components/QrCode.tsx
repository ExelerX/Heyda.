import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { create } from 'qrcode/lib/core/qrcode';

const QUIET = 4; // modules of white border scanners need

/**
 * Renders a QR code as one SVG path. Always black on white, also in dark mode:
 * inverted codes fail on many scanners.
 */
export function QrCode({ value, size = 260, label }: { value: string; size?: number; label?: string }) {
  const { path, count } = useMemo(() => {
    const { modules } = create(value, { errorCorrectionLevel: 'M' });
    let d = '';
    // One rectangle per horizontal run of dark modules: fewer seams, smaller path.
    for (let y = 0; y < modules.size; y++) {
      let x = 0;
      while (x < modules.size) {
        if (!modules.get(y, x)) {
          x++;
          continue;
        }
        const start = x;
        while (x < modules.size && modules.get(y, x)) x++;
        d += `M${start + QUIET} ${y + QUIET}h${x - start}v1h-${x - start}z`;
      }
    }
    return { path: d, count: modules.size + QUIET * 2 };
  }, [value]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label ?? 'QR-Code'}
      style={{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 8, alignSelf: 'center' }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect width={count} height={count} fill="#FFFFFF" />
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}
