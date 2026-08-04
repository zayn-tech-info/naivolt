import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Text } from '@/components/ui';

function TabLabel({
  label,
  focused,
  color,
}: {
  label: string;
  focused: boolean;
  color: string;
}) {
  return (
    <Text
      variant="caption"
      style={{
        color,
        fontWeight: focused ? '600' : '500',
        marginTop: 2,
      }}
      numberOfLines={1}
    >
      {label}
    </Text>
  );
}

export default function MainTabsLayout() {
  const { c, iconSize, space } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: c.primaryBackground },
        tabBarActiveTintColor: c.primaryAccent,
        tabBarInactiveTintColor: c.tertiaryText,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.hairline,
          borderTopWidth: StyleSheet.hairlineWidth,
          elevation: 0,
          shadowOpacity: 0,
          paddingTop: space.tight,
        },
        tabBarItemStyle: {
          paddingVertical: space.tight,
        },
      }}
      initialRouteName="index"
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarLabel: ({ focused, color }) => (
            <TabLabel label="Home" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? 'home' : 'home-outline'}
              size={iconSize.large}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="convert"
        options={{
          title: 'Rate',
          tabBarLabel: ({ focused, color }) => (
            <TabLabel label="Rate" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? 'stats-chart' : 'stats-chart-outline'}
              size={iconSize.large}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'Activity',
          tabBarLabel: ({ focused, color }) => (
            <TabLabel label="Activity" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? 'receipt' : 'receipt-outline'}
              size={iconSize.large}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: ({ focused, color }) => (
            <TabLabel label="Profile" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? 'person-circle' : 'person-circle-outline'}
              size={iconSize.large}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
