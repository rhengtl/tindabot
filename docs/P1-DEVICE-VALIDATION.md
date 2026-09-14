# P1 device validation — 2026-09-14

Environment: Android Emulator 36.4.10 · AVD `Medium_Phone_API_36.1` (1080×2400 @420dpi) ·
Android 16 (API 36.1, `google_apis_playstore` x86_64 image) · Chrome 134.0.6998.135 ·
production build served by `vite preview` on the LAN (192.168.1.6:4173) and mapped into the
device via `adb reverse` so `http://localhost:4173` is a secure context. Driven with Playwright
over CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`) plus adb/uiautomator for
Chrome's native UI (install dialog, launcher, airplane mode, force-stop).

Not a physical phone: WebAPK minting is unavailable on the emulator, so "Add to Home screen"
produced a Chrome-badged shortcut that still launches in standalone mode (`WebappActivity`).

Passed on device: onboarding, catalog (with aliases), add/edit product, Bumili with natira and
backdated (kahapon) purchase, lugi prompt, Bilang mode (packs+loose, 4-digit entry), Bahay list,
Paninda, bakit (Tier A and Tier B), Burahin/Ibalik, export (share sheet intercepted), import ×2
(no duplicates: 58/58/58 events), settings, refresh, close/reopen, app switch, force-stop and
relaunch from the icon in airplane mode, no horizontal scroll, all buttons ≥ 44 px.

Fixed during validation: soft keyboard covered bottom sheets (viewport
`interactive-widget=resizes-content`); catalog search missed "coke"/"canton"/"bigas" (aliases +
normalized multi-term match); inconsistent-count hint was only in bakit (now on the row, per §D);
list rows/nudge/✕ touch targets < 44 px; persist-storage hint wording.

Known: `navigator.storage.persisted()` is false for the shortcut install on this emulator — the
app relies on the monthly export nudge; Chrome grants persistence to WebAPK installs / engaged
sites on real devices. Home-screen icon is a plain amber square (no glyph).

## Physical device (2026-09-14)

realme RMX3710 (realme C55), Android 15 / API 35, 1080×2400 @ 408 dpi, USB debugging. Chrome is
user-disabled on this phone, so the run used **Brave 1.94.121 (Chromium 152.0.7977.83)**. Same
setup: `vite preview --host 0.0.0.0 --port 4173` + `adb reverse tcp:4173 tcp:4173`; real taps via
`adb shell input`, state read via CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`).

Passed on the phone: onboarding, catalog search ("coke"), custom 70-char name, Bumili with natira
+ Kahapon + confirmation sum + lugi prompt, Gboard numeric keyboard on ₱/natira fields (viewport
shrinks 794→510 px, focused field stays visible), native date picker on "Ibang araw", Bilang numpad
by real taps, Paninda/detail, Burahin/Ibalik, native `confirm` dialog, export → import ×2
(57/57/57), refresh, Brave close/reopen, app switch (tab state kept), force-stop, offline relaunch
with airplane mode on **and** `adb reverse` removed (SW-served, 11 products / 6 rows intact),
swipe scrolling, no horizontal overflow (423/423) on all tabs, Tier A never red / no on-hand
wording / limitation text in bakit, no-data row shows "?".

Fixed: `.btn.ghost` ("Itinigil na paninda", "Tapos", "Subukan ang demo", "Ipakita") and `.chip`
(restock-day pills) were 40 px tall — raised to the tap size. Service-worker `autoUpdate`
delivered the rebuilt assets to the phone with data intact.

Not verifiable here: Brave offers "Install app" and registers the shortcut as standalone
(`webapp_display_mode=3`), but the realme launcher never places the icon (also when added by
hand), so standalone/WebAPK behaviour and `persisted()` for an installed app remain untested on a
physical phone; in-tab `persisted()` is false. Chrome for Android itself was not exercised
(user-disabled on this phone). The export share sheet was intercepted to capture the file, so the
real share target (Files/Drive/Messenger) was not tested.
