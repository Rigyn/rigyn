import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import type { TuiInput, TuiOutput, TuiSignalSource } from "../../src/tui/types.js";

export class FakeInput extends PassThrough implements TuiInput {
  isTTY = true;
  isRaw = false;
  readonly rawChanges: boolean[] = [];

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawChanges.push(enabled);
    return this;
  }
}

export class FakeOutput extends PassThrough implements TuiOutput {
  isTTY = true;
  columns = 80;
  rows = 24;
  readonly chunks: Buffer[] = [];

  constructor() {
    super();
    this.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk)));
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

export class FakeSignals extends EventEmitter implements TuiSignalSource {
  override on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): this {
    return super.on(event, listener);
  }

  override off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): this {
    return super.off(event, listener);
  }

  signal(value: NodeJS.Signals): void {
    this.emit(value, value);
  }
}

export function envelope(event: RuntimeEvent, sequence = 1): EventEnvelope {
  return {
    eventId: `evt_${sequence}`,
    threadId: "thr_test",
    runId: "run_test",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  } as EventEnvelope;
}

export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
