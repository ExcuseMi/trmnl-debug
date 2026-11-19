# trmnl-debug

A static web page that finds a TRMNL over USB and restarts it with an RTC watchdog reset
(what `esptool --after watchdog-reset` does). The TRMNL X has no reset button; this replaces the esptool step.

| Button | Does |
|---|---|
| Connect | Port picker for Espressif native USB (303a), CH340 (1a86), CP210x (10c4); shows VID:PID and board guess |
| Detect | ROM bootloader (esptool-js reset), chip name and MAC, then watchdog reset back to the app |
| Watchdog reset | ROM bootloader, then watchdog reset |

After a reset the page reads the serial port for a few seconds and shows the boot lines; `rst:0x10 (RTCWDT_RTC_RST)`
confirms the reset kind.

## Watchdog sequence

| Chip | WDTWPROTECT | WDTCONFIG1 | WDTCONFIG0 |
|---|---|---|---|
| ESP32-S3 (X) | 0x600080B0 | 0x6000809C | 0x60008098 |
| ESP32-C3 (OG) | 0x600080A8 | 0x60008094 | 0x60008090 |

Writes in order: WPROTECT = 0x50D83AA1 (unlock), CONFIG1 = 2000 (timeout), CONFIG0 = 0xD0000102 (enable, stage 0
resets the chip), WPROTECT = 0 (lock). Other chips: the page says so and writes nothing.

## Browser support

Web Serial only: Chrome or Edge on desktop (Windows, macOS, Linux, ChromeOS). Not Firefox, Safari or mobile.

On a Windows PC that shares the device with WSL: detach it first (`usbipd detach --busid <id>`) so Windows owns the port.

Not detected: put the device in flashing mode by hand, see [TRMNL's guide](https://help.trmnl.com/en/articles/11936721-put-your-trmnl-in-flashing-mode#h_96e07a072e).

## Safety

Never writes or erases flash, never touches eFuses. Only reads chip registers and writes the four RTC watchdog registers.

## Development

No build step. `npm test` (node --test) checks the register sequence per chip. Serve the folder with any static server.

## Licence

MIT (this code). `vendor/esptool-js-0.7.0/` is esptool-js by Espressif, Apache-2.0, unmodified.
