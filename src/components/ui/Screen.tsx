/**
 * Screen — the page shell.
 *
 * Every screen was previously repeating the same SafeAreaView + ScrollView +
 * paddingHorizontal:20 block and each one guessed differently at the bottom
 * inset, so content ended up tucked under the floating tab bar on some screens
 * and floating well above it on others. One component now owns that.
 */

import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/design';
import { Text } from './Text';

/**
 * @deprecated Floating pill tab bar clearance. The default tab navigator already
 * reserves bar height; prefer `tabBarClearance` which only adds scroll breathing room.
 */
export const TAB_BAR_CLEARANCE = 96;

export interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView. Off for screens that own their own list. */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * Extra scroll breathing room on tab screens. The tab navigator already clears
   * the bar; this is only end-of-list padding, not a second bar inset.
   */
  tabBarClearance?: boolean;
  /** Horizontal gutter. */
  gutter?: number;
  /** Which edges get safe-area padding. */
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  style?: ViewStyle;
  contentStyle?: ViewStyle;
}

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  tabBarClearance = false,
  gutter,
  edges = ['top'],
  style,
  contentStyle,
}: ScreenProps) {
  const { c, space } = useTheme();
  const insets = useSafeAreaInsets();

  const pad = gutter ?? space.roomy;
  // Tab scenes sit above the native tab bar already. Only add modest list end
  // padding; non-tab screens still need the home-indicator inset.
  const bottomPad = tabBarClearance ? space.section : space.section + insets.bottom;

  if (!scroll) {
    return (
      <SafeAreaView
        edges={edges}
        style={[{ flex: 1, backgroundColor: c.primaryBackground }, style]}
      >
        <View style={[{ flex: 1, paddingHorizontal: pad }, contentStyle]}>{children}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: c.primaryBackground }, style]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          { paddingHorizontal: pad, paddingBottom: bottomPad },
          contentStyle,
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={c.primaryAccent}
              colors={[c.primaryAccent]}
              progressBackgroundColor={c.surface}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Section — a titled block.
 *
 * Titles use the tracked-uppercase utility register rather than another large
 * bold heading, so section structure is legible without every screen turning
 * into a stack of competing 18px titles.
 */
export function Section({
  title,
  action,
  children,
  first = false,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  first?: boolean;
}) {
  const { space } = useTheme();

  return (
    <View style={{ marginTop: first ? space.comfy : space.section }}>
      {title || action ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: space.base,
          }}
        >
          {title ? (
            <Text variant="eyebrow" color="tertiaryText">
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export default Screen;
