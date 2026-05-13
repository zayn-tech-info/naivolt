import { Stack } from "expo-router";

export default function GiftCardTransactionLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: "#0D0D0D" },
      }}
    >
      <Stack.Screen
        name="[id]"
        options={{
          getId: ({ params }) => (params as { id?: string })?.id ?? "unknown",
        }}
      />
    </Stack>
  );
}
