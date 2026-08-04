import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* One screen for both sign-in and sign-up — see register.tsx. */}
      <Stack.Screen name="register" />
      <Stack.Screen name="verify" />
      {/* Gesture off: backing out mid-setup would leave an account with no PIN. */}
      <Stack.Screen name="set-pin" options={{ gestureEnabled: false }} />
      <Stack.Screen name="login" />
    </Stack>
  );
}
