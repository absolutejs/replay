# @absolutejs/replay

> Session replay for the AbsoluteJS observability stack. ~1 KB of glue;
> [rrweb](https://github.com/rrweb-io/rrweb) is an optional, lazy-loaded peer.

Records DOM sessions, chunks them, and uploads each chunk via a pluggable
transport (wire [`@absolutejs/blob`](https://www.npmjs.com/package/@absolutejs/blob)).
Exposes a `replayId` so [`@absolutejs/beacon`](https://www.npmjs.com/package/@absolutejs/beacon)
can stamp every error with the session — cross-linking an issue to the **exact**
DOM replay around it. Re-assembles chunks for a framework-agnostic player.

## Design

- **Zero hard dependencies.** DOM recording genuinely needs a heavy engine, so
  the recorder wraps rrweb — but rrweb is an **optional peer**, lazy-imported
  only when you start recording (and fully injectable). Replay is the one heavy
  feature; its weight never lands on a page that isn't recording.
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
import { createRecorder } from "@absolutejs/replay";
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

## Play back

```ts
import { assembleReplay, createReplayPlayer } from "@absolutejs/replay";

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

assembleReplay(chunks) => ReplayEvent[]              // sort by seq, flatten
createReplayPlayer({ target, events, Replayer?, autoplay?, speed? }) => Promise<ReplayPlayer>
```

SSR-safe: imported without a DOM, `createRecorder` returns a no-op handle (with
a valid `replayId`/`manifest`).

## License

BSL-1.1 with a named carveout against hosted session-replay / observability
SaaS (LogRocket, FullStory, Sentry Replay, Datadog). See `LICENSE`.
