export type ScreencastFrame = {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
};

export type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (params: ScreencastFrame) => void) => void;
};

const SCREENCAST_PARAMS = {
  format: "jpeg",
  quality: 40,
  maxWidth: 1024,
  maxHeight: 768,
};

export function wrapCdp(session: object): CdpSession {
  return session as CdpSession;
}

/**
 * Attach the frame handler and start streaming. Call once per CDP session:
 * re-calling would stack duplicate `Page.screencastFrame` listeners. Use
 * `resumeScreencast` / `stopScreencast` to toggle afterwards.
 *
 * `Page.enable` first — a CDPSession created by hand does not enable the Page
 * domain, and without it `Page.screencastFrame` never fires.
 */
export async function startScreencast(
  cdp: CdpSession,
  onFrame: (frame: ScreencastFrame) => void,
): Promise<void> {
  cdp.on("Page.screencastFrame", (frame) => {
    // Ack first: an unacked frame stalls the stream (SPEC 2.2). The ack rejects
    // routinely (navigation, closed session); unhandled, that would take down
    // the Durable Object.
    void cdp
      .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {
        /* frame is already gone */
      });
    onFrame(frame);
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.startScreencast", SCREENCAST_PARAMS);
}

export async function resumeScreencast(cdp: CdpSession): Promise<void> {
  await cdp.send("Page.startScreencast", SCREENCAST_PARAMS);
}

export async function stopScreencast(cdp: CdpSession): Promise<void> {
  await cdp.send("Page.stopScreencast");
}

export async function dispatchMouse(
  cdp: CdpSession,
  params: {
    type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
    x: number;
    y: number;
    button?: "none" | "left" | "middle" | "right";
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
  },
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", params);
}

/**
 * Chrome ignores a key event that carries only `key`. Non-character keys need a
 * virtual key code (and Enter/Tab need `text`) or nothing happens in the page —
 * which is why a login form could be typed into but never submitted.
 */
const VIRTUAL_KEYS: Record<string, { code: number; text?: string }> = {
  Backspace: { code: 8 },
  Tab: { code: 9, text: "\t" },
  Enter: { code: 13, text: "\r" },
  Shift: { code: 16 },
  Control: { code: 17 },
  Alt: { code: 18 },
  CapsLock: { code: 20 },
  Escape: { code: 27 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  End: { code: 35 },
  Home: { code: 36 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Delete: { code: 46 },
  Meta: { code: 91 },
};

export function keyParams(
  type: "keyDown" | "keyUp",
  key: string,
): Record<string, unknown> {
  const known = VIRTUAL_KEYS[key];
  if (known) {
    return {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: known.code,
      nativeVirtualKeyCode: known.code,
      // Only a keyDown carries text; a keyUp with text inserts twice.
      ...(known.text && type === "keyDown"
        ? { text: known.text, unmodifiedText: known.text }
        : {}),
    };
  }
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    return {
      type,
      key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    };
  }
  return { type, key };
}

export async function dispatchKey(
  cdp: CdpSession,
  params: { type: "keyDown" | "keyUp" | "char"; key?: string; text?: string },
): Promise<void> {
  if (params.type === "char") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "char",
      text: params.text,
      unmodifiedText: params.text,
      key: params.text,
    });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", keyParams(params.type, params.key ?? ""));
}
