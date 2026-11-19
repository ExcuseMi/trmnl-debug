// SPDX-License-Identifier: MIT
// Chip facts and the RTC watchdog reset sequence. No DOM, no esptool-js: tested with node --test.

export const ESPRESSIF_VID = 0x303a;

// USB devices the port picker offers.
export const USB_FILTERS = [
  { usbVendorId: 0x303a }, // Espressif native USB (Serial/JTAG 0x1001, OTG CDC)
  { usbVendorId: 0x1a86 }, // WCH CH340/CH9102
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
];

// Guess the board from the USB ids before talking to it.
export function describeUsb(vid, pid) {
  if (vid === ESPRESSIF_VID && pid === 0x1001) {
    return "Espressif USB Serial/JTAG (ESP32-S3: TRMNL X, ESP32-C3: TRMNL OG)";
  }
  if (vid === ESPRESSIF_VID) return "Espressif native USB, unknown ESP32 board";
  if (vid === 0x1a86) return "WCH CH340/CH9102 bridge, unknown ESP32 board";
  if (vid === 0x10c4) return "Silicon Labs CP210x bridge, unknown ESP32 board";
  return "unknown device";
}

export const WDT_WKEY = 0x50d83aa1; // RTC WDT write-protect unlock key
const WDT_TIMEOUT = 2000; // stage 0 timeout in RTC slow clock cycles
// enable (bit 31), stage 0 action 5 = RTC reset (bits 30:28), flash boot mode (bit 8), bits 1:0 = 2
const WDT_ENABLE = ((1 << 31) | (5 << 28) | (1 << 8) | 2) >>> 0;

// RTC_CNTL registers per chip (from the ESP32-S3/C3 technical reference and esptool's target tables).
export const CHIPS = {
  "ESP32-S3": { config0: 0x60008098, config1: 0x6000809c, wprotect: 0x600080b0 },
  "ESP32-C3": { config0: 0x60008090, config1: 0x60008094, wprotect: 0x600080a8 },
};

// The writes, in order, as [address, value] pairs. Null for a chip we do not support.
export function watchdogSequence(chipName) {
  const c = CHIPS[chipName];
  if (!c) return null;
  return [
    [c.wprotect, WDT_WKEY], // unlock
    [c.config1, WDT_TIMEOUT], // timeout
    [c.config0, WDT_ENABLE], // enable with system reset
    [c.wprotect, 0], // lock
  ];
}

// Run the sequence through a loader that has writeReg(addr, value) (esptool-js ESPLoader).
// The chip may reset before the last write answers: an error after the enable write is expected.
export async function watchdogReset(loader, chipName, log = () => {}) {
  const seq = watchdogSequence(chipName);
  if (!seq) throw new Error(`${chipName} is not supported (only ${Object.keys(CHIPS).join(", ")})`);
  for (let i = 0; i < seq.length; i++) {
    const [addr, value] = seq[i];
    log(`writeReg 0x${addr.toString(16)} = 0x${(value >>> 0).toString(16)}`);
    try {
      await loader.writeReg(addr, value);
    } catch (err) {
      if (i < 3) throw err;
      log(`lock write got no answer (chip already resetting): ${err.message}`);
    }
  }
}
