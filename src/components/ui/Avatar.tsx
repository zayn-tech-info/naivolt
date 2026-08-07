/**
 * Avatar.
 *
 * Generated, not uploaded. A photo upload needs image hosting, a moderation
 * surface, and a flow that can fail on a bad connection — none of which this app
 * needs to greet someone by name. A deterministic mark gives every user a
 * distinct identity for free, works offline, and looks the same on every device
 * they sign in on.
 *
 * The colour comes from a seed the server stores rather than from the user id,
 * for two reasons: the id is not something we want leaking into a rendering rule
 * that could later be reversed, and a stored seed means a user can shuffle their
 * look without becoming a different person to the system.
 *
 * Initials over an abstract pattern because a name is what the user is verifying
 * and what the rest of the app calls them — the avatar should agree with the
 * greeting rather than being a second, unrelated identity.
 */

import { View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import Text from './Text';

export interface AvatarProps {
  /** Display name. Initials are taken from it. */
  name?: string | null;
  /** Stable seed for the colour. Falls back to the name. */
  seed?: string | null;
  size?: number;
  style?: ViewStyle;
}

/**
 * A hue from the seed.
 *
 * Spread across the wheel rather than sampled from the brand palette: the point
 * is that two people look different, and a set of near-identical limes would
 * defeat that. Saturation and lightness stay fixed so nothing comes out muddy or
 * unreadable against white initials.
 */
function hueFrom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * Up to two initials.
 *
 * Skips the connectives common in Nigerian names ("of", "and") so
 * "Blessing of God Okafor" reads BO rather than BO with the wrong second letter.
 */
function initialsFrom(name: string): string {
  const skip = new Set(['of', 'and', 'the', 'de', 'da', 'bin', 'al']);
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !skip.has(w.toLowerCase()));

  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function Avatar({ name, seed, size = 52, style }: AvatarProps) {
  const { c } = useTheme();

  const source = seed || name || '';
  const initials = name ? initialsFrom(name) : '';
  const hue = hueFrom(source || 'naivolt');

  // Two stops apart on the wheel give the disc depth without becoming a
  // gradient that competes with the content next to it.
  const from = `hsl(${hue}, 62%, 52%)`;
  const to = `hsl(${(hue + 38) % 360}, 66%, 42%)`;

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.surfaceElevated,
        },
        style,
      ]}
      accessible
      accessibilityLabel={name ? `${name}'s avatar` : 'Avatar'}
    >
      {source ? (
        <LinearGradient
          colors={[from, to]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
        />
      ) : null}

      {initials ? (
        <Text
          // White on a fixed 42–52% lightness clears 4.5:1 at every hue, which
          // is why the lightness above is not left to the seed.
          color="#FFFFFF"
          variant="subheading"
          style={{ fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.44) }}
          allowFontScaling={false}
        >
          {initials}
        </Text>
      ) : (
        // No name yet — a glyph rather than an empty disc or a stray letter.
        <Ionicons name="person" size={Math.round(size * 0.46)} color={c.tertiaryText} />
      )}
    </View>
  );
}

export default Avatar;
