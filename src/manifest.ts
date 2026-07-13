import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { RecorderOptions } from "./index";

const MAX_CHUNK_EVENTS = 10000;
const MIN_CHUNK_INTERVAL_MS = 250;

/* Serializable subset of RecorderOptions. `upload`, `record`, `clock`, and
 * `onError` are function-valued → wiring concerns; `replayId`/`seqStart` are
 * per-session values, not configuration. No tools: the recorder lives in the
 * visitor's browser — there is no server runtime to hand a tool. */
export const manifest = defineManifest<RecorderOptions>()({
  contract: 1,
  identity: {
    accent: "#ef4444",
    category: "observability",
    description:
      "Session replay with ~1 KB of glue: records DOM sessions via a lazy-loaded rrweb, chunks them, and uploads each chunk through a pluggable transport (wire it to @absolutejs/blob or a small POST route). Exposes a replayId so @absolutejs/beacon can stamp every error with the exact session around it. Inputs are masked by default.",
    docsUrl: "https://github.com/absolutejs/replay",
    name: "@absolutejs/replay",
    tagline: "Record visitor sessions so you can replay what went wrong.",
  },
  requires: {
    peers: [
      {
        name: "rrweb",
        range: "^2.0.0",
        reason: "DOM recording engine — lazy-loaded only when recording starts",
      },
    ],
  },
  settings: Type.Object({
    chunkIntervalMs: Type.Optional(
      Type.Integer({
        description:
          "How often a chunk of the recording is uploaded, in milliseconds. Default is 5000.",
        minimum: MIN_CHUNK_INTERVAL_MS,
        title: "Upload interval",
        "x-group": "advanced",
      }),
    ),
    chunkMaxEvents: Type.Optional(
      Type.Integer({
        description:
          "Upload a chunk once this many events have buffered. Default is 200.",
        maximum: MAX_CHUNK_EVENTS,
        minimum: 1,
        title: "Events per chunk",
        "x-group": "advanced",
      }),
    ),
    maskAllInputs: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Hide everything visitors type into form fields. Keep this on — recording sessions is a real privacy surface.",
        title: "Mask typed input",
      }),
    ),
    maskAllText: Type.Optional(
      Type.Boolean({
        description:
          "Also hide all text on the page, for high-sensitivity sites. Off by default.",
        title: "Mask all text",
      }),
    ),
    project: Type.String({
      default: "web",
      description: "The project name recordings are filed under.",
      title: "Project",
    }),
    recordCanvas: Type.Optional(
      Type.Boolean({
        description:
          "Also record canvas elements (charts, drawings). Heavier recordings.",
        title: "Record canvas",
        "x-group": "advanced",
      }),
    ),
  }),
  wiring: [
    {
      description:
        "Start recording in the browser and upload chunks to your storage. Add class=\"rr-block\" to any element you never want recorded.",
      id: "default",
      client: {
        client: {
          code: [
            "const replayRecorder = createRecorder({",
            "\t// TODO: point the upload at your storage — a small POST route,",
            "\t// or presigned PUT URLs from @absolutejs/blob.",
            "\tupload: async (chunk) => {",
            "\t\t// (string concatenation — wiring templates reserve ${...})",
            "\t\tawait fetch('/api/replays/' + chunk.replayId + '/' + chunk.seq, {",
            "\t\t\tbody: JSON.stringify(chunk),",
            "\t\t\theaders: { 'content-type': 'application/json' },",
            "\t\t\tmethod: 'POST'",
            "\t\t});",
            "\t},",
            "\t...${settings}",
            "});",
            "",
            "// Cross-link errors to this session (@absolutejs/beacon):",
            "//   initBeacon({ getReplayId: () => replayRecorder.replayId, project: 'web' });",
            "// Flush the tail on errors so the replay around them is stored:",
            "window.addEventListener('error', () => void replayRecorder.flush());",
          ].join("\n"),
          imports: [{ from: "@absolutejs/replay", names: ["createRecorder"] }],
          placement: "client-entry",
        },
      },
      title: "Record sessions and upload chunks",
    },
  ],
});
