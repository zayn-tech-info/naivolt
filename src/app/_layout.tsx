import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform } from "react-native";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAppStore } from "@/store/appStore";
import { useAuthStore } from "@/store/authStore";
import * as Notifications from "expo-notifications";
import { api } from "@/services/api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPushNotificationsAsync() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Naivolt",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#AAFF00",
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: "a75c3cda-e829-42d2-89a5-f971adf7f2ff",
    });
    const authToken = useAuthStore.getState().token;
    if (authToken && token) {
      await api.patch("/profile/push-token", { pushToken: token });
    }
  } catch {}
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30 * 1000,
    },
  },
});

function AppShell() {
  const { hydrate, mode } = useAppStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  const bg = mode === "dark" ? "#0A0A0B" : "#F5F5F7";

  return (
    <>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: bg },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <AppShell />
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
