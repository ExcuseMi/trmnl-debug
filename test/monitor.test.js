// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { SerialMonitor, classify } from "../monitor.js";

const enc = new TextEncoder();

// Fake Web Serial port. chunks: text pieces it delivers; then it either loses the device (lose: true)
// or waits until the reader is cancelled. ops records every call in order.
function fakePort(ops, name, { chunks = [], lose = false, open = false } = {}) {
  const port = {
    readable: null,
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    async open(opts) {
      ops.push(`${name}.open ${opts.baudRate}`);
      port.readable = stream();
    },
    async setSignals(s) {
      ops.push(`${name}.setSignals dtr=${s.dataTerminalReady} rts=${s.requestToSend}`);
    },
    async close() {
      ops.push(`${name}.close`);
      port.readable = null;
    },
  };
  function stream() {
    const queue = [...chunks];
    let wake = null;
    return {
      locked: false,
      getReader() {
        return {
          async read() {
            ops.push(`${name}.read`);
            if (queue.length) return { value: enc.encode(queue.shift()), done: false };
            if (lose) {
              port.readable = null;
              throw new Error("The device has been lost.");
            }
            return new Promise((r) => (wake = r));
          },
          async cancel() {
            if (wake) wake({ value: undefined, done: true });
          },
          releaseLock() {},
        };
      },
    };
  }
  if (open) port.readable = stream();
  return port;
}

function makeMonitor(ports) {
  const lines = [];
  const m = new SerialMonitor({ log: (s, cls) => lines.push([s, cls]), getPorts: async () => ports, sleep: async () => {} });
  return { m, lines };
}

test("closed port: open, then DTR and RTS low, before the first read", async () => {
  const ops = [];
  const port = fakePort(ops, "p", { chunks: ["ESP-ROM:esp32s3-20210327\r\n"] });
  const { m, lines } = makeMonitor([port]);
  const done = m.start(port);
  await new Promise((r) => setTimeout(r, 10));
  m.stop();
  await done;
  assert.deepEqual(ops.slice(0, 3), ["p.open 115200", "p.setSignals dtr=false rts=false", "p.read"]);
  assert.ok(lines.some(([s]) => s === "| ESP-ROM:esp32s3-20210327"));
});

test("port left open after a reset is read as is: no open, no signal change", async () => {
  const ops = [];
  const port = fakePort(ops, "p", { open: true, chunks: ["[MODEM] Resetting modem...\n"] });
  const { m } = makeMonitor([port]);
  const done = m.start(port, { stopAfterMs: 20 });
  await done;
  assert.ok(!ops.some((o) => o.endsWith(".open 115200") || o.includes("setSignals")), ops.join(", "));
});

test("device lost: waits for the same USB ids, reopens quietly and keeps reading", async () => {
  const ops = [];
  const first = fakePort(ops, "a", { open: true, chunks: ["rst:0x10 (RTCWDT_RTC_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)\n"], lose: true });
  const second = fakePort(ops, "b", { chunks: ["FastEPD full update\n"] });
  const { m, lines } = makeMonitor([second]);
  const done = m.start(first);
  await new Promise((r) => setTimeout(r, 10));
  m.stop();
  const p = await done;
  assert.equal(p, second);
  const i = ops.indexOf("b.open 115200");
  assert.deepEqual(ops.slice(i, i + 3), ["b.open 115200", "b.setSignals dtr=false rts=false", "b.read"]);
  assert.ok(lines.some(([s]) => s === "| FastEPD full update"));
  assert.ok(lines.some(([s]) => /RTC watchdog/.test(s)));
});

test("a stopAfterMs read can become open-ended on the same port", async () => {
  const ops = [];
  const port = fakePort(ops, "p", { open: true });
  const { m } = makeMonitor([port]);
  const done = m.start(port, { stopAfterMs: 30 });
  assert.ok(m.limited);
  m.unlimit();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(m.running, "still reading after the old limit");
  m.stop();
  await done;
  assert.ok(!m.running);
});

test("line classes", () => {
  assert.equal(classify("boot:0x0 (DOWNLOAD(USB/UART0))"), "warn");
  assert.equal(classify("boot:0x8 (SPI_FAST_FLASH_BOOT)"), "ok");
  assert.equal(classify("rst:0x10 (RTCWDT_RTC_RST),boot:0x8"), "ok");
  assert.equal(classify("FastEPD full update"), "boot");
});
