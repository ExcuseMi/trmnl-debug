// SPDX-License-Identifier: MIT
import { ESPLoader, Transport } from "./vendor/esptool-js-0.7.0/bundle.js";
import { USB_FILTERS, CHIPS, ESPRESSIF_VID, USB_JTAG_PID, describeUsb, disableWatchdogs, resetToApp } from "./chips.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
let port = null;
let busy = false;

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const terminal = {
  clean() {},
  writeLine: (s) => log(s, "dim"),
  write: (s) => s.trim() && log(s.trim(), "dim"),
};

const hex4 = (n) => (n ?? 0).toString(16).padStart(4, "0");

function setButtons() {
  $("connect").disabled = busy;
  $("detect").disabled = busy || !port;
  $("reset").disabled = busy || !port;
  $("bootlog").disabled = busy || !port;
}

async function connect() {
  try {
    port = await navigator.serial.requestPort({ filters: USB_FILTERS });
  } catch (err) {
    log(`No port chosen (${err.message})`, "warn");
    return;
  }
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
  $("found").textContent = `USB ${hex4(vid)}:${hex4(pid)}, ${describeUsb(vid, pid)}`;
  log(`Port chosen: ${hex4(vid)}:${hex4(pid)} ${describeUsb(vid, pid)}`);
  setButtons();
}

// Enter the ROM bootloader and identify the chip. Only reads registers.
async function openLoader() {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal });
  log("Resetting into the ROM bootloader (esptool-js default reset)...");
  await loader.detectChip("default_reset");
  return { transport, loader, chip: loader.chip.CHIP_NAME };
}

async function closeQuietly(transport) {
  try {
    await transport.disconnect();
  } catch {
    /* port already gone after the reset */
  }
}

// After the reset the USB device can re-enumerate: wait for it, then read the boot log.
async function readBootLines(ms = 8000) {
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
  const deadline = Date.now() + 8000;
  let p = null;
  while (!p && Date.now() < deadline) {
    for (const cand of await navigator.serial.getPorts()) {
      const i = cand.getInfo();
      if (i.usbVendorId !== vid || i.usbProductId !== pid) continue;
      try {
        await cand.open({ baudRate: 115200 });
        p = cand;
        break;
      } catch {
        /* not back yet */
      }
    }
    if (!p) await new Promise((r) => setTimeout(r, 250));
  }
  if (!p) {
    log("Port did not come back within 8 s; press Read boot log once it is back.", "warn");
    return;
  }
  port = p;
  log(`Reading the serial port for ${ms / 1000} s...`);
  const reader = p.readable.getReader();
  const dec = new TextDecoder();
  let text = "";
  const stop = setTimeout(() => reader.cancel().catch(() => {}), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch {
    /* cancelled or device gone */
  }
  clearTimeout(stop);
  reader.releaseLock();
  await p.close().catch(() => {});
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) log("No boot output seen (the ROM lines can be gone before the port reopens).", "warn");
  for (const l of lines) log(`| ${l}`, /rst:0x\w+ \(RTC_?WDT/i.test(l) ? "ok" : "boot");
  if (lines.some((l) => /rst:0x\w+ \(RTC_?WDT/i.test(l))) log("Reset kind confirmed: RTC watchdog.", "ok");
}

async function run(withDetails) {
  busy = true;
  setButtons();
  let transport = null;
  try {
    const opened = await openLoader();
    transport = opened.transport;
    const { loader, chip } = opened;
    log(`Chip: ${chip}`, "ok");
    if (withDetails) {
      log(`Description: ${await loader.chip.getChipDescription(loader)}`, "ok");
      log(`MAC: ${await loader.chip.readMac(loader)}`, "ok");
    }
    if (!CHIPS[chip]) {
      log(`${chip} is not supported for the watchdog reset. Nothing written.`, "warn");
      log("Leaving the ROM bootloader with the normal RTS reset line.");
      await loader.after("hard_reset");
      return;
    }
    const info = port.getInfo();
    if (info.usbVendorId === ESPRESSIF_VID && info.usbProductId === USB_JTAG_PID) {
      log("USB Serial/JTAG: stopping the RTC WDT and auto-feeding the super watchdog (as esptool does)...");
      await disableWatchdogs(loader, chip, log);
    }
    log("Leaving the bootloader: clear force-download, then RTC watchdog reset...");
    if ((await resetToApp(loader, chip, log)) === "hard") {
      log("Falling back to the RTS hard reset.", "warn");
      await loader.after("hard_reset");
    }
    await closeQuietly(transport);
    transport = null;
    await readBootLines();
  } catch (err) {
    log(`Error: ${err.message}`, "warn");
  } finally {
    if (transport) await closeQuietly(transport);
    busy = false;
    setButtons();
  }
}

if (!("serial" in navigator)) {
  $("noserial").hidden = false;
  $("connect").disabled = true;
  log("This browser has no Web Serial. Use desktop Chrome or Edge.", "warn");
} else {
  $("connect").addEventListener("click", connect);
  $("detect").addEventListener("click", () => run(true));
  $("reset").addEventListener("click", () => run(false));
  $("bootlog").addEventListener("click", async () => {
    busy = true;
    setButtons();
    await readBootLines().catch((err) => log(`Error: ${err.message}`, "warn"));
    busy = false;
    setButtons();
  });
  setButtons();
  log("Ready. Connect a TRMNL with a USB data cable.");
}
