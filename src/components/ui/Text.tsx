/**
 * The only text component. Takes a token from the type scale rather than
 * loose fontSize/fontWeight props, which is what keeps the scale from eroding.
 */

import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from '@/design';
import { type as typeScale, tabular, type TypeToken } from '@/design/typography';
import type { Colors } from '@/constants/colors';

type ColorToken = keyof Colors;

export interface TextProps extends RNTextProps {
  /** A token from the type scale. */
  variant?: TypeToken;
  /** A palette key, or any raw colour string. */
  color?: ColorToken | string;
  align?: 'left' | 'center' | 'right';
  /** Nudge the resolved font size — for the rare responsive case only. */
  sizeDelta?: number;
}

const MONO_VARIANTS = new Set<TypeToken>([
  'display',
  'figure',
  'amount',
  'amountSmall',
  'code',
  'ticker',
]);

export function Text({
  variant = 'body',
  color = 'primaryText',
  align,
  sizeDelta,
  style,
  ...rest
}: TextProps) {
  const { c } = useTheme();
  const base = typeScale[variant];
  const resolved = color in c ? c[color as ColorToken] : (color as string);

  return (
    <RNText
      {...rest}
      style={[
        base,
        MONO_VARIANTS.has(variant) && tabular,
        { color: resolved },
        align ? { textAlign: align } : null,
        sizeDelta
          ? { fontSize: base.fontSize + sizeDelta, lineHeight: base.lineHeight + sizeDelta }
          : null,
        style,
      ]}
    />
  );
}

export default Text;
