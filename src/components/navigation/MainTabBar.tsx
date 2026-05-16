import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/store/appStore";
import { useConvertGuard } from "@/hooks/useConvertGuard";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

const ICON_SIZE = 24;

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const TAB_CONFIG: Record<string, { icon: IoniconName; iconFocused: IoniconName; label: string }> = {
  index:   { icon: "home-outline",            iconFocused: "home",            label: "Home"    },
  convert: { icon: "swap-horizontal-outline",  iconFocused: "swap-horizontal",  label: "Convert" },
  history: { icon: "receipt-outline",          iconFocused: "receipt",          label: "History" },
  profile: { icon: "person-circle-outline",    iconFocused: "person-circle",    label: "Profile" },
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
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10), borderTopColor: c.border, backgroundColor: c.surface }]}>
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const config = TAB_CONFIG[route.name];
        if (!config) return null;

        return (
          <Pressable
            key={route.key}
            onPress={() => handlePress(route.name, route.key, isFocused)}
            style={styles.tab}
            android_ripple={{ color: c.accentDim, borderless: true, radius: 32 }}
          >
            {isFocused && <View style={[styles.dot, { backgroundColor: c.primaryAccent }]} />}
            <Ionicons
              name={isFocused ? config.iconFocused : config.icon}
              size={ICON_SIZE}
              color={isFocused ? c.primaryAccent : c.secondaryText}
            />
            <Text
              style={[styles.label, { color: isFocused ? c.primaryAccent : c.secondaryText }]}
              numberOfLines={1}
            >
              {config.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 4,
    gap: 3,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginBottom: 1,
  },
  label: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
});
