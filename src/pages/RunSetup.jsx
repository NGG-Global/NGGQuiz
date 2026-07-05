import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../supabaseClient'
import { hostLink, playLink } from '../lib/links'

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable - user can select manually */
    }
  }
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <input readOnly value={value} dir="ltr" onFocus={(e) => e.target.select()} />
      <button className="btn" onClick={copy}>{copied ? 'הועתק ✓' : 'העתקה'}</button>
    </div>
  )
}

export default function RunSetup() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [quiz, setQuiz] = useState(null)
  const [qr, setQr] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error } = await supabase
        .from('game_sessions')
        .select('id, pin, status, quiz_id, quizzes(title, subtitle)')
        .eq('id', sessionId)
        .single()
      if (cancelled) return
      if (error || !data) {
        setError('המפגש לא נמצא.')
        return
      }
      setSession(data)
      setQuiz(data.quizzes)
      QRCode.toDataURL(playLink(data.pin), { width: 240, margin: 1 })
        .then((url) => { if (!cancelled) setQr(url) })
        .catch(() => {})
    }
    load()
    return () => { cancelled = true }
  }, [sessionId])

  if (error) return <div className="center-screen"><div className="error-box">{error}</div></div>
  if (!session) return <div className="center-screen"><div className="spinner" /></div>

  return (
    <div className="page narrow">
      <header className="topbar">
        <h1 className="brand">NGG Quiz</h1>
        <button className="btn ghost" onClick={() => navigate('/')}>חזרה לספרייה</button>
      </header>

      <div className="card">
        <h2>{quiz?.title}</h2>
        {quiz?.subtitle && <p className="muted">{quiz.subtitle}</p>}
        <div className="pin-banner">
          קוד הצטרפות: <span className="pin">{session.pin}</span>
        </div>

        <h3>1. מסך מוקרן (מנחה)</h3>
        <p className="muted small">
          פתחו קישור זה במחשב המחובר למקרן. ניהול החידון (התחלה, מעבר בין שאלות)
          מתבצע מהמסך הזה, ולכן יש להיות מחוברים לחשבון האדמין באותו דפדפן.
        </p>
        <CopyField label="מסך מוקרן" value={hostLink(session.id)} />

        <h3>2. קישור למשתתפים</h3>
        <p className="muted small">
          שתפו את הקישור או את קוד ההצטרפות עם המשתתפים. אפשר גם לסרוק את קוד ה-QR
          שיוצג על המסך המוקרן.
        </p>
        <CopyField label="משתתפים" value={playLink(session.pin)} />

        {qr && (
          <div className="qr-wrap">
            <img src={qr} alt="קוד QR להצטרפות" />
          </div>
        )}

        <button className="btn primary wide" onClick={() => navigate(`/host/${session.id}`)}>
          פתיחת המסך המוקרן כאן
        </button>
      </div>
    </div>
  )
}
