import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Alert, TouchableOpacity } from "react-native";
import { useConvertGuard } from "@/hooks/useConvertGuard";
import { useColors } from "@/store/appStore";

const BANK_ALERT_TITLE = "Bank details required";
const BANK_ALERT_MESSAGE =
  "You need to set your bank details first before you can convert. Add a bank account in Profile to receive Naira payments.";

export default function MainTabsLayout() {
  const router = useRouter();
  const { hasBankDetails, isLoading } = useConvertGuard();
  const c = useColors();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: c.primaryAccent,
        tabBarInactiveTintColor: c.secondaryText,
      }}
      initialRouteName="index"
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? "home" : "home-outline"}
              size={24}
              color={focused ? c.primaryAccent : c.secondaryText}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="convert"
        options={{
          title: "Convert",
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? "swap-horizontal" : "swap-horizontal-outline"}
              size={24}
              color={focused ? c.primaryAccent : c.secondaryText}
            />
          ),
          tabBarButton: (props) => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (isLoading) return;
                if (!hasBankDetails) {
                  Alert.alert(BANK_ALERT_TITLE, BANK_ALERT_MESSAGE, [
                    { text: "OK", style: "cancel" },
                    {
                      text: "Go to Profile",
                      onPress: () => router.replace("/(tabs)/(main)/profile"),
                    },
                  ]);
                  return;
                }
                props.onPress?.({ defaultPrevented: false });
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? "time" : "time-outline"}
              size={24}
              color={focused ? c.primaryAccent : c.secondaryText}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ focused }) => (
            <Ionicons
              name={focused ? "person" : "person-outline"}
              size={24}
              color={focused ? c.primaryAccent : c.secondaryText}
            />
          ),
        }}
      />
    </Tabs>
  );
}
