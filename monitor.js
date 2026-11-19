// SPDX-License-Identifier: MIT
// Serial monitor over Web Serial. No DOM: tested with node --test and a fake port.

const BOOT_DL = /boot:0x\w+ \(DOWNLOAD/i;
const BOOT_OK = /boot:0x\w+ \(SPI_FAST_FLASH_BOOT\)/i;
const RST_WDT = /rst:0x\w+ \(RTC_?WDT/i;

export function classify(line) {
  if (BOOT_DL.test(line)) return "warn";
  if (BOOT_OK.test(line) || RST_WDT.test(line)) return "ok";
  return "boot";
}

// Open, then drop DTR and RTS before anything is read. On the USB Serial/JTAG bridge RTS high with DTR low
// resets the chip, so the lines must not stay in the state the OS left them in after open.
export async function openQuiet(port) {
  await port.open({ baudRate: 115200 });
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
}

// Wait for a port with the same USB ids (it re-enumerates after a reset) and open it quietly.
export async function findPort(getPorts, vid, pid, ms, sleep) {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const cand of await getPorts()) {
      const i = cand.getInfo();
      if (i.usbVendorId !== vid || i.usbProductId !== pid) continue;
      if (cand.readable) return cand; // still open
      try {
        await openQuiet(cand);
        return cand;
      } catch {
        /* not back yet */
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

export class SerialMonitor {
  constructor({ log, getPorts, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onChange = () => {} }) {
    Object.assign(this, { log, getPorts, sleep, onChange });
    this.state = null;
  }

  get running() {
    return this.state !== null;
  }

  get limited() {
    return !!(this.state && this.state.timer);
  }

  // Keep reading past the time limit of a boot log read, on the same open port.
  unlimit() {
    if (!this.limited) return;
    clearTimeout(this.state.timer);
    this.state.timer = null;
    this.log("Monitor: continuing without a time limit. Stop to end.", "ok");
    this.onChange();
  }

  stop() {
    if (!this.state) return;
    this.state.stopped = true;
    clearTimeout(this.state.timer);
    if (this.state.reader) this.state.reader.cancel().catch(() => {});
  }

  // Read until stop() (or stopAfterMs). An already open port is read as is, never reopened.
  // Returns the port in use at the end (it can be a new object after re-enumeration), or null.
  async start(port, { stopAfterMs = 0 } = {}) {
    if (this.state) return port;
    const st = (this.state = { stopped: false, timer: null, reader: null });
    if (stopAfterMs) st.timer = setTimeout(() => this.stop(), stopAfterMs);
    this.onChange();
    const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
    let p = port;
    if (!p.readable) {
      try {
        await openQuiet(p);
      } catch {
        p = await findPort(this.getPorts, vid, pid, 8000, this.sleep);
      }
    }
    if (p) this.log(stopAfterMs ? `Reading the serial port for ${stopAfterMs / 1000} s...` : "Monitor: open at 115200. Stop to end.", "ok");
    const dec = new TextDecoder();
    let pending = "";
    let seen = 0;
    const show = (l) => {
      if (!l.trim()) return;
      seen++;
      this.log(`| ${l}`, classify(l));
      if (BOOT_DL.test(l)) this.log("The chip booted into DOWNLOAD mode (ROM bootloader), not the app.", "warn");
      if (RST_WDT.test(l)) this.log("Reset kind confirmed: RTC watchdog.", "ok");
    };
    while (p && !st.stopped) {
      const reader = p.readable.getReader();
      st.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += dec.decode(value, { stream: true });
          const parts = pending.split(/\r?\n/);
          pending = parts.pop();
          parts.forEach(show);
        }
      } catch {
        /* framing error (readable comes back) or device lost (it does not) */
      }
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
      st.reader = null;
      if (st.stopped || p.readable) continue;
      this.log("Monitor: port lost (reset?), waiting up to 8 s for it to come back...", "warn");
      await p.close().catch(() => {});
      p = await findPort(this.getPorts, vid, pid, 8000, this.sleep);
      if (!p) this.log("Monitor: the port did not come back.", "warn");
    }
    show(pending);
    if (!seen) this.log("No serial output seen.", "warn");
    if (p) await p.close().catch(() => {});
    this.state = null;
    this.log("Monitor stopped.");
    this.onChange();
    return p;
  }
}
