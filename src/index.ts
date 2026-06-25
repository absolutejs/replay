/**
 * @absolutejs/replay — session replay for the AbsoluteJS observability stack.
 *
 * DOM recording genuinely needs a heavy, hard-to-replicate engine, so the
 * recorder wraps **rrweb** — but rrweb is an **optional, lazy-loaded peer**
 * (and fully injectable), so:
 *   - this package has ZERO hard dependencies; rrweb is only pulled when you
 *     actually start recording, and only into the replay code path (opt-in
 *     weight — replay is the one heavy feature, never on a page that isn't
 *     recording).
 *   - it's plain TS, NOT Effect — like @absolutejs/beacon, it's browser-first
 *     where bytes are the cost; the server-side rigor lives in the ingest /
 *     storage layers.
 *
 * Pipeline: rrweb emits events → buffered → chunked (by size/interval) →
 * uploaded via a pluggable `upload` transport (wire `@absolutejs/blob`). A
 * `replayId` is exposed synchronously so `@absolutejs/beacon`'s `getReplayId`
 * seam can stamp every error with the session — cross-linking an issue to its
 * exact DOM replay. Playback re-assembles chunks and feeds rrweb's `Replayer`.
 *
 * PRIVACY: inputs are masked by default (`maskAllInputs: true`). Recording user
 * sessions is a real liability surface — keep masking on, add `blockClass` /
 * `maskTextClass` to sensitive nodes, and use `maskAllText` for high-sensitivity
 * apps.
 */

// =============================================================================
// rrweb structural types — declared locally so rrweb stays an optional peer
// (no hard type dependency on the public surface).
// =============================================================================

/** An rrweb event. Opaque to us — we only buffer/transport/replay it. */
export type ReplayEvent = {
  type: number;
  timestamp: number;
  data: unknown;
};

export type RecordConfig = {
  emit: (event: ReplayEvent) => void;
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockClass?: string;
  maskTextClass?: string;
  recordCanvas?: boolean;
};

/** rrweb's `record` — returns a stop handler. */
export type RrwebRecord = (config: RecordConfig) => (() => void) | undefined;

export type RrwebReplayerInstance = {
  play: (timeOffset?: number) => void;
  pause: () => void;
  destroy?: () => void;
};

/** rrweb's `Replayer` constructor. */
export type RrwebReplayerConstructor = new (
  events: ReplayEvent[],
  config?: { root?: Element; speed?: number },
) => RrwebReplayerInstance;

// =============================================================================
// Replay format
// =============================================================================

/** A contiguous slice of a session's events — the unit uploaded to storage. */
export type ReplayChunk = {
  replayId: string;
  project: string;
  /** Monotonic chunk index within the session (0-based). */
  seq: number;
  /** First event timestamp in this chunk. */
  from: number;
  /** Last event timestamp in this chunk. */
  to: number;
  events: ReplayEvent[];
};

/** Session-level metadata — pair with the chunk keys to locate a replay. */
export type ReplayManifest = {
  replayId: string;
  project: string;
  startedAt: number;
  release?: string;
  environment?: string;
  chunkCount: number;
  durationMs: number;
};

// =============================================================================
// Helpers
// =============================================================================

const newId = (): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const loadRrwebRecord = async (): Promise<RrwebRecord> => {
  try {
    const mod = (await import("rrweb")) as unknown as { record: RrwebRecord };
    return mod.record;
  } catch (cause) {
    throw new Error(
      "[replay] rrweb is not installed. Run `bun add rrweb`, or pass `record` to createRecorder.",
      { cause },
    );
  }
};

const loadRrwebReplayer = async (): Promise<RrwebReplayerConstructor> => {
  try {
    const mod = (await import("rrweb")) as unknown as {
      Replayer: RrwebReplayerConstructor;
    };
    return mod.Replayer;
  } catch (cause) {
    throw new Error(
      "[replay] rrweb is not installed. Run `bun add rrweb`, or pass `Replayer` to createReplayPlayer.",
      { cause },
    );
  }
};

// =============================================================================
// Recorder
// =============================================================================

/** Persist one chunk — wire `@absolutejs/blob` (or any object store) here. */
export type ChunkUpload = (chunk: ReplayChunk) => void | Promise<void>;

