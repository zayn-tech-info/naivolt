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
    // outer wrapper — screen background, holds safe-area padding
    <View style={[styles.wrapper, { backgroundColor: c.primaryBackground, paddingBottom: Math.max(insets.bottom, 8) }]}>
      {/* floating pill */}
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
              {/* active = accent chip that looks cut out of the pill */}
              <View style={[styles.chip, isFocused && { backgroundColor: c.primaryAccent }]}>
                <Ionicons
                  name={isFocused ? config.iconFocused : config.icon}
                  size={20}
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
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 50,
    paddingVertical: 5,
    paddingHorizontal: 5,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.10,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
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
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 50,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.1,
  },
});
