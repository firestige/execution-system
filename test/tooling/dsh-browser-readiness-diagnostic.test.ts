import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  captureBrowserReadinessDiagnostic,
  observeChildTranscript,
  type CdpConnection,
} from "../../scripts/qualify-dsh-interactive-intake.js";

describe("DSH browser readiness diagnostics", () => {
  it("captures bounded process output and the current DOM/runtime state without changing readiness", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const transcript = observeChildTranscript({ stdout, stderr } as unknown as ChildProcess, 12);
    stdout.write("initial-output");
    stderr.write("-tail");

    const cdp = {
      events: [{ method: "Log.entryAdded", params: { entry: { text: "client failed" } } }],
      async call(method: string) {
        expect(method).toBe("Runtime.evaluate");
        return { result: { value: {
          url: "http://127.0.0.1:1234/",
          readyState: "complete",
          bodyText: "Loading",
          root: { present: true, inert: true, attributes: { id: "root", inert: "" }, html: "" },
          controls: [],
        } } };
      },
      close() {},
    } satisfies CdpConnection;

    await expect(captureBrowserReadinessDiagnostic(cdp)).resolves.toEqual({
      page: expect.objectContaining({ readyState: "complete", bodyText: "Loading" }),
      cdpEvents: cdp.events,
    });
    expect(transcript()).toBe("-output-tail");
  });
});
