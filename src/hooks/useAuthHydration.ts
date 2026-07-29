import { useEffect } from "react";
import { decode } from "base-64";
import axios from "axios";
import { useAuthStore, type User } from "@/store/authStore";
import { getToken, clearSession, TOKEN_KEY, saveUser } from "@/services/tokenStorage";
import { resetIfStaleSchema } from "@/services/sessionReset";
import { config } from "@/constants/config";

const AUTH_ME_URL = `${config.apiUrl}/v2/me`;
const REQUEST_TIMEOUT_MS = 8000;

function toUser(apiUser: {
  id: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  kycTier?: number;
  role?: string;
}): User {
  return {
    _id: apiUser.id,
    name: apiUser.displayName ?? "",
    email: apiUser.email ?? "",
    phone: apiUser.phone ?? undefined,
    kycTier: apiUser.kycTier ?? 0,
    role: apiUser.role as "user" | "admin" | undefined,
  };
}

export function useAuthHydration() {
  const { setUser, setToken, setHydrated } = useAuthStore();

  useEffect(() => {
    async function hydrate() {
      try {
        // Sessions from the v1 backend can never validate — that server is gone.
        // Clearing them here is what returns the device to onboarding.
        const wasReset = await resetIfStaleSchema();
        if (wasReset) {
          setHydrated(true);
          return;
        }

        const token = await getToken(TOKEN_KEY);
        if (!token) {
          setHydrated(true);
          return;
        }

        const parts = token.split(".");
        if (parts.length !== 3) {
          await clearSession();
          setHydrated(true);
          return;
        }

        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
        const payload = JSON.parse(decode(padded)) as { exp?: number };
        if (payload.exp == null || payload.exp * 1000 <= Date.now()) {
          await clearSession();
          setHydrated(true);
          return;
        }

        const { data, status } = await axios.get<{ user?: Parameters<typeof toUser>[0] }>(
          AUTH_ME_URL,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true,
          },
        );

        if (status === 200 && data?.user) {
          const user = toUser(data.user);
          setToken(token);
          setUser(user);
          await saveUser(user);
        } else {
          await clearSession();
        }
      } catch {
        await clearSession();
      } finally {
        setHydrated(true);
      }
    }

    hydrate();
  }, [setUser, setToken, setHydrated]);
}
