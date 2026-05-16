import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/store/appStore";
import { useConvertGuard } from "@/hooks/useConvertGuard";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TAB_CONFIG: Record<string, { icon: IoniconName; iconFocused: IoniconName; label: string }> = {
  index:   { icon: "home-outline",           iconFocused: "home",           label: "Home"    },
  convert: { icon: "swap-horizontal-outline", iconFocused: "swap-horizontal", label: "Convert" },
  history: { icon: "receipt-outline",         iconFocused: "receipt",         label: "History" },
  profile: { icon: "person-circle-outline",   iconFocused: "person-circle",   label: "Profile" },
};

export function MainTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { hasBankDetails, isLoading: convertLoading } = useConvertGuard();

  const handlePress = (routeName: string, routeKey: string, isFocused: boolean) => {
    if (routeName === "convert") {
      if (convertLoading) return;
      if (!hasBankDetails) {
        const { Alert } = require("react-native");
        Alert.alert(
          "Bank details required",
          "Add a bank account to receive Naira payments.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Add bank account", onPress: () => navigation.navigate("profile") },
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

  return (
    <View style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={[styles.pill, { backgroundColor: c.surface }]}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          const config = TAB_CONFIG[route.name];
          if (!config) return null;

          return (
            <Pressable
              key={route.key}
              onPress={() => handlePress(route.name, route.key, isFocused)}
              style={styles.tabWrap}
              android_ripple={{ color: "transparent" }}
            >
              <View style={[styles.chip, isFocused && { backgroundColor: c.primaryAccent }]}>
                <Ionicons
                  name={isFocused ? config.iconFocused : config.icon}
                  size={22}
                  color={isFocused ? "#fff" : c.secondaryText}
                />
                {isFocused && (
                  <Text style={styles.chipLabel} numberOfLines={1}>
                    {config.label}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingTop: 8,
    backgroundColor: "transparent",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 6,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
      },
      android: { elevation: 10 },
    }),
  },
  tabWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.1,
  },
});
