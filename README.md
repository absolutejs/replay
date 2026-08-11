# @absolutejs/replay

> Session replay for the AbsoluteJS observability stack. ~1 KB of glue around
> a lazy-loaded recorder, plus an optional rrweb-powered player.

Records DOM sessions, chunks them, and uploads each chunk via a pluggable
transport (wire [`@absolutejs/blob`](https://www.npmjs.com/package/@absolutejs/blob)).
Exposes a `replayId` so [`@absolutejs/beacon`](https://www.npmjs.com/package/@absolutejs/beacon)
can stamp every error with the session — cross-linking an issue to the **exact**
DOM replay around it. Re-assembles chunks for a framework-agnostic player.

## Design

- **Capability-split engine.** DOM recording genuinely needs a heavy engine, so
  the recorder lazy-loads the separately compiled `@rrweb/record` package only
  when recording starts (and remains fully injectable). Playback uses the
  optional `rrweb` peer through a separate `/player` entry. Apps that contain
  both capabilities do not merge the recorder into rrweb's full player bundle.
- **Plain TS, not Effect** — like `beacon`, it's browser-first where bytes are
  the cost. Replay's own code is ~1 KB gz.
- **Private by default** — inputs are masked (`maskAllInputs: true`). Recording
  user sessions is a real liability surface; keep masking on.

## Install

```sh
bun add @absolutejs/replay rrweb
```

## Record

```ts
import { createRecorder } from "@absolutejs/replay/recorder";
import { initBeacon } from "@absolutejs/beacon";

const recorder = createRecorder({
  project: "web",
  release: import.meta.env.VITE_RELEASE,
  upload: (chunk) =>
    uploadToBlob(
      `replays/${chunk.replayId}/${chunk.seq}.json`,
      JSON.stringify(chunk),
    ),
  // privacy defaults: maskAllInputs: true, blockClass: 'rr-block', maskTextClass: 'rr-mask'
});

// Cross-link errors → this session:
initBeacon({ project: "web", getReplayId: () => recorder.replayId });

// On error, flush the tail so the replay around it is stored:
window.addEventListener("error", () => void recorder.flush());
```

Add `class="rr-block"` to a node to skip recording it, or `class="rr-mask"` to
mask its text. Use `maskAllText: true` for high-sensitivity apps.

For application-level error/report capture, use `createReplayController`. It
keeps an in-memory ring until the session matters, coalesces racing flushes,
uploads at most two batches concurrently, applies a 10-second deadline to each
attempt, removes acknowledged chunks, and retains failed chunks for retry.

```ts
const replay = createReplayController({
  endpoint: "/ingest/replay",
  project: "web",
  maxUploadConcurrency: 2,
  uploadTimeoutMs: 10_000,
});
```

## Play back

```ts
import { assembleReplay, createReplayPlayer } from "@absolutejs/replay/player";

const chunks = await loadChunksFromBlob(replayId); // your storage read
const player = await createReplayPlayer({
  target: document.getElementById("replay")!,
  events: assembleReplay(chunks), // ordered + flattened
});
player.pause();
player.play(0);
```

## API

```ts
createRecorder(options) => Recorder
//   Recorder: { replayId, manifest(), flush(), stop() }
//   options:  project, upload, release?, environment?, replayId?,
//             chunkIntervalMs? (5000), chunkMaxEvents? (200),
//             maskAllInputs? (true), maskAllText? (false), blockClass?, maskTextClass?,
//             recordCanvas?, record? (inject rrweb), onError?

createReplayController(options) => ReplayController
//   ReplayController: { getReplayId(), flush(), flushThrottled(),
//                       flushOnUnload(), stop() }
//   options: endpoint, project, release?, environment?, maxRingChunks?,
//            flushThrottleMs?, maxBatchBytes?, maxTailBytes?,
//            maxUploadConcurrency? (2), uploadTimeoutMs? (10000),
//            persistSessionKey?, recorder?, fetch?

assembleReplay(chunks) => ReplayEvent[]              // sort by seq, flatten
createReplayPlayer({ target, events, Replayer?, autoplay?, speed? }) => Promise<ReplayPlayer>
```

SSR-safe: imported without a DOM, `createRecorder` returns a no-op handle (with
a valid `replayId`/`manifest`).

## License

BSL-1.1 with a named carveout against hosted session-replay / observability
SaaS (LogRocket, FullStory, Sentry Replay, Datadog). See `LICENSE`.
