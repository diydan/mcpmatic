import { useState } from "react";
import {
  passkeysAvailable,
  registerPasskey,
  signInWithPasskey,
} from "../lib/passkey-client";

type Props = {
  sessionToken: string;
  onSignedIn: (accountId: string) => void;
};

/**
 * Console-only. The passkey is what makes this account reachable from another
 * device or after storage is cleared; without one, the grants live and die
 * with this browser's localStorage.
 */
export function PasskeyBar({ sessionToken, onSignedIn }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!passkeysAvailable()) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="passkey">
      <button
        type="button"
        disabled={busy || !sessionToken}
        onClick={() =>
          void run(async () => {
            if (!sessionToken) return;
            const result = await registerPasskey(sessionToken);
            setStatus(
              result.ok
                ? "Passkey saved: your preferences will sync across devices"
                : result.message,
            );
          })
        }
      >
        Save with Passkey
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await signInWithPasskey();
            if (result.ok && result.accountId) {
              onSignedIn(result.accountId);
              setStatus("Signed in — saved settings restored");
              return;
            }
            setStatus(result.ok ? "Signed in" : result.message);
          })
        }
      >
        Sign in with Passkey
      </button>
      {status ? <span className="passkey__status">{status}</span> : null}
    </div>
  );
}
