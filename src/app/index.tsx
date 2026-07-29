import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet, Image } from "react-native";
import { useAuthStore } from "@/store/authStore";
import { useAuthHydration } from "@/hooks/useAuthHydration";

const SPLASH_LOGO = require("../../assets/images/icon.png");

export default function Index() {
  const router = useRouter();
  const { isHydrated, token, user } = useAuthStore();
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useAuthHydration();

  useEffect(() => {
    timerRef.current = setTimeout(() => setSplashMinElapsed(true), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isHydrated || !splashMinElapsed) return;

    if (token && user) {
      if (user.role === "admin") {
        router.replace("/(admin)/dashboard");
      } else {
        router.replace("/(tabs)/(main)");
      }
    } else {
      router.replace("/(auth)/welcome");
    }
  }, [isHydrated, splashMinElapsed, token, user, router]);

  return (
    <View style={styles.placeholder}>
      <Image source={SPLASH_LOGO} style={styles.logo} resizeMode="contain" />
      <Text style={styles.appName}>Naivolt</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    backgroundColor: "#0A0A0B",
    justifyContent: "center",
    alignItems: "center",
  },
  logo: {
    width: 160,
    height: 160,
  },
  appName: {
    marginTop: 24,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 1,
    color: "#AAFF00",
  },
});
