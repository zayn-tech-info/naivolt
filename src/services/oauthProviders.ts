/**
 * Google and Apple sign-in.
 *
 * Both modules are imported statically. An earlier version tried to `require`
 * them lazily so the app would still bundle without them installed — that can't
 * work: Metro resolves every require at build time, so a dynamic module name is
 * an outright bundling error, and even a static require of a missing package
 * fails resolution. The dependencies are real dependencies.
 *
 * Configuration still varies at runtime, so both entry points degrade to a clear
 * message rather than a crash:
 *   - Google needs a client id (EXPO_PUBLIC_GOOGLE_*_CLIENT_ID)
 *   - Apple needs iOS and the capability enabled
 */

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';

export interface OidcResult {
  idToken: string;
  /** Apple returns this only on the very first authorization, never again. */
  fullName?: string;
}

const GOOGLE_DISCOVERY = 'https://accounts.google.com';

function googleClientId(): string | undefined {
  return (
    Platform.select({
      ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
      default: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    }) ?? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  );
}

/** Whether the button should be shown at all. */
export function isProviderAvailable(provider: 'google' | 'apple'): boolean {
  if (provider === 'apple') return Platform.OS === 'ios';
  return googleClientId() != null;
}

/**
 * Returns null when the user dismissed the sheet — a cancellation is not a
 * failure and must not surface as an error.
 */
export async function signInWithGoogle(): Promise<OidcResult | null> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error(
      'Google sign-in is not configured in this build. Use your phone number for now.',
    );
  }

  const discovery = await AuthSession.fetchDiscoveryAsync(GOOGLE_DISCOVERY);

  // A nonce binds the returned token to this request. Google echoes it back in
  // the ID token, and the server compares — without it a token captured
  // elsewhere could be replayed here.
  const nonce = randomNonce();

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri: AuthSession.makeRedirectUri({ scheme: 'naivolt' }),
    // We only ever want the ID token; an access token would be a credential we
    // have no use for and would then have to protect.
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ['openid', 'profile', 'email'],
    extraParams: { nonce },
  });

  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') return null;

  const idToken = result.params?.id_token;
  if (!idToken) throw new Error('Google did not return an identity token');
  return { idToken };
}

export async function signInWithApple(): Promise<OidcResult | null> {
  if (!(await AppleAuthentication.isAvailableAsync())) {
    throw new Error('Sign in with Apple is not available on this device.');
  }

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      throw new Error('Apple did not return an identity token');
    }

    // Present on first authorization only — forward it now or lose it forever.
    const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ');

    return { idToken: credential.identityToken, fullName: fullName || undefined };
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
    throw err;
  }
}

function randomNonce(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
