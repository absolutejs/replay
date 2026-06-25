/**
 * Tests for @absolutejs/replay (under happy-dom, with injected rrweb fakes).
 */
import { describe, expect, test } from "bun:test";
import {
  assembleReplay,
  createRecorder,
  createReplayPlayer,
  type RecordConfig,
  type ReplayChunk,
  type ReplayEvent,
  type RrwebRecord,
  type RrwebReplayerConstructor,
} from "../src/index";

const event = (timestamp: number): ReplayEvent => ({
  data: {},
  timestamp,
  type: 3,
});

/** A fake rrweb `record`: captures the emit fn + config, records stop calls. */
const fakeRecorder = () => {
  const state: {
    emit?: (e: ReplayEvent) => void;
    config?: RecordConfig;
    stopped: boolean;
  } = { stopped: false };
  const record: RrwebRecord = (config) => {
    state.config = config;
    state.emit = config.emit;
    return () => {
      state.stopped = true;
    };
  };
  return { record, state };
};

describe("createRecorder", () => {
  test("replayId is available synchronously (for the beacon seam)", () => {
    const { record } = fakeRecorder();
    const recorder = createRecorder({
      project: "web",
      record,
      upload: () => {},
    });
    expect(typeof recorder.replayId).toBe("string");
    expect(recorder.replayId.length).toBeGreaterThan(0);
  });

  test("chunks by size, increments seq, carries from/to + events", async () => {
    const { record, state } = fakeRecorder();
    const uploads: ReplayChunk[] = [];
    createRecorder({
      chunkMaxEvents: 3,
      project: "web",
      record,
      upload: (chunk) => {
        uploads.push(chunk);
      },
    });
    state.emit!(event(10));
    state.emit!(event(20));
    state.emit!(event(30)); // hits chunkMaxEvents → flush
    await Promise.resolve();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      from: 10,
      project: "web",
      seq: 0,
      to: 30,
    });
    expect(uploads[0]?.events).toHaveLength(3);

    state.emit!(event(40));
    state.emit!(event(50));
    state.emit!(event(60));
    await Promise.resolve();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]?.seq).toBe(1);
  });

  test("manual flush emits a partial chunk; empty flush is a no-op", async () => {
    const { record, state } = fakeRecorder();
    const uploads: ReplayChunk[] = [];
    const recorder = createRecorder({
      project: "web",
      record,
      upload: (chunk) => {
        uploads.push(chunk);
      },
    });
    await recorder.flush(); // nothing buffered
    expect(uploads).toHaveLength(0);
    state.emit!(event(5));
    await recorder.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.events).toHaveLength(1);
  });

  test("manifest reflects chunk count + duration", async () => {
    const { record, state } = fakeRecorder();
    const recorder = createRecorder({
      clock: () => 1000,
      project: "web",
      record,
      release: "v1",
      upload: () => {},
    });
    state.emit!(event(1500));
    await recorder.flush();
    const manifest = recorder.manifest();
    expect(manifest.chunkCount).toBe(1);
    expect(manifest.durationMs).toBe(500); // lastTimestamp(1500) - startedAt(1000)
    expect(manifest.release).toBe("v1");
    expect(manifest.replayId).toBe(recorder.replayId);
  });

  test("stop() flushes the final chunk + calls rrweb's stop handler", async () => {
    const { record, state } = fakeRecorder();
    const uploads: ReplayChunk[] = [];
    const recorder = createRecorder({
      project: "web",
      record,
      upload: (chunk) => {
        uploads.push(chunk);
      },
    });
    state.emit!(event(100));
    await recorder.stop();
    expect(state.stopped).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  test("masks inputs by default; respects overrides", () => {
    const safe = fakeRecorder();
    createRecorder({ project: "web", record: safe.record, upload: () => {} });
    expect(safe.state.config?.maskAllInputs).toBe(true);
    expect(safe.state.config?.blockClass).toBe("rr-block");

    const open = fakeRecorder();
    createRecorder({
      maskAllInputs: false,
      maskAllText: true,
      project: "web",
      record: open.record,
      upload: () => {},
    });
    expect(open.state.config?.maskAllInputs).toBe(false);
    expect(open.state.config?.maskTextSelector).toBe("*");
  });

  test("upload failures are routed to onError, never thrown", async () => {
    const { record, state } = fakeRecorder();
    const errors: unknown[] = [];
    const recorder = createRecorder({
      onError: (e) => errors.push(e),
      project: "web",
      record,
      upload: () => {
        throw new Error("S3 down");
      },
    });
    state.emit!(event(1));
    await recorder.flush();
    expect((errors[0] as Error).message).toBe("S3 down");
  });
});

describe("assembleReplay", () => {
  test("orders chunks by seq and flattens their events", () => {
    const mk = (seq: number, ts: number): ReplayChunk => ({
      events: [event(ts)],
      from: ts,
      project: "web",
      replayId: "r",
      seq,
      to: ts,
    });
    const events = assembleReplay([mk(2, 30), mk(0, 10), mk(1, 20)]);
    expect(events.map((e) => e.timestamp)).toEqual([10, 20, 30]);
  });
});

describe("createReplayPlayer", () => {
  test("constructs rrweb's Replayer with events + target and autoplays", async () => {
    const calls: { events: ReplayEvent[]; played: boolean; root?: Element } = {
      events: [],
      played: false,
    };
    const FakeReplayer = function (
      this: unknown,
      events: ReplayEvent[],
      config?: { root?: Element },
    ) {
      calls.events = events;
      calls.root = config?.root;
      return {
        destroy: () => {},
        pause: () => {},
        play: () => {
          calls.played = true;
        },
      };
    } as unknown as RrwebReplayerConstructor;

    const target = document.createElement("div");
    const events = [event(1), event(2)];
    const player = await createReplayPlayer({
      Replayer: FakeReplayer,
      events,
      target,
    });
    expect(calls.events).toEqual(events);
    expect(calls.root).toBe(target);
    expect(calls.played).toBe(true);
    expect(typeof player.pause).toBe("function");
  });

  test("autoplay:false does not play", async () => {
    let played = false;
    const FakeReplayer = function () {
      return {
        destroy: () => {},
        pause: () => {},
        play: () => {
          played = true;
        },
      };
    } as unknown as RrwebReplayerConstructor;
    await createReplayPlayer({
      Replayer: FakeReplayer,
      autoplay: false,
      events: [event(1)],
      target: document.createElement("div"),
    });
    expect(played).toBe(false);
  });
});
