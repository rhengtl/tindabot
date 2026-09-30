import { useApp } from '../../state/store'
import { useWrite } from '../components'
import { useStrings } from '../i18n'

// While the demo is the current store: the way to the person's own store. That is their real store
// on this phone when there is one, otherwise onboarding. Nothing is deleted; the demo stays as it was.
export function DemoExit({ hint = false }: { hint?: boolean }) {
  const S = useStrings()
  const write = useWrite()
  const demo = useApp((s) => s.demo)
  const exit = useApp((s) => s.demoExit)
  const leaveDemo = useApp((s) => s.leaveDemo)
  if (!demo) return null
  return (
    <div className="card soft" data-testid="demo-exit">
      <div className="bold">{S.demoExit.note}</div>
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{S.demoExit.hint}</div>}
      <button type="button" className="btn primary" style={{ marginTop: 10 }} data-testid="demo-exit-btn" onClick={() => write(() => leaveDemo())}>
        {exit ? S.demoExit.back(exit.name) : S.demoExit.start}
      </button>
    </div>
  )
}
