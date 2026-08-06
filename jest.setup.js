/**
 * Test environment setup.
 *
 * Mocks only the native modules that have no JS implementation under Jest.
 * Everything else runs for real — a suite that mocks the code it's testing
 * proves nothing.
 */

/* eslint-env jest */

// Reanimated ships its own mock; without it every animated component throws.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// Haptics and Clipboard are fire-and-forget native calls with no observable
// result in tests. Stubbed so components that call them don't reject.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

// AsyncStorage is a native module with no JS fallback. The package ships an
// in-memory mock for exactly this; anything reaching it in a test (the theme
// store, the onboarding flag) then behaves like a fresh install.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Silence the New Architecture / act() noise that jest-expo emits on render;
// real failures still surface because we only filter these two exact strings.
const IGNORED = [
  'useNativeDriver',
  'not wrapped in act',
];
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && IGNORED.some((s) => args[0].includes(s))) return;
  originalError(...args);
};
