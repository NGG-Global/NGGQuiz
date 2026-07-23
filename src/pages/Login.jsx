import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useI18n } from '../lib/i18n.js'
import LanguageToggle from '../components/LanguageToggle.jsx'

const ADMIN_DOMAIN = '@nggconsult.com'

export default function Login({ session }) {
  const { t } = useI18n()
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
        setError(t('ההרשמה פתוחה רק לכתובות ארגוניות ({domain}).', { domain: ADMIN_DOMAIN }))
        return
      }
      if (password.length < 8) {
        setError(t('הסיסמה חייבת להכיל לפחות 8 תווים.'))
        return
      }
      setBusy(true)
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
      setBusy(false)
      if (error) {
        setError(
          error.message?.includes('nggconsult')
            ? t('ההרשמה פתוחה רק לכתובות ארגוניות ({domain}).', { domain: ADMIN_DOMAIN })
            : t('ההרשמה נכשלה. ייתכן שהחשבון כבר קיים - נסו להתחבר.')
        )
        return
      }
      if (data.session) {
        navigate('/', { replace: true })
      } else {
        setNotice(t('נשלח אליכם מייל לאימות החשבון. לאחר האישור ניתן להתחבר.'))
        setMode('signin')
      }
      return
    }

    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) {
      setError(t('ההתחברות נכשלה. בדקו את כתובת הדוא"ל והסיסמה.'))
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={handleSubmit}>
        <h1 className="brand">NGG Quiz</h1>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><LanguageToggle /></div>
        <p className="muted">{t('כניסת מנהלים למערכת החידונים')}</p>

        <div className="mode-tabs">
          <button
            type="button"
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => { setMode('signin'); setError(''); setNotice('') }}
          >
            {t('התחברות')}
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => { setMode('signup'); setError(''); setNotice('') }}
          >
            {t('הרשמה')}
          </button>
        </div>

        <label>
          {t('דוא"ל ארגוני')}
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
          {t('סיסמה')}
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
            {t('ההרשמה פתוחה לבעלי כתובת {domain} בלבד. משתתפים בחידונים אינם זקוקים לחשבון - הם מצטרפים עם קוד בלבד.', { domain: ADMIN_DOMAIN })}
          </p>
        )}

        {error && <div className="error-box">{error}</div>}
        {notice && <div className="notice-box">{notice}</div>}

        <button className="btn primary" disabled={busy}>
          {busy ? t('רק רגע...') : mode === 'signup' ? t('יצירת חשבון') : t('התחברות')}
        </button>
      </form>
    </div>
  )
}
