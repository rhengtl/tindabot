// Export-to-file used by the Backup card and by the P3a claim-choice sheet ("I-export muna").
//
// `last_backup_at` records the last export this app successfully handed over — either to another
// app (`navigator.share` resolved) or to the browser's own download machinery. A web page cannot
// observe where a download finally lands, or whether the person confirmed the browser's save
// prompt, so the date means "the export was started", never "the file is provably on disk". The
// UI says the same thing in words. A route that could not even be started writes nothing.
import { toLocalDate } from '../domain'
import { useApp } from '../state/store'

export type ExportOutcome =
  /** The phone's share sheet accepted the file. */
  | 'shared'
  /** The file was handed to the browser, which decides where (and whether) it is saved. */
  | 'download_started'
  /** The person dismissed the share sheet. */
  | 'cancelled'
  /** Neither route could even be started — nothing was exported. */
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
        // NotAllowedError). The download route below is the way out.
      }
    }
    // Throws if the link cannot even be made, which leaves the date untouched (see below).
    download(blob, fname)
    await setMeta('last_backup_at', new Date().toISOString())
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
  // the click cancels the download before it can be written — let it finish first.
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
