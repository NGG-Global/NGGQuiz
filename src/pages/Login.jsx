import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'

const ADMIN_DOMAIN = '@nggconsult.com'

export default function Login({ session }) {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')

    if (mode === 'signup') {
      if (!email.trim().toLowerCase().endsWith(ADMIN_DOMAIN)) {
        setError(`ההרשמה פתוחה רק לכתובות ארגוניות (${ADMIN_DOMAIN}).`)
        return
      }
      if (password.length < 8) {
        setError('הסיסמה חייבת להכיל לפחות 8 תווים.')
        return
      }
      setBusy(true)
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
      setBusy(false)
      if (error) {
        setError(
          error.message?.includes('nggconsult')
            ? `ההרשמה פתוחה רק לכתובות ארגוניות (${ADMIN_DOMAIN}).`
            : 'ההרשמה נכשלה. ייתכן שהחשבון כבר קיים - נסו להתחבר.'
        )
        return
      }
      if (data.session) {
        navigate('/', { replace: true })
      } else {
        setNotice('נשלח אליכם מייל לאימות החשבון. לאחר האישור ניתן להתחבר.')
        setMode('signin')
      }
      return
    }

    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
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

        <div className="mode-tabs">
          <button
            type="button"
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => { setMode('signin'); setError(''); setNotice('') }}
          >
            התחברות
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => { setMode('signup'); setError(''); setNotice('') }}
          >
            הרשמה
          </button>
        </div>

        <label>
          דוא"ל ארגוני
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={`name${ADMIN_DOMAIN}`}
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
            minLength={mode === 'signup' ? 8 : undefined}
            dir="ltr"
          />
        </label>

        {mode === 'signup' && (
          <p className="muted small">
            ההרשמה פתוחה לבעלי כתובת {ADMIN_DOMAIN} בלבד. משתתפים בחידונים אינם
            זקוקים לחשבון - הם מצטרפים עם קוד בלבד.
          </p>
        )}

        {error && <div className="error-box">{error}</div>}
        {notice && <div className="notice-box">{notice}</div>}

        <button className="btn primary" disabled={busy}>
          {busy ? 'רק רגע...' : mode === 'signup' ? 'יצירת חשבון' : 'התחברות'}
        </button>
      </form>
    </div>
  )
}
