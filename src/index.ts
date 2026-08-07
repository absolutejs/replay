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
  /** Take a fresh FullSnapshot at least this often (ms). Keeps a recent
   *  restore point in any bounded buffer so a tail that no longer contains
   *  the session's first snapshot is still self-contained. */
  checkoutEveryNms?: number;
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
  /** Resume a prior session: start chunk `seq` here instead of 0, so a new
   *  page load's chunks don't collide with the previous load's (storage is
   *  idempotent on (replayId, seq) and would silently drop the duplicates).
   *  Default 0. */
  seqStart?: number;
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
  /** Take a fresh FullSnapshot at least this often (ms). Essential for the
   *  bounded-ring controller: without periodic checkouts the only FullSnapshot
   *  is at session start, so once the ring evicts it the persisted tail begins
   *  mid-stream and the player throws "Node with id 'N' not found". Default
   *  60000 (every 60s). Set 0 to disable. */
  checkoutEveryNms?: number;
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
  const checkoutEveryNms = options.checkoutEveryNms ?? 60_000;
  const onError = options.onError ?? (() => {});

  let buffer: ReplayEvent[] = [];
  let seq = options.seqStart ?? 0;
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
    ...(checkoutEveryNms > 0 ? { checkoutEveryNms } : {}),
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
// Controller — production "batteries" over createRecorder.
//
// createRecorder gives you raw chunks; deciding WHEN and HOW to ship them is the
// part every app otherwise re-derives (and gets wrong). The controller keeps a
// bounded ring of recent chunks (nothing stored server-side by default) and
// uploads the tail only when it matters — a bug report (`flush`), an auto-error
// (`flushThrottled`), or the page unloading (`flushOnUnload`). Uploads are
// gzipped and size-batched so no POST can exceed a gateway body cap no matter
// how large the session (rrweb JSON compresses ~10:1). The unload path uses
// `keepalive` so the final moments survive the tab closing, and only fires for
// sessions that already mattered — so nothing orphaned is ever stored.
//
// Wire contract: POST `{ chunks: WireChunk[]; manifest: ReplayManifest }` to
// your `endpoint`; the gzip path sets `content-encoding: gzip` (decompress
// before validating). Pairs with @absolutejs/errors' ingest + the typed
// ReplayChunk/ReplayManifest shapes above.
// =============================================================================

/** The per-chunk wire shape (the manifest carries replayId/project). */
export type WireChunk = Pick<ReplayChunk, "events" | "from" | "seq" | "to">;

type EncodedBody = { body: BodyInit; gzip: boolean };
export type ReplayFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ReplayControllerOptions = {
  /** Ingest route accepting `{ chunks: WireChunk[]; manifest: ReplayManifest }`. */
  endpoint: string;
  project: string;
  release?: string;
  environment?: string;
  /** Chunks of context to retain (~10 min @ 5s/chunk). Default 120. */
  maxRingChunks?: number;
  /** Min ms between throttled auto-error flushes. Default 30000. */
  flushThrottleMs?: number;
  /** Max uncompressed bytes per upload batch. Default 700000. */
  maxBatchBytes?: number;
  /** Max bytes for the keepalive unload tail (stay under the ~64KB cap). Default 55000. */
  maxTailBytes?: number;
  /** Maximum replay batches uploaded at once. Default 2. */
  maxUploadConcurrency?: number;
  /** Deadline for each replay batch attempt. Default 10000ms. */
  uploadTimeoutMs?: number;
  /** sessionStorage key under which to persist `{ replayId, nextSeq }` so a
   *  full page reload RESUMES the same replay session (same id, continuing seq)
   *  instead of orphaning the prior recording and minting a fresh one. Matters
   *  whenever the app can reload mid-session (e.g. a stale-chunk auto-reload).
   *  Off by default; SSR-safe (no-op without `window`). */
  persistSessionKey?: string;
  /** Masking / record-injection / cadence forwarded to the recorder. */
  recorder?: Omit<
    RecorderOptions,
    "project" | "upload" | "replayId" | "release" | "environment"
  >;
  /** Override fetch (tests / proxies). Default global fetch. */
  fetch?: ReplayFetch;
};

export type ReplayController = {
  /** The session id — feed to `@absolutejs/beacon`'s `getReplayId`. */
  getReplayId: () => string;
  /** Persist the full ring now (a bug report). Returns the replayId. */
  flush: () => Promise<string | null>;
  /** Persist the ring, but at most once per `flushThrottleMs` (auto-errors). */
  flushThrottled: () => void;
  /** Keepalive tail-flush on `pagehide` — no-op unless the session mattered. */
  flushOnUnload: () => void;
  /** Stop recording and flush the final chunk. */
  stop: () => Promise<void>;
};

