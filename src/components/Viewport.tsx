import { useEffect, useRef } from "react";
import { mapCanvasToViewport } from "../../shared/coords";
import type { BrowserState } from "../../shared/protocol";

const REMOTE = { width: 1280, height: 720 };

type Props = {
  jpeg: string | null;
  driving: boolean;
  browser: BrowserState;
  onInput: (msg: {
    kind: "mouse" | "key";
    action: string;
    x?: number;
    y?: number;
    button?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    text?: string;
  }) => void;
};

const STATUS: Record<BrowserState, string> = {
  live: "remote chromium",
  idle: "browser starts when you grant an origin",
  missing: "no browser binding",
};

export function Viewport({ jpeg, driving, browser, onInput }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !jpeg) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${jpeg}`;
  }, [jpeg]);

  const mapEvent = (e: React.PointerEvent | React.WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return mapCanvasToViewport(
      e.clientX - rect.left,
      e.clientY - rect.top,
      { width: rect.width, height: rect.height },
      REMOTE,
      window.devicePixelRatio,
    );
  };

  return (
    <section className="viewport" aria-label="Remote browser">
      <header className="viewport__bar">
        <span className="viewport__dot" data-live={browser === "live"} />
        <span>{STATUS[browser]}</span>
        {driving ? <span className="viewport__driving">agent driving</span> : null}
      </header>
      <div className="viewport__stage">
        <canvas
          ref={canvasRef}
          className="viewport__canvas"
          tabIndex={0}
          aria-label="Remote page. Keystrokes cross our infrastructure."
          style={{ pointerEvents: driving ? "none" : "auto" }}
          onPointerMove={(e) => {
            if (driving) return;
            const p = mapEvent(e);
            if (p) onInput({ kind: "mouse", action: "moved", ...p });
          }}
          onPointerDown={(e) => {
            if (driving) return;
            const p = mapEvent(e);
            if (p)
              onInput({
                kind: "mouse",
                action: "pressed",
                button: e.button,
                ...p,
              });
          }}
          onPointerUp={(e) => {
            if (driving) return;
            const p = mapEvent(e);
            if (p)
              onInput({
                kind: "mouse",
                action: "released",
                button: e.button,
                ...p,
              });
          }}
          onWheel={(e) => {
            if (driving) return;
            const p = mapEvent(e);
            if (p)
              onInput({
                kind: "mouse",
                action: "wheel",
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                ...p,
              });
          }}
          onKeyDown={(e) => {
            if (driving) return;
            // Leave browser shortcuts (Cmd+R, Ctrl+W) to the local browser.
            // They are not ours to swallow, and not ours to forward either.
            if (e.metaKey || e.ctrlKey) return;
            // Otherwise Space scrolls the façade and Tab leaves the canvas.
            e.preventDefault();
            if (e.key.length === 1) {
              onInput({ kind: "key", action: "insert", text: e.key });
            } else {
              onInput({ kind: "key", action: "down", key: e.key });
            }
          }}
          onKeyUp={(e) => {
            if (driving) return;
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            // A char insert needs no release; a virtual key does.
            if (e.key.length === 1) return;
            onInput({ kind: "key", action: "up", key: e.key });
          }}
        />
        {!jpeg ? (
          <p className="viewport__empty">
            {browser === "missing"
              ? "Browser Rendering is not bound here. Shopify native tools still register; they run when a live browser can open the store."
              : browser === "idle"
                ? "No remote browser yet. Grant an origin and Chromium starts — one per session, released when you leave."
                : "Waiting for the first frame. Log in here if the store needs it. Keystrokes travel through our worker. Passkeys will not work."}
          </p>
        ) : null}
      </div>
      <p className="viewport__warn">
        Keystrokes and injected profile fields cross this worker in plaintext.
        They are not stored. Passkeys cannot work.
      </p>
    </section>
  );
}
