// One place where a local write is attempted and reported.
//
// Every screen already awaits its write before saying "Naitala"/"Na-save", so a failure has never
// been announced as a success. What a failure did do was say nothing at all: the sheet stayed open
// and the person was left guessing. `guardedWrite` makes that case speak — a short toast in their
// language — while the browser's own exception (DatabaseClosedError, quota, a revoked database)
// goes to the console, where whoever is debugging can find it.
//
// It returns whether the write happened, so a caller's success path is skipped on failure:
//   if (!(await write(() => recordCount(...)))) return
//   toast(S.common.recordedToast(...))

export async function guardedWrite(write: () => Promise<unknown>, onFail: () => void): Promise<boolean> {
  try {
    await write()
    return true
  } catch (e) {
    // Never shown to the person: the toast is the message, this is the diagnosis.
    console.error('[tindabot] local write failed:', e)
    onFail()
    return false
  }
}

/**
 * Which import message a failure should get. `store not found` / `different_store` is not a failure
 * at all — it is the question about replacing the store — so the caller checks for that first and
 * everything else falls back to "could not be imported": a file the app cannot read and a device
 * that would not finish the write are the same thing to the person holding the phone.
 */
export type ImportFailureKind = 'not_export_file' | 'different_store' | 'failed'

export function importFailureKind(e: unknown): ImportFailureKind {
  const message = e instanceof Error ? e.message : ''
  return message === 'not_export_file' || message === 'different_store' ? message : 'failed'
}
