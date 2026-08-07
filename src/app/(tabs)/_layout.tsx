import { Stack } from "expo-router";
import { useTheme } from "@/design";

export default function TabsGroupLayout() {
  // Was hardcoded to the dark canvas, which showed as a near-black flash behind
  // transitions in light mode.
  const { c } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: c.primaryBackground },
      }}
      initialRouteName="(main)"
    >
      <Stack.Screen name="(main)" />
    </Stack>
  );
}
