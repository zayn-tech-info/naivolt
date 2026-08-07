// User auth state (token, user object)

import { create } from 'zustand';
import { clearSession } from '@/services/tokenStorage';
import { identifyUser } from '@/services/monitoring';

export interface User {
  _id?: string;
  /** May be empty — phone signup collects no name, and none is required. */
  name: string;
  username?: string;
  email: string;
  phone?: string;
  /** What the user chose to be called. Not the KYC legal name. */
  displayName?: string | null;
  /** Seed for the generated avatar. */
  avatarSeed?: string | null;
  /** 0 = signed up but unverified. Gates withdrawal, nothing else. */
  kycTier?: number;
  role?: 'user' | 'admin';
}

interface AuthState {
  user: User | null;
  token: string | null;
  isHydrated: boolean;
  isAuthenticated: boolean;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setHydrated: (value: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isHydrated: false,
  isAuthenticated: false,
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
    // Id only — never email, name or phone. See services/monitoring.ts.
    identifyUser(user?._id ?? null);
  },
  setToken: (token) => set({ token }),
  setHydrated: (value) => set({ isHydrated: value }),
  logout: () => {
    set({ user: null, token: null, isAuthenticated: false });
    identifyUser(null);
    void clearSession();
  },
}));
