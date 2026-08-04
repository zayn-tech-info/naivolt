import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect } from "react";
import { Appearance } from "react-native";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastProvider } from "@/components/ui";
import { useAppFonts, useTheme } from "@/design";
import { useAppStore } from "@/store/appStore";
import { initMonitoring, Sentry } from "@/services/monitoring";

// Before anything else renders, so a crash during startup is still reported.
initMonitoring();

// Hold the native splash until fonts and persisted theme are ready. Without
// this the first frame renders in the fallback system font at the wrong metrics
// and then reflows once Instrument Sans loads, which reads as a broken launch.
SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30 * 1000,
    },
  },
});

function AppShell() {
  const hydrate = useAppStore((s) => s.hydrate);
  const syncSystemMode = useAppStore((s) => s.syncSystemMode);
  const mode = useAppStore((s) => s.mode);
  const { c } = useTheme();
  const [fontsLoaded, fontError] = useAppFonts();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      syncSystemMode(colorScheme);
    });
    return () => subscription.remove();
  }, [syncSystemMode]);

  const onReady = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  // A font that fails to download shouldn't strand the user on the splash
  // screen — fall through to system fonts and let the app run.
  const ready = fontsLoaded || !!fontError;

  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  if (!ready) return null;

  return (
    <ToastProvider>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.primaryBackground },
          animation: "slide_from_right",
        }}
      />
    </ToastProvider>
  );
}

function RootLayout() {
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

// Sentry.wrap adds native crash context and touch/navigation breadcrumbs. It
// wraps the outermost component, outside the ErrorBoundary, so a render error
// the boundary catches is still reported rather than only shown.
export default Sentry.wrap(RootLayout);
