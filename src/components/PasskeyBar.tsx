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
                ? "passkey added — this account now works on another device"
                : result.message,
            );
          })
        }
      >
        add a passkey
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await signInWithPasskey();
            if (result.ok && result.accountId) {
              onSignedIn(result.accountId);
              setStatus("signed in — grants restored");
              return;
            }
            setStatus(result.ok ? "signed in" : result.message);
          })
        }
      >
        sign in with a passkey
      </button>
      {status ? <span className="passkey__status">{status}</span> : null}
    </div>
  );
}
