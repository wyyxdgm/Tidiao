"use client";

import { useEffect } from "react";

/**
 * Patches window.fetch globally so that any 401 response triggers a redirect
 * to /login (with ?from=currentPath). This handles session expiry gracefully
 * without needing to change every individual fetch call.
 */
export default function AuthGuard() {
  useEffect(() => {
    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit
    ) {
      const response = await originalFetch.call(window, input, init);

      if (response.status === 401) {
        // Avoid redirect loop: if already on /login, do nothing
        if (window.location.pathname === "/login") return response;

        const from = window.location.pathname + window.location.search;
        window.location.href = `/login?from=${encodeURIComponent(from)}`;
        // Return the original response so callers don't crash before the redirect lands
        return response;
      }

      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null; // renders nothing
}