const RING_CHUNKS_DEFAULT = 120;
const FLUSH_THROTTLE_DEFAULT_MS = 30_000;
const BATCH_BYTES_DEFAULT = 700_000;
const TAIL_BYTES_DEFAULT = 55_000;
const UPLOAD_CONCURRENCY_DEFAULT = 2;
const UPLOAD_TIMEOUT_DEFAULT_MS = 10_000;
// Backoff schedule for a failed upload batch (ms before each attempt). Covers
// transient 5xx / network blips without hammering; a hard outage still gives up
// after the last attempt (the next signal flush retries the whole ring).
const UPLOAD_BACKOFFS_MS = [0, 500, 2_000];

type PersistedSession = { replayId: string; nextSeq: number };

const readPersistedSession = (key: string): PersistedSession | null => {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PersistedSession).replayId === "string" &&
      typeof (parsed as PersistedSession).nextSeq === "number"
    ) {
      return parsed as PersistedSession;
    }
  } catch {
    // Corrupt/blocked storage → start a fresh session rather than throw.
  }

  return null;
};

const writePersistedSession = (key: string, value: PersistedSession): void => {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — continuity is best-effort, never fatal.
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// gzip a JSON string when supported (Response(json).body avoids needing a Blob);
// fall back to plain text where CompressionStream / a body stream is absent.
const encodeBody = async (json: string): Promise<EncodedBody> => {
  const plain: EncodedBody = { body: json, gzip: false };
  if (typeof CompressionStream === "undefined") return plain;
  const stream = new Response(json).body;
  if (stream === null) return plain;
  try {
    const compressed = await new Response(
      stream.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return { body: compressed, gzip: true };
  } catch {
    return plain;
  }
};

const toWire = (chunk: ReplayChunk): WireChunk => ({
  events: chunk.events,
  from: chunk.from,
  seq: chunk.seq,
  to: chunk.to,
});

// Group chunks into size-bounded batches so no single POST exceeds a gateway
// cap (ingest must be idempotent on (replayId, seq), which storeReplay is).
const batchByBytes = (chunks: WireChunk[], maxBytes: number): WireChunk[][] => {
  const batches: WireChunk[][] = [];
  let current: WireChunk[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
    bytes = 0;
  };
  for (const chunk of chunks) {
    const size = JSON.stringify(chunk).length;
    if (current.length > 0 && bytes + size > maxBytes) flush();
    current.push(chunk);
    bytes += size;
  }
  flush();
  return batches;
};

const mapConcurrent = async <Input, Output>(
  inputs: Input[],
  concurrency: number,
  run: (input: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) results[index] = await run(input);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), inputs.length) },
      worker,
    ),
  );

  return results;
};

