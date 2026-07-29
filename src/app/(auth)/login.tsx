/**
 * Kept only so existing links and deep links don't 404.
 *
 * Passwordless auth collapses sign-in and sign-up into one screen: the same
 * Google tap or phone number either finds an account or creates one. Two doors
 * to the same room just makes people pick the wrong one.
 */

import { Redirect } from 'expo-router';

export default function LoginScreen() {
  return <Redirect href="/register" />;
}
