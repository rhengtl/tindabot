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
