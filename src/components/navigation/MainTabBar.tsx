import { View, Text, Pressable, StyleSheet, Platform, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/store/appStore";
import { useConvertGuard } from "@/hooks/useConvertGuard";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

const ICON_SIZE = 22;

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TAB_CONFIG: Record<string, { icon: IoniconName; iconFocused: IoniconName; label: string }> = {
  index:   { icon: "home-outline",           iconFocused: "home",           label: "Home"    },
  convert: { icon: "swap-horizontal-outline", iconFocused: "swap-horizontal", label: "Convert" },
  history: { icon: "time-outline",            iconFocused: "time",           label: "History" },
  profile: { icon: "person-outline",          iconFocused: "person",         label: "Profile" },
};

export function MainTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { hasBankDetails, isLoading: convertLoading } = useConvertGuard();

  const handlePress = (routeName: string, routeKey: string, isFocused: boolean) => {
    if (routeName === "convert") {
      if (convertLoading) return;
      if (!hasBankDetails) {
        Alert.alert(
          "Bank details required",
          "Add a bank account in Profile to receive Naira payments.",
          [
            { text: "Not now", style: "cancel" },
            {
              text: "Go to Profile",
              onPress: () => navigation.navigate("profile"),
            },
          ]
        );
        return;
      }
    }

    const event = navigation.emit({ type: "tabPress", target: routeKey, canPreventDefault: true });
    if (!isFocused && !event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  const paddingBottom = Math.max(insets.bottom, 8);

  return (
    <View
      style={[
        styles.outerWrap,
        {
          paddingBottom,
          backgroundColor: c.surface,
        },
      ]}
    >
      {/* accent line at top */}
      <View style={[styles.accentLine, { backgroundColor: c.primaryAccent }]} />

      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          const config = TAB_CONFIG[route.name];
          if (!config) return null;

          return (
            <Pressable
              key={route.key}
              onPress={() => handlePress(route.name, route.key, isFocused)}
              style={styles.tabItem}
              android_ripple={{ color: c.accentDim, borderless: true, radius: 36 }}
            >
              {/* icon pill */}
              <View
                style={[
                  styles.iconPill,
                  isFocused && {
                    backgroundColor: c.accentDim,
                  },
                ]}
              >
                <Ionicons
                  name={isFocused ? config.iconFocused : config.icon}
                  size={ICON_SIZE}
                  color={isFocused ? c.primaryAccent : c.secondaryText}
                />
              </View>

              {/* label */}
              <Text
                style={[
                  styles.label,
                  { color: isFocused ? c.primaryAccent : c.secondaryText },
                  isFocused && styles.labelActive,
                ]}
                numberOfLines={1}
              >
                {config.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrap: {
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  accentLine: {
    height: 2,
    width: 48,
    borderRadius: 1,
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 4,
    opacity: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
    gap: 3,
  },
  iconPill: {
    width: 52,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  labelActive: {
    fontWeight: "700",
  },
});
