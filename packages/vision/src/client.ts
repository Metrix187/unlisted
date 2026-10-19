import type { Analysis, Backdrop, ProgressEvent, ScrubMode, ScrubResult } from "./types";
import type { WorkerRequest, WorkerResponse } from "./worker";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressEvent) => void;
};

type Omit2<T> = T extends unknown ? Omit<T, "id"> : never;

// main-thread side. promise-y wrapper around the worker so components don't have to speak postMessage
export class VisionClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready?: Promise<unknown>;

  constructor(
    private assetBase: string,
    worker?: Worker,
  ) {
    this.worker = worker ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress")
        p.onProgress?.({ stage: msg.stage as ProgressEvent["stage"], value: msg.value, label: msg.label });
      else {
        this.pending.delete(msg.id);
        if (msg.type === "done") p.resolve(msg.result);
        else p.reject(new Error(msg.message));
      }
    };
  }

  private call<T>(req: Omit2<WorkerRequest>, onProgress?: (p: ProgressEvent) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  init(onProgress?: (p: ProgressEvent) => void) {
    this.ready ??= this.call({ type: "init", assetBase: this.assetBase }, onProgress).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async analyze(blob: Blob, onProgress?: (p: ProgressEvent) => void, keep = true): Promise<Analysis> {
    await this.init(onProgress);
    return this.call<Analysis>({ type: "analyze", blob, keep }, onProgress);
  }

  scrub(
    opts: { mode: ScrubMode; backdrop: Backdrop; noise: boolean; slow?: boolean },
    onProgress?: (p: ProgressEvent) => void,
  ): Promise<ScrubResult> {
    return this.call<ScrubResult>({ type: "scrub", ...opts }, onProgress);
  }

  noiseStatus() {
    return this.call<{ webgpu: boolean; loaded: boolean; backend: string }>({ type: "noiseStatus" });
  }

  terminate() {
    this.worker.terminate();
  }
}
