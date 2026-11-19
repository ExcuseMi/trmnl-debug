// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchdogReset, watchdogSequence, describeUsb } from "../chips.js";

// Expected writes, written out by hand from esptool 5.6.0 targets/esp32s3.py and esp32c3.py.
const EXPECTED = {
  "ESP32-S3": [
    [0x600080b0, 0x50d83aa1],
    [0x6000809c, 2000],
    [0x60008098, 0xd0000102],
    [0x600080b0, 0],
  ],
  "ESP32-C3": [
    [0x600080a8, 0x50d83aa1],
    [0x60008094, 2000],
    [0x60008090, 0xd0000102],
    [0x600080a8, 0],
  ],
};

function fakeLoader({ failAt = -1 } = {}) {
  const writes = [];
  return {
    writes,
    async writeReg(addr, value) {
      writes.push([addr, value >>> 0]);
      if (writes.length - 1 === failAt) throw new Error("timeout");
    },
  };
}

for (const [chip, expected] of Object.entries(EXPECTED)) {
  test(`${chip}: writes unlock, timeout, enable, lock in order`, async () => {
    const loader = fakeLoader();
    await watchdogReset(loader, chip);
    assert.deepEqual(loader.writes, expected);
  });

  test(`${chip}: no answer to the lock write is fine`, async () => {
    const loader = fakeLoader({ failAt: 3 });
    await watchdogReset(loader, chip);
    assert.equal(loader.writes.length, 4);
  });

  test(`${chip}: a failed enable write is an error`, async () => {
    await assert.rejects(watchdogReset(fakeLoader({ failAt: 2 }), chip));
  });
}

test("unsupported chip: nothing is written", async () => {
  const loader = fakeLoader();
  assert.equal(watchdogSequence("ESP32"), null);
  await assert.rejects(watchdogReset(loader, "ESP32"), /not supported/);
  assert.equal(loader.writes.length, 0);
});

test("USB ids are labelled", () => {
  assert.match(describeUsb(0x303a, 0x1001), /Serial\/JTAG/);
  assert.match(describeUsb(0x1a86, 0x7523), /unknown ESP32 board/);
  assert.match(describeUsb(0x10c4, 0xea60), /unknown ESP32 board/);
});
