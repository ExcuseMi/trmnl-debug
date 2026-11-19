// SPDX-License-Identifier: MIT
const PAGE_VERSION = "4 (quiet monitor open, copy log)";
import { ESPLoader, Transport } from "./vendor/esptool-js-0.7.0/bundle.js";
import { USB_FILTERS, CHIPS, ESPRESSIF_VID, USB_JTAG_PID, describeUsb, disableWatchdogs, resetToApp } from "./chips.js?v=4";
import { SerialMonitor } from "./monitor.js?v=4";

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

const monitor = new SerialMonitor({
  log,
  getPorts: () => navigator.serial.getPorts(),
  onChange: () => setButtons(),
});

function setButtons() {
  const idle = !busy && !monitor.running;
  $("connect").disabled = !idle;
  $("detect").disabled = !idle || !port;
  $("reset").disabled = !idle || !port;
  $("bootlog").disabled = !idle || !port;
  $("monitor").disabled = !port || busy || (monitor.running && !monitor.limited);
  $("monitorstop").disabled = !monitor.running;
}

// Boot log (stopAfterMs) or open-ended monitor. A running boot log read becomes open-ended, same open port.
async function watch(stopAfterMs = 0) {
  if (monitor.running) {
    if (!stopAfterMs) monitor.unlimit();
    return;
  }
  const p = await monitor.start(port, { stopAfterMs });
  if (p) port = p;
}

async function copyLog() {
  const text = logEl.innerText;
  try {
    await navigator.clipboard.writeText(text);
    log(`Log copied (${text.split("\n").length} lines).`, "ok");
  } catch {
    const r = document.createRange();
    r.selectNodeContents(logEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    log("Clipboard blocked: log selected, press Ctrl+C.", "warn");
  }
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

// Hand the open port over from esptool-js without closing it: closing and reopening toggles DTR/RTS,
// which on USB Serial/JTAG can reset the chip again.
async function releaseTransport(transport) {
  try {
    if (port.readable && port.readable.locked && transport.reader) await transport.reader.cancel();
    await transport.waitForUnlock(400);
  } catch {
    /* port gone after the reset: the monitor reopens it */
  }
}

async function run(withDetails) {
  busy = true;
  setButtons();
  let transport = null;
  let didReset = false;
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
    const release = () => transport.setSignals(false, false);
    if ((await resetToApp(loader, chip, log, undefined, release)) === "hard") {
      log("Falling back to the RTS hard reset.", "warn");
      await loader.after("hard_reset");
    }
    await releaseTransport(transport);
    transport = null;
    didReset = true;
  } catch (err) {
    log(`Error: ${err.message}`, "warn");
  } finally {
    if (transport) await closeQuietly(transport);
    busy = false;
    setButtons();
  }
  if (didReset) await watch(8000);
}

if (!("serial" in navigator)) {
  $("noserial").hidden = false;
  $("connect").disabled = true;
  log("This browser has no Web Serial. Use desktop Chrome or Edge.", "warn");
} else {
  $("connect").addEventListener("click", connect);
  $("detect").addEventListener("click", () => run(true));
  $("reset").addEventListener("click", () => run(false));
  $("copylog").addEventListener("click", copyLog);
  $("monitor").addEventListener("click", () => watch(0));
  $("monitorstop").addEventListener("click", () => monitor.stop());
  $("bootlog").addEventListener("click", () => watch(8000));
  setButtons();
  log(`Ready (page version ${PAGE_VERSION}). Connect a TRMNL with a USB data cable.`);
}