export type RecorderOptions = {
  project: string;
  /** Called for each chunk as it's flushed. */
  upload: ChunkUpload;
  /** Override the generated session id. */
  replayId?: string;
  release?: string;
  environment?: string;
  /** Flush a chunk at least this often (ms). Default 5000. */
  chunkIntervalMs?: number;
  /** Flush once this many events buffer. Default 200. */
  chunkMaxEvents?: number;
  /** Mask all input values (privacy). Default **true**. */
  maskAllInputs?: boolean;
  /** Mask all text content (high-sensitivity). Default false. */
  maskAllText?: boolean;
  /** CSS class whose subtrees are not recorded. Default `'rr-block'`. */
  blockClass?: string;
  /** CSS class whose text is masked. Default `'rr-mask'`. */
  maskTextClass?: string;
  /** Record `<canvas>` (heavier). Default false. */
  recordCanvas?: boolean;
  /** Inject rrweb's `record` (default: lazy-imported). */
  record?: RrwebRecord;
  /** Override `Date.now()` for tests. */
  clock?: () => number;
  /** Hook for upload / recorder failures (best-effort; never throws to the app). */
  onError?: (error: unknown) => void;
};

export type Recorder = {
  /** The session id — feed to `@absolutejs/beacon`'s `getReplayId`. */
  replayId: string;
  /** Current session metadata snapshot. */
  manifest: () => ReplayManifest;
  /** Force-flush the buffered events as a chunk now. */
  flush: () => Promise<void>;
  /** Stop recording and flush the final chunk. */
  stop: () => Promise<void>;
};

export const createRecorder = (options: RecorderOptions): Recorder => {
  const replayId = options.replayId ?? newId();
  const clock = options.clock ?? Date.now;
  const startedAt = clock();

  const baseManifest = (
    chunkCount: number,
    durationMs: number,
  ): ReplayManifest => ({
    chunkCount,
    durationMs,
    project: options.project,
    replayId,
    startedAt,
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
  });

  // SSR / non-DOM: a valid recorder handle that records nothing.
  if (typeof window === "undefined") {
    return {
      flush: async () => {},
      manifest: () => baseManifest(0, 0),
      replayId,
      stop: async () => {},
    };
  }

  const chunkMaxEvents = options.chunkMaxEvents ?? 200;
  const chunkIntervalMs = options.chunkIntervalMs ?? 5000;
  const onError = options.onError ?? (() => {});

  let buffer: ReplayEvent[] = [];
  let seq = 0;
  let chunkCount = 0;
  let lastTimestamp = startedAt;
  let stopFn: (() => void) | undefined;
  let stopped = false;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    const chunk: ReplayChunk = {
      events,
      from: events[0]!.timestamp,
      project: options.project,
      replayId,
      seq: seq++,
      to: events[events.length - 1]!.timestamp,
    };
    chunkCount += 1;
    try {
      await options.upload(chunk);
    } catch (error) {
      onError(error);
    }
  };

  const emit = (event: ReplayEvent): void => {
    buffer.push(event);
    lastTimestamp = event.timestamp;
    if (buffer.length >= chunkMaxEvents) void flush();
  };

  const config: RecordConfig = {
    blockClass: options.blockClass ?? "rr-block",
    emit,
    maskAllInputs: options.maskAllInputs ?? true,
    maskTextClass: options.maskTextClass ?? "rr-mask",
    ...(options.maskAllText === true ? { maskTextSelector: "*" } : {}),
    ...(options.recordCanvas === true ? { recordCanvas: true } : {}),
  };

  const start = (record: RrwebRecord): void => {
    if (stopped) return;
    try {
      stopFn = record(config) ?? undefined;
    } catch (error) {
      onError(error);
    }
  };

  if (options.record !== undefined) start(options.record);
  else loadRrwebRecord().then(start).catch(onError);

  const timer = setInterval(() => {
    void flush();
  }, chunkIntervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    flush,
    manifest: () =>
      baseManifest(chunkCount, Math.max(0, lastTimestamp - startedAt)),
    replayId,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (stopFn !== undefined) {
        try {
          stopFn();
        } catch (error) {
          onError(error);
        }
      }
      await flush();
    },
  };
};

// =============================================================================
// Playback
// =============================================================================

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
};

export type ReplayPlayer = {
  play: (timeOffset?: number) => void;
  pause: () => void;
  destroy: () => void;
};

export const createReplayPlayer = async (
  options: ReplayPlayerOptions,
): Promise<ReplayPlayer> => {
  const Replayer = options.Replayer ?? (await loadRrwebReplayer());
  const replayer = new Replayer(options.events, {
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
