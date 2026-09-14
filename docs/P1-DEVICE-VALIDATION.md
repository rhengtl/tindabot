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
