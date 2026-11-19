// SPDX-License-Identifier: MIT
// Chip facts and the reset sequences. No DOM, no esptool-js: tested with node --test.

export const ESPRESSIF_VID = 0x303a;
export const USB_JTAG_PID = 0x1001;

// USB devices the port picker offers.
export const USB_FILTERS = [
  { usbVendorId: 0x303a }, // Espressif native USB (Serial/JTAG 0x1001, OTG CDC)
  { usbVendorId: 0x1a86 }, // WCH CH340/CH9102
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
];

// Guess the board from the USB ids before talking to it.
export function describeUsb(vid, pid) {
  if (vid === ESPRESSIF_VID && pid === USB_JTAG_PID) {
    return "Espressif USB Serial/JTAG (ESP32-S3: TRMNL X, ESP32-C3: TRMNL OG)";
  }
  if (vid === ESPRESSIF_VID) return "Espressif native USB, unknown ESP32 board";
  if (vid === 0x1a86) return "WCH CH340/CH9102 bridge, unknown ESP32 board";
  if (vid === 0x10c4) return "Silicon Labs CP210x bridge, unknown ESP32 board";
  return "unknown device";
}

export const WDT_WKEY = 0x50d83aa1; // RTC WDT write-protect unlock key
export const SWD_WKEY = 0x8f1d312a; // super watchdog write-protect unlock key
const SWD_AUTO_FEED = 0x80000000;
const WDT_TIMEOUT = 2000; // stage 0 timeout in RTC slow clock cycles
// enable (bit 31), stage 0 action 5 = RTC reset (bits 30:28), flash boot mode (bit 8), bits 1:0 = 2
const WDT_ENABLE = ((1 << 31) | (5 << 28) | (1 << 8) | 2) >>> 0;
const FULL = 0xffffffff;

// RTC_CNTL registers per chip (ESP32-S3/C3 technical reference and esptool's target tables).
// forceDl: OPTION1 FORCE_DOWNLOAD_BOOT, must be cleared or the chip boots into download mode again.
// strap: GPIO_STRAP_REG and its SPI boot bit (0 = GPIO0 low = download mode strapped).
export const CHIPS = {
  "ESP32-S3": {
    config0: 0x60008098, config1: 0x6000809c, wprotect: 0x600080b0,
    swdConf: 0x600080b4, swdWprotect: 0x600080b8,
    forceDl: { reg: 0x6000812c, mask: 0x1 },
    strap: { reg: 0x60004038, spiBootMask: 1 << 3 },
  },
  "ESP32-C3": {
    config0: 0x60008090, config1: 0x60008094, wprotect: 0x600080a8,
    swdConf: 0x600080ac, swdWprotect: 0x600080b0,
  },
};

const hex = (n) => `0x${(n >>> 0).toString(16)}`;

async function write(loader, log, addr, value, mask = FULL) {
  log(`writeReg ${hex(addr)} = ${hex(value)}${mask === FULL ? "" : ` mask ${hex(mask)}`}`);
  await loader.writeReg(addr, value, mask);
}

function chipOrThrow(chipName) {
  const c = CHIPS[chipName];
  if (!c) throw new Error(`${chipName} is not supported (only ${Object.keys(CHIPS).join(", ")})`);
  return c;
}

// Right after connecting over USB Serial/JTAG: stop the RTC WDT and let the super watchdog feed itself,
// so neither resets the chip in the middle of our commands (esptool disable_watchdogs).
export async function disableWatchdogs(loader, chipName, log = () => {}) {
  const c = chipOrThrow(chipName);
  await write(loader, log, c.wprotect, WDT_WKEY);
  await write(loader, log, c.config0, 0);
  await write(loader, log, c.wprotect, 0);
  await write(loader, log, c.swdWprotect, SWD_WKEY);
  const conf = (await loader.readReg(c.swdConf)) >>> 0;
  await write(loader, log, c.swdConf, (conf | SWD_AUTO_FEED) >>> 0);
  await write(loader, log, c.swdWprotect, 0);
}

// Leave the ROM bootloader into the app. Returns "watchdog" when the RTC WDT reset was armed,
// "hard" when the caller must fall back to the RTS hard reset (download mode still forced or strapped).
export async function resetToApp(loader, chipName, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const c = chipOrThrow(chipName);
  if (c.forceDl) {
    await write(loader, log, c.forceDl.reg, 0, c.forceDl.mask); // clear force download boot
    const strap = (await loader.readReg(c.strap.reg)) >>> 0;
    const force = (await loader.readReg(c.forceDl.reg)) >>> 0;
    log(`GPIO_STRAP ${hex(strap)}, OPTION1 ${hex(force)}`);
    if ((strap & c.strap.spiBootMask) === 0 || (force & c.forceDl.mask) !== 0) {
      log("Download mode still strapped or forced: watchdog reset skipped.");
      return "hard";
    }
  }
  await write(loader, log, c.wprotect, WDT_WKEY); // unlock
  await write(loader, log, c.config1, WDT_TIMEOUT); // timeout
  await write(loader, log, c.config0, WDT_ENABLE); // enable with RTC reset
  try {
    await write(loader, log, c.wprotect, 0); // lock
  } catch (err) {
    log(`lock write got no answer (chip already resetting): ${err.message}`);
  }
  await sleep(500); // wait for the reset to take effect
  return "watchdog";
}
