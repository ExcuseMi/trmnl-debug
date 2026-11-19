// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetToApp, disableWatchdogs, describeUsb } from "../chips.js";

// Expected register traffic, written out by hand from esptool 5.6.0 targets/esp32s3.py and esp32c3.py.
// w = write [addr, value, mask], r = read addr, s = sleep ms.
const F = 0xffffffff;
const WDT = (wprotect, config1, config0) => [
  ["release"],
  ["w", wprotect, 0x50d83aa1, F],
  ["w", config1, 2000, F],
  ["w", config0, 0xd0000102, F],
  ["w", wprotect, 0, F],
  ["s", 500],
];
const EXPECTED_RESET = {
  "ESP32-S3": [
    ["w", 0x6000812c, 0, 0x1], // clear FORCE_DOWNLOAD_BOOT first
    ["r", 0x60004038],
    ["r", 0x6000812c],
    ...WDT(0x600080b0, 0x6000809c, 0x60008098),
  ],
  "ESP32-C3": WDT(0x600080a8, 0x60008094, 0x60008090),
};
const EXPECTED_DISABLE = {
  "ESP32-S3": [
    ["w", 0x600080b0, 0x50d83aa1, F], ["w", 0x60008098, 0, F], ["w", 0x600080b0, 0, F],
    ["w", 0x600080b8, 0x8f1d312a, F], ["r", 0x600080b4], ["w", 0x600080b4, 0x80000005, F], ["w", 0x600080b8, 0, F],
  ],
  "ESP32-C3": [
    ["w", 0x600080a8, 0x50d83aa1, F], ["w", 0x60008090, 0, F], ["w", 0x600080a8, 0, F],
    ["w", 0x600080b0, 0x8f1d312a, F], ["r", 0x600080ac], ["w", 0x600080ac, 0x80000005, F], ["w", 0x600080b0, 0, F],
  ],
};

// regs: values readReg returns. Default: GPIO_STRAP 0x1 as read on a stuck X in download mode (GPIO0 low,
// SPI boot bit 3 clear), force download clear, SWD conf 5.
function fakeLoader({ failAt = -1, regs = {} } = {}) {
  const ops = [];
  const values = { 0x60004038: 0x1, 0x6000812c: 0, 0x600080b4: 5, 0x600080ac: 5, ...regs };
  return {
    ops,
    sleep: async (ms) => ops.push(["s", ms]),
    release: async () => ops.push(["release"]),
    async readReg(addr) {
      ops.push(["r", addr]);
      return values[addr] ?? 0;
    },
    async writeReg(addr, value, mask = F) {
      ops.push(["w", addr, value >>> 0, mask >>> 0]);
      if (ops.filter((o) => o[0] === "w").length - 1 === failAt) throw new Error("timeout");
    },
  };
}
const run = (l, chip) => resetToApp(l, chip, () => {}, l.sleep, l.release);

for (const chip of Object.keys(EXPECTED_RESET)) {
  test(`${chip}: reset traffic in order`, async () => {
    const l = fakeLoader();
    assert.equal(await run(l, chip), "watchdog");
    assert.deepEqual(l.ops, EXPECTED_RESET[chip]);
  });

  test(`${chip}: disable watchdogs after connect`, async () => {
    const l = fakeLoader();
    await disableWatchdogs(l, chip);
    assert.deepEqual(l.ops, EXPECTED_DISABLE[chip]);
  });

  test(`${chip}: no answer to the lock write is fine`, async () => {
    const l = fakeLoader({ failAt: EXPECTED_RESET[chip].filter((o) => o[0] === "w").length - 1 });
    assert.equal(await run(l, chip), "watchdog");
  });

  test(`${chip}: a failed enable write is an error`, async () => {
    await assert.rejects(run(fakeLoader({ failAt: EXPECTED_RESET[chip].filter((o) => o[0] === "w").length - 2 }), chip));
  });
}

test("ESP32-S3: GPIO_STRAP 0x1 (GPIO0 low) takes the watchdog path", async () => {
  assert.equal(await run(fakeLoader({ regs: { 0x60004038: 0x1 } }), "ESP32-S3"), "watchdog");
});

test("ESP32-S3: GPIO0 high (strap bit 3 set) falls back to hard reset, no WDT writes", async () => {
  const l = fakeLoader({ regs: { 0x60004038: 0x9 } });
  assert.equal(await run(l, "ESP32-S3"), "hard");
  assert.equal(l.ops.filter((o) => o[0] === "w").length, 1);
});

test("ESP32-S3: force download still set falls back to hard reset", async () => {
  const l = fakeLoader({ regs: { 0x6000812c: 1 } });
  assert.equal(await run(l, "ESP32-S3"), "hard");
});

test("unsupported chip: nothing is written", async () => {
  const l = fakeLoader();
  await assert.rejects(run(l, "ESP32"), /not supported/);
  await assert.rejects(disableWatchdogs(l, "ESP32"), /not supported/);
  assert.equal(l.ops.length, 0);
});

test("USB ids are labelled", () => {
  assert.match(describeUsb(0x303a, 0x1001), /Serial\/JTAG/);
  assert.match(describeUsb(0x1a86, 0x7523), /unknown ESP32 board/);
  assert.match(describeUsb(0x10c4, 0xea60), /unknown ESP32 board/);
});
