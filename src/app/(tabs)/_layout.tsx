import { Stack } from "expo-router";

export default function TabsGroupLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: "#08090A" },
      }}
      initialRouteName="(main)"
    >
      <Stack.Screen name="(main)" />
    </Stack>
  );
}
