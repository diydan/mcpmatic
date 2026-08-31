export type ScreencastFrame = {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
};

export type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (params: ScreencastFrame) => void) => void;
};

export function wrapCdp(session: object): CdpSession {
  return session as CdpSession;
}

export async function startScreencast(
  cdp: CdpSession,
  onFrame: (frame: ScreencastFrame) => void,
): Promise<void> {
  let latest: ScreencastFrame | null = null;
  cdp.on("Page.screencastFrame", (frame) => {
    latest = frame;
    onFrame(frame);
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 40,
    maxWidth: 1024,
    maxHeight: 768,
  });
  void latest;
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

export async function dispatchKey(
  cdp: CdpSession,
  params: { type: "keyDown" | "keyUp" | "char"; key?: string; text?: string },
): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", params);
}
