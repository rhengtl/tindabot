// Export-to-file used by the Backup card and by the P3a claim-choice sheet ("I-export muna").
//
// `last_backup_at` is what the app uses to tell the owner they still have a backup, so it is only
// written when the browser confirmed the export: `navigator.share` resolving means the file was
// handed to another app. A download link gives no such confirmation — the realme C55 / Brave 1.95
// used for device validation reports "1 download failed" and writes nothing, and the page never
// hears about it — so the download route is reported as *started*, never as a finished backup.
import { toLocalDate } from '../domain'
import { useApp } from '../state/store'

export type ExportOutcome =
  /** The phone's share sheet accepted the file: a confirmed backup. */
  | 'shared'
  /** A download was handed to the browser; nothing tells the page whether it landed. */
  | 'download_started'
  /** The person dismissed the share sheet. */
  | 'cancelled'
  /** Neither route could even be started. */
  | 'failed'

/** Shares (or downloads) the current store as a TindaBot export file. */
export async function exportCurrentStore(): Promise<ExportOutcome> {
  const { exportJson, setMeta } = useApp.getState()
  const fname = `tindabot-${toLocalDate(Date.now())}.json`
  try {
    const blob = new Blob([exportJson()], { type: 'application/json' })
    const file = new File([blob], fname, { type: 'application/json' })
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fname })
        await setMeta('last_backup_at', new Date().toISOString())
        return 'shared'
      } catch (e) {
        // The person dismissed the share sheet -> nothing was exported.
        if ((e as Error).name === 'AbortError') return 'cancelled'
        // Some browsers say they can share files and then refuse (realme/Brave:
        // NotAllowedError). Saving must still be attempted — but it is not a confirmed backup.
      }
    }
    download(blob, fname)
    await setMeta('last_export_attempt_at', new Date().toISOString())
    return 'download_started'
  } catch {
    return 'failed'
  }
}

function download(blob: Blob, fname: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fname
  a.rel = 'noopener'
  // Android Chromium needs the link in the document, and revoking the blob URL straight after
  // the click cancels the download ("1 download failed" on the realme) — let it finish first.
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
