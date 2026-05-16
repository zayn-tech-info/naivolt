import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAppStore } from "@/store/appStore";

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
