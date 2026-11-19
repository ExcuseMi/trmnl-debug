# trmnl-debug

A static web page that finds a TRMNL over USB and restarts it with an RTC watchdog reset
(what `esptool --after watchdog-reset` does). The TRMNL X has no reset button; this replaces the esptool step.

| Button | Does |
|---|---|
| Connect | Port picker for Espressif native USB (303a), CH340 (1a86), CP210x (10c4); shows VID:PID and board guess |
| Detect | ROM bootloader (esptool-js reset), chip name and MAC, then watchdog reset back to the app |
| Watchdog reset | ROM bootloader, then watchdog reset |
| Read boot log | Read the serial port for 8 s |
| Serial monitor / Stop | Show everything the device sends; marks `boot:0x.. (DOWNLOAD...)` |

After a reset the page reads the serial port for a few seconds and shows the boot lines; `rst:0x10 (RTCWDT_RTC_RST)`
confirms the reset kind.

## Watchdog sequence

| Chip | WDTWPROTECT | WDTCONFIG1 | WDTCONFIG0 |
|---|---|---|---|
| ESP32-S3 (X) | 0x600080B0 | 0x6000809C | 0x60008098 |
| ESP32-C3 (OG) | 0x600080A8 | 0x60008094 | 0x60008090 |

Order, as esptool 5.x does it:

1. After connect (USB Serial/JTAG only): RTC WDT off (unlock, CONFIG0 = 0, lock); super watchdog auto-feed
   (SWD_WPROTECT = 0x8F1D312A, SWD_CONF bit 31, lock). S3: 0x600080B8/B4, C3: 0x600080B0/AC.
2. S3 only: clear FORCE_DOWNLOAD_BOOT (OPTION1 0x6000812C, mask 0x1), else the chip boots into download mode again.
   Watchdog only when GPIO_STRAP (0x60004038) bit 3 is clear (GPIO0 low, as after the USB reset into download
   mode) and the bit stays clear, as in esptool's hard_reset; otherwise RTS hard reset.
3. Drop DTR and RTS, then WPROTECT = 0x50D83AA1 (unlock), CONFIG1 = 2000, CONFIG0 = 0xD0000102 (enable, stage 0 resets the chip),
   WPROTECT = 0 (lock), wait 0.5 s.
4. Reopen the port (same VID:PID) and read the boot log for 8 s; "Read boot log" repeats that.

Other chips: the page says so and writes nothing.

## Browser support

Web Serial only: Chrome or Edge on desktop (Windows, macOS, Linux, ChromeOS). Not Firefox, Safari or mobile.

On a Windows PC that shares the device with WSL: detach it first (`usbipd detach --busid <id>`) so Windows owns the port.

Not detected: put the device in flashing mode by hand, see [TRMNL's guide](https://help.trmnl.com/en/articles/11936721-put-your-trmnl-in-flashing-mode#h_96e07a072e).

## Safety

Never writes or erases flash, never touches eFuses. Only reads chip registers and writes the RTC watchdog, super watchdog and force-download-boot registers.

## Development

No build step. `npm test` (node --test) checks the register traffic per chip. Serve the folder with any static server.

## Licence

MIT (this code). `vendor/esptool-js-0.7.0/` is esptool-js by Espressif, Apache-2.0, unmodified.
