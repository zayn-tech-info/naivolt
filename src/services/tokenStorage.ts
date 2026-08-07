/**
 * Token storage: tries Expo SecureStore first, then AsyncStorage, then in-memory.
 * In Expo Go / when native modules are null, uses in-memory so the app never crashes.
 * Token persists only for the current app session when using in-memory.
 */

const PREFIX = 'naivolt_secure_';

export const TOKEN_KEY = 'naivolt_token';
/**
 * The long-lived refresh token.
 *
 * Previously discarded, which is why closing the app meant signing in by SMS
 * again: the access token lasts 15 minutes and nothing outlived it. Kept in the
 * same secure store as the access token — it is the credential that lets a
 * returning user unlock with a PIN instead of another code.
 */
export const REFRESH_KEY = 'naivolt_refresh';
export const USER_KEY = 'naivolt_user';

const memoryStore: Record<string, string> = {};

function getSecureStore(): typeof import('expo-secure-store') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store');
  } catch {
    return null;
  }
}

type AsyncStorageModule = typeof import('@react-native-async-storage/async-storage').default;

function getAsyncStorage(): AsyncStorageModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-async-storage/async-storage').default;
  } catch {
    return null;
  }
}

export async function setToken(key: string, value: string): Promise<void> {
  try {
    const SecureStore = getSecureStore();
    if (SecureStore) {
      try {
        await SecureStore.setItemAsync(key, value);
        return;
      } catch {
        // fall through
      }
    }
  } catch {
    // getSecureStore() or require threw; fall through
  }
  try {
    const AsyncStorage = getAsyncStorage();
    if (AsyncStorage) {
      try {
        await AsyncStorage.setItem(PREFIX + key, value);
        return;
      } catch {
        // fall through
      }
    }
  } catch {
    // getAsyncStorage() or require threw; fall through
  }
  memoryStore[key] = value;
}

export async function getToken(key: string): Promise<string | null> {
  try {
    try {
      const SecureStore = getSecureStore();
      if (SecureStore) {
        try {
          const value = await SecureStore.getItemAsync(key);
          if (value != null) return value;
        } catch {
          // fall through
        }
      }
    } catch {
      // fall through
    }
    try {
      const AsyncStorage = getAsyncStorage();
      if (AsyncStorage) {
        try {
          const value = await AsyncStorage.getItem(PREFIX + key);
          if (value != null) return value;
        } catch {
          // fall through
        }
      }
    } catch {
      // fall through
    }
  } catch {
    // any unexpected error: fall back to memory
  }
  return memoryStore[key] ?? null;
}

export async function removeToken(key: string): Promise<void> {
  try {
    const SecureStore = getSecureStore();
    if (SecureStore) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  try {
    const AsyncStorage = getAsyncStorage();
    if (AsyncStorage) {
      try {
        await AsyncStorage.removeItem(PREFIX + key);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  delete memoryStore[key];
}

export async function saveUser(user: object): Promise<void> {
  await setToken(USER_KEY, JSON.stringify(user));
}

export async function getSavedUser(): Promise<object | null> {
  try {
    const raw = await getToken(USER_KEY);
    if (raw == null) return null;
    return JSON.parse(raw) as object;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await removeToken(TOKEN_KEY);
  await removeToken(REFRESH_KEY);
  await removeToken(USER_KEY);
}
