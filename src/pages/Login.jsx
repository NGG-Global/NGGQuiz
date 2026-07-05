import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'

export default function Login({ session }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setError('ההתחברות נכשלה. בדקו את כתובת הדוא"ל והסיסמה.')
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={handleSubmit}>
        <h1 className="brand">NGG Quiz</h1>
        <p className="muted">כניסת מנהלים למערכת החידונים</p>
        <label>
          דוא"ל
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            dir="ltr"
          />
        </label>
        <label>
          סיסמה
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            dir="ltr"
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'מתחבר...' : 'התחברות'}
        </button>
      </form>
    </div>
  )
}
