import { Component } from 'react'
import { t } from '../lib/i18n.js'

// A rendering error anywhere below would otherwise unmount the whole app and
// leave a blank white page - on a phone in the hall, with no way back but
// knowing to refresh. This shows a reload button instead; a phone that
// reloads rejoins as the same player.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('Screen failed to render', error, info?.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="center-screen">
        <div className="card login-card">
          <h1 className="brand">NGG Quiz</h1>
          <p className="muted" style={{ textAlign: 'center' }}>{t('משהו השתבש בטעינת המסך.')}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            {t('טעינה מחדש')}
          </button>
        </div>
      </div>
    )
  }
}
