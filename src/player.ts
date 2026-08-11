import type {
  ReplayChunk,
  ReplayEvent,
  RrwebReplayerConstructor,
} from "./recorder";

const loadRrwebReplayer = async (): Promise<RrwebReplayerConstructor> => {
  try {
    const mod = await import("./rrwebReplayer");
    return mod.Replayer as unknown as RrwebReplayerConstructor;
  } catch (cause) {
    throw new Error(
      "[replay] rrweb is not installed. Run `bun add rrweb`, or pass `Replayer` to createReplayPlayer.",
      { cause },
    );
  }
};

/** Re-assemble a session's chunks into a single ordered event stream. */
export const assembleReplay = (chunks: ReplayChunk[]): ReplayEvent[] =>
  [...chunks].sort((a, b) => a.seq - b.seq).flatMap((chunk) => chunk.events);

export type ReplayPlayerOptions = {
  /** Element to mount the replay into. */
  target: Element;
  /** The assembled event stream (see `assembleReplay`). */
  events: ReplayEvent[];
  /** Inject rrweb's `Replayer` (default: lazy-imported). */
  Replayer?: RrwebReplayerConstructor;
  /** Start playing immediately. Default true. */
  autoplay?: boolean;
  speed?: number;
  /** Inject the replayer's baseline CSS into the target's document. rrweb's
   *  bare `Replayer` positions its mouse cursor and mouse-tail canvas with
   *  classes styled only by `rrweb/dist/style.css`; without those rules the
   *  full-viewport tail canvas lays out in-flow and pushes the replay iframe
   *  below the mount point (the replay looks blank). Default **true** — set
   *  false only if you load rrweb's stylesheet yourself. */
  injectStyles?: boolean;
};

export type ReplayPlayer = {
  play: (timeOffset?: number) => void;
  pause: () => void;
  destroy: () => void;
};

const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_META = 4;
const REPLAYER_STYLE_ID = "absolutejs-replay-baseline";
const REPLAYER_BASE_CSS = `
.replayer-wrapper {
  position: relative;
}
.replayer-mouse {
  position: absolute;
  width: 20px;
  height: 20px;
  transition: left 0.05s linear, top 0.05s linear;
  background-size: contain;
  background-position: center center;
  background-repeat: no-repeat;
  background-image: url('data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9JzMwMHB4JyB3aWR0aD0nMzAwcHgnICBmaWxsPSIjMDAwMDAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGRhdGEtbmFtZT0iTGF5ZXIgMSIgdmlld0JveD0iMCAwIDUwIDUwIiB4PSIwcHgiIHk9IjBweCI+PHRpdGxlPkRlc2lnbl90bnA8L3RpdGxlPjxwYXRoIGQ9Ik00OC43MSw0Mi45MUwzNC4wOCwyOC4yOSw0NC4zMywxOEExLDEsMCwwLDAsNDQsMTYuMzlMMi4zNSwxLjA2QTEsMSwwLDAsMCwxLjA2LDIuMzVMMTYuMzksNDRhMSwxLDAsMCwwLDEuNjUuMzZMMjguMjksMzQuMDgsNDIuOTEsNDguNzFhMSwxLDAsMCwwLDEuNDEsMGw0LjM4LTQuMzhBMSwxLDAsMCwwLDQ4LjcxLDQyLjkxWm0tNS4wOSwzLjY3TDI5LDMyYTEsMSwwLDAsMC0xLjQxLDBsLTkuODUsOS44NUwzLjY5LDMuNjlsMzguMTIsMTRMMzIsMjcuNThBMSwxLDAsMCwwLDMyLDI5TDQ2LjU5LDQzLjYyWiI+PC9wYXRoPjwvc3ZnPg==');
  border-color: transparent;
}
.replayer-mouse::after {
  content: '';
  display: inline-block;
  width: 20px;
  height: 20px;
  background: rgb(73, 80, 246);
  border-radius: 100%;
  transform: translate(-50%, -50%);
  opacity: 0.3;
}
.replayer-mouse.active::after {
  animation: replayer-click 0.2s ease-in-out 1;
}
.replayer-mouse.touch-device {
  background-image: none;
  width: 70px;
  height: 70px;
  border-width: 4px;
  border-style: solid;
  border-radius: 100%;
  margin-left: -37px;
  margin-top: -37px;
  border-color: rgba(73, 80, 246, 0);
  transition: left 0s linear, top 0s linear, border-color 0.2s ease-in-out;
}
.replayer-mouse.touch-device.touch-active {
  border-color: rgba(73, 80, 246, 1);
  transition: left 0.25s linear, top 0.25s linear, border-color 0.2s ease-in-out;
}
.replayer-mouse.touch-device::after {
  opacity: 0;
}
.replayer-mouse.touch-device.active::after {
  animation: replayer-touch-click 0.2s ease-in-out 1;
}
.replayer-mouse-tail {
  position: absolute;
  pointer-events: none;
}
@keyframes replayer-click {
  0% {
    opacity: 0.3;
    width: 20px;
    height: 20px;
  }
  50% {
    opacity: 0.5;
    width: 10px;
    height: 10px;
  }
}
@keyframes replayer-touch-click {
  0% {
    opacity: 0;
    width: 20px;
    height: 20px;
  }
  50% {
    opacity: 0.5;
    width: 10px;
    height: 10px;
  }
}
`;

const injectReplayerStyles = (target: Element): void => {
  const doc = target.ownerDocument;
  if (doc === null || doc.getElementById(REPLAYER_STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = REPLAYER_STYLE_ID;
  style.textContent = REPLAYER_BASE_CSS;
  doc.head.appendChild(style);
};

export const trimToFirstSnapshot = (events: ReplayEvent[]): ReplayEvent[] => {
  const firstFull = events.findIndex(
    (event) => event.type === RRWEB_FULL_SNAPSHOT,
  );
  if (firstFull <= 0) return events;
  const start =
    events[firstFull - 1]?.type === RRWEB_META ? firstFull - 1 : firstFull;

  return events.slice(start);
};

export const createReplayPlayer = async (
  options: ReplayPlayerOptions,
): Promise<ReplayPlayer> => {
  const Replayer = options.Replayer ?? (await loadRrwebReplayer());
  if (options.injectStyles !== false) injectReplayerStyles(options.target);
  const replayer = new Replayer(trimToFirstSnapshot(options.events), {
    root: options.target,
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
  });
  if (options.autoplay !== false) replayer.play();
  return {
    destroy: () => replayer.destroy?.(),
    pause: () => replayer.pause(),
    play: (timeOffset) => replayer.play(timeOffset),
  };
};
