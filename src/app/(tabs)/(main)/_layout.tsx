import { Tabs } from "expo-router";
import { MainTabBar } from "@/components/navigation/MainTabBar";

export default function MainTabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <MainTabBar {...props} />}
      screenOptions={{ headerShown: false }}
      initialRouteName="index"
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="convert" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
