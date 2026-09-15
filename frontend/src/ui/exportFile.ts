// Export-to-file used by the Backup card and by the P3a claim-choice sheet ("I-export muna").
import { toLocalDate } from '../domain'
import { useApp } from '../state/store'

/** Shares (or downloads) the current store as a TindaBot export file. Returns false when cancelled. */
export async function exportCurrentStore(): Promise<boolean> {
  const { exportJson, setMeta } = useApp.getState()
  const text = exportJson()
  const fname = `tindabot-${toLocalDate(Date.now())}.json`
  const blob = new Blob([text], { type: 'application/json' })
  try {
    const file = new File([blob], fname, { type: 'application/json' })
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: fname })
    } else {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fname
      a.click()
      URL.revokeObjectURL(url)
    }
    await setMeta('last_backup_at', new Date().toISOString())
    return true
  } catch {
    return false // cancelled
  }
}
