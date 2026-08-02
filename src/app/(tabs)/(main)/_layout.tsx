import { Tabs } from "expo-router";
import { MainTabBar } from "@/components/navigation/MainTabBar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function MainTabsLayout() {
  const insets = useSafeAreaInsets();
  // Extra padding so content clears the floating pill (pill ~56px + inset + 8px gap)
  const tabBarHeight = 66 + Math.max(insets.bottom, 12) + 10;

  return (
    <Tabs
      tabBar={(props) => <MainTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
        // `contentStyle` is a Stack option; Tabs uses `sceneStyle`. The old
        // key was silently ignored, so screens were relying on Screen's own
        // tabBarClearance for the gap.
        sceneStyle: { paddingBottom: tabBarHeight },
      }}
      initialRouteName="index"
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="convert" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