export const createReplayController = (
  options: ReplayControllerOptions,
): ReplayController => {
  const maxRing = options.maxRingChunks ?? RING_CHUNKS_DEFAULT;
  const throttleMs = options.flushThrottleMs ?? FLUSH_THROTTLE_DEFAULT_MS;
  const maxBatchBytes = options.maxBatchBytes ?? BATCH_BYTES_DEFAULT;
  const maxTailBytes = options.maxTailBytes ?? TAIL_BYTES_DEFAULT;
  const maxUploadConcurrency =
    options.maxUploadConcurrency ?? UPLOAD_CONCURRENCY_DEFAULT;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  const ring: ReplayChunk[] = [];
  let lastFlush = 0;
  let activeFlush: Promise<void> | null = null;
  // True once a report/error/unload made this session worth keeping.
  let sessionMatters = false;

  // Resume the prior session across a full reload when asked: reuse the same
  // replayId and continue the chunk seq so the new page's chunks append to the
  // existing recording instead of orphaning it under a fresh id.
  const persistKey = options.persistSessionKey;
  const resumed =
    persistKey !== undefined && typeof window !== "undefined"
      ? readPersistedSession(persistKey)
      : null;

  const recorder = createRecorder({
    project: options.project,
    upload: (chunk) => {
      ring.push(chunk);
      while (ring.length > maxRing) ring.shift();
      if (persistKey !== undefined && typeof window !== "undefined") {
        writePersistedSession(persistKey, {
          nextSeq: chunk.seq + 1,
          replayId: recorder.replayId,
        });
      }
    },
    ...(resumed !== null ? { replayId: resumed.replayId } : {}),
    ...(resumed !== null ? { seqStart: resumed.nextSeq } : {}),
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
    ...(options.recorder ?? {}),
  });

  const postBatch = async (
    batch: WireChunk[],
    manifest: ReplayManifest,
  ): Promise<void> => {
    const { body, gzip } = await encodeBody(
      JSON.stringify({ chunks: batch, manifest }),
    );
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (gzip) headers["content-encoding"] = "gzip";
    // Retry transient failures (network blip / 5xx) with backoff before giving
    // up, so a momentary hiccup doesn't silently drop a session segment.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < UPLOAD_BACKOFFS_MS.length; attempt += 1) {
      const backoff = UPLOAD_BACKOFFS_MS[attempt] ?? 0;
      if (backoff > 0) await delay(backoff);
      try {
        const response = await doFetch(options.endpoint, {
          body,
          credentials: "include",
          headers,
          method: "POST",
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
        if (response.ok) return;
        lastError = new Error(`replay ingest responded ${response.status}`);
        if (
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("replay upload failed");
  };

  const runFlush = async (): Promise<void> => {
    await recorder.flush();
    if (ring.length === 0) return;
    const manifest = recorder.manifest();
    const snapshot = [...ring];
    const batches = batchByBytes(snapshot.map(toWire), maxBatchBytes);
    const results = await mapConcurrent(
      batches,
      maxUploadConcurrency,
      async (batch) => {
        try {
          await postBatch(batch, manifest);

          return batch.map((chunk) => chunk.seq);
        } catch {
          return [];
        }
      },
    );
    const acknowledged = new Set(results.flat());
    if (acknowledged.size > 0) {
      // Chunks can arrive while the snapshot uploads. Remove only snapshot
      // sequences the server acknowledged; failed and newly-recorded chunks
      // remain pending for the next flush.
      for (let index = ring.length - 1; index >= 0; index -= 1) {
        const chunk = ring[index];
        if (chunk !== undefined && acknowledged.has(chunk.seq)) {
          ring.splice(index, 1);
        }
      }
      lastFlush = Date.now();
    }
  };

  const flush = async (): Promise<string | null> => {
    if (typeof window === "undefined") return null;
    sessionMatters = true;
    // One transport flush per controller. Callers that race (report + beacon +
    // visibility event) share the same promise instead of replaying the ring in
    // parallel and starving application requests on the browser connection.
    activeFlush ??= runFlush().finally(() => {
      activeFlush = null;
    });
    await activeFlush;

    return recorder.replayId;
  };

  const flushThrottled = (): void => {
    if (Date.now() - lastFlush < throttleMs) return;
    lastFlush = Date.now();
    void flush();
  };

  const flushOnUnload = (): void => {
    if (!sessionMatters || typeof window === "undefined") return;
    const tail: ReplayChunk[] = [];
    let bytes = 0;
    for (let index = ring.length - 1; index >= 0; index -= 1) {
      const chunk = ring[index];
      if (chunk === undefined) continue;
      const size = JSON.stringify(chunk).length;
      if (tail.length > 0 && bytes + size > maxTailBytes) break;
      tail.unshift(chunk);
      bytes += size;
    }
    if (tail.length === 0) return;
    void doFetch(options.endpoint, {
      body: JSON.stringify({
        chunks: tail.map(toWire),
        manifest: recorder.manifest(),
      }),
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => undefined);
  };

  return {
    flush,
    flushOnUnload,
    flushThrottled,
    getReplayId: () => recorder.replayId,
    stop: () => recorder.stop(),
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

// rrweb event type tags (rrweb's EventType enum): Meta = 4, FullSnapshot = 2.
const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_META = 4;

// rrweb's replayer baseline styles (rrweb/dist/style.css, MIT © the rrweb
// contributors), embedded so playback is self-contained: `.replayer-wrapper`
// must be a positioning context and the mouse/tail overlays absolute, or the
// tail canvas (sized to the recorded viewport) participates in layout and
// shoves the replay iframe out of view.
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

/** Add the baseline styles to the target's document once (id-guarded, so many
 *  players on one page share a single tag). */
const injectReplayerStyles = (target: Element): void => {
  const doc = target.ownerDocument;
  if (doc === null || doc.getElementById(REPLAYER_STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = REPLAYER_STYLE_ID;
  style.textContent = REPLAYER_BASE_CSS;
  doc.head.appendChild(style);
};

/** rrweb's Replayer must begin at a FullSnapshot (ideally preceded by its
 *  Meta) — otherwise it applies incremental mutations to nodes that were never
 *  built and floods the console with "Node with id 'N' not found". A persisted
 *  ring tail can legitimately start mid-stream (the session's first snapshot
 *  was evicted, or a byte-bounded tail begins partway through). Trim leading
 *  events to the first FullSnapshot, keeping the Meta immediately before it.
 *  Returns the input unchanged when it already starts correctly, or when no
 *  FullSnapshot is present (nothing we can do — caller surfaces "no replay"). */
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
