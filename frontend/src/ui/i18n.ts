// Language access for components. The preference itself lives in the app store (`lang`, persisted
// in Dexie meta under `META_LANG`); subscribing through the store is what makes every screen
// re-render the moment the language changes.
import type { Lang } from '../domain'
import { useApp } from '../state/store'
import { type Strings, strings } from './strings'

export function useLang(): Lang {
  return useApp((s) => s.lang)
}

/** The current language's strings; re-renders the caller when the language changes. */
export function useStrings(): Strings {
  return strings(useApp((s) => s.lang))
}
