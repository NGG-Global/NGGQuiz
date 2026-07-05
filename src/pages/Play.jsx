import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { OPTION_SHAPES } from '../lib/optionStyle'

function storageKey(pin) {
  return `nggquiz-player-${pin}`
}

export default function Play() {
  const { pin: pinParam } = useParams()

  const [pin, setPin] = useState(pinParam || '')
  const [nickname, setNickname] = useState('')
  const [session, setSession] = useState(null)
  const [player, setPlayer] = useState(null)
  const [questions, setQuestions] = useState([])
  const [myAnswers, setMyAnswers] = useState({}) // question_id -> {is_correct, points, answer_index}
  const [rankInfo, setRankInfo] = useState(null) // {rank, total, score}
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const answering = useRef(false)

  const currentQuestion = useMemo(
    () => (session && session.current_index >= 0 ? questions[session.current_index] : null),
    [session, questions]
  )
  const myAnswer = currentQuestion ? myAnswers[currentQuestion.id] : null

  // restore a previous join after refresh
  useEffect(() => {
    if (!pinParam) return
    const saved = sessionStorage.getItem(storageKey(pinParam))
    if (!saved) return
    const { playerId, sessionId } = JSON.parse(saved)
    let cancelled = false
    async function restore() {
      const [{ data: s }, { data: p }] = await Promise.all([
        supabase.from('game_sessions').select('*').eq('id', sessionId).single(),
        supabase.from('players').select('*').eq('id', playerId).single(),
      ])
      if (cancelled || !s || !p || s.status === 'finished') return
      setSession(s)
      setPlayer(p)
    }
    restore()
    return () => { cancelled = true }
  }, [pinParam])

  // load questions (without the correct answer) once we know the quiz
  useEffect(() => {
    if (!session?.quiz_id) return
    let cancelled = false
    supabase
      .from('questions')
      .select('id, text, options, position')
      .eq('quiz_id', session.quiz_id)
      .order('position')
      .then(({ data }) => { if (!cancelled && data) setQuestions(data) })
    return () => { cancelled = true }
  }, [session?.quiz_id])

  // follow the session state in realtime
  useEffect(() => {
    if (!session?.id) return
    const channel = supabase
      .channel(`play-${session.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${session.id}` },
        (payload) => setSession(payload.new)
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [session?.id])

  // pull my rank when scores are shown
  useEffect(() => {
    if (!session || !player) return
    if (!['leaderboard', 'finished', 'reveal'].includes(session.status)) return
    let cancelled = false
    supabase
      .from('players')
      .select('id, score')
      .eq('session_id', session.id)
      .order('score', { ascending: false })
      .then(({ data }) => {
        if (cancelled || !data) return
        const idx = data.findIndex((p) => p.id === player.id)
        if (idx >= 0) setRankInfo({ rank: idx + 1, total: data.length, score: data[idx].score })
      })
    return () => { cancelled = true }
  }, [session?.status, session?.id, player]) // eslint-disable-line react-hooks/exhaustive-deps

  async function join(e) {
    e.preventDefault()
    setError('')
    const cleanPin = pin.trim()
    const cleanNick = nickname.trim()
    if (!cleanPin || !cleanNick) return
    setBusy(true)

    const { data: s, error: sErr } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('pin', cleanPin)
      .neq('status', 'finished')
      .maybeSingle()
    if (sErr || !s) {
      setError('לא נמצא חידון פעיל עם הקוד הזה.')
      setBusy(false)
      return
    }

    const { data: p, error: pErr } = await supabase
      .from('players')
      .insert({ session_id: s.id, nickname: cleanNick })
      .select()
      .single()
    setBusy(false)
    if (pErr) {
      setError(pErr.code === '23505' ? 'הכינוי הזה כבר תפוס במשחק. בחרו כינוי אחר.' : 'ההצטרפות נכשלה. נסו שוב.')
      return
    }
    sessionStorage.setItem(storageKey(cleanPin), JSON.stringify({ playerId: p.id, sessionId: s.id }))
    setSession(s)
    setPlayer(p)
  }

  async function answer(index) {
    if (!currentQuestion || myAnswer || answering.current) return
    answering.current = true
    const { data, error } = await supabase
      .from('answers')
      .insert({
        session_id: session.id,
        question_id: currentQuestion.id,
        player_id: player.id,
        answer_index: index,
      })
      .select('is_correct, points, answer_index')
      .single()
    answering.current = false
    if (!error && data) {
      setMyAnswers((m) => ({ ...m, [currentQuestion.id]: data }))
    } else if (error?.code === '23505') {
      setMyAnswers((m) => ({ ...m, [currentQuestion.id]: { pending: true } }))
    }
  }

  // ---- render ----

  if (!player) {
    return (
      <div className="center-screen">
        <form className="card login-card" onSubmit={join}>
          <h1 className="brand">NGG Quiz</h1>
          <p className="muted">הצטרפות לחידון</p>
          <label>
            קוד הצטרפות
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              maxLength={6}
              required
              dir="ltr"
              style={{ textAlign: 'center', letterSpacing: '0.3em', fontSize: '1.4rem' }}
            />
          </label>
          <label>
            כינוי
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
          </label>
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'מצטרף...' : 'הצטרפות'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="stage player-stage">
      <div className="player-topbar">
        <span className="chip">{player.nickname}</span>
        {rankInfo && <span className="chip">{rankInfo.score} נק'</span>}
      </div>

      {session.status === 'lobby' && (
        <div className="stage-inner">
          <h1 className="stage-title">אתם בפנים! 🎉</h1>
          <p className="stage-subtitle">חכו שהמנחה יתחיל את החידון. שימו לב למסך המוקרן.</p>
        </div>
      )}

      {session.status === 'question' && currentQuestion && (
        <div className="stage-inner full" key={`q-${session.current_index}`}>
          <div className="question-meta">
            <span className="meta-pill">שאלה {session.current_index + 1}</span>
          </div>
          {myAnswer ? (
            <div className="wait-note">
              <h1 className="stage-title">התשובה נקלטה ✓</h1>
              <p className="stage-subtitle">ממתינים לשאר המשתתפים...</p>
            </div>
          ) : (
            <>
              <h2 className="player-question">{currentQuestion.text}</h2>
              <div className="options-grid player">
                {currentQuestion.options.map((opt, i) => (
                  <button className={`option-tile clickable color-${i}`} style={{ '--i': i }} key={i} onClick={() => answer(i)}>
                    <span className="shape">{OPTION_SHAPES[i]}</span>
                    <span>{opt}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {session.status === 'reveal' && (
        <div className="stage-inner" key={`r-${session.current_index}`}>
          {!myAnswer || myAnswer.pending ? (
            <h1 className="stage-title">לא נקלטה תשובה הפעם 😅</h1>
          ) : myAnswer.is_correct ? (
            <>
              <h1 className="stage-title correct-text">נכון! 🎉</h1>
              <p className="points-pop">+{myAnswer.points} נקודות</p>
            </>
          ) : (
            <h1 className="stage-title wrong-text">לא נכון הפעם 💪</h1>
          )}
          {rankInfo && <p className="stage-subtitle">מקום {rankInfo.rank} מתוך {rankInfo.total}</p>}
        </div>
      )}

      {session.status === 'leaderboard' && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">המצב שלך</h1>
          {rankInfo && (
            <>
              <p className="points-pop">{rankInfo.score} נקודות</p>
              <p className="stage-subtitle">מקום {rankInfo.rank} מתוך {rankInfo.total}</p>
            </>
          )}
        </div>
      )}

      {session.status === 'finished' && (
        <div className="stage-inner">
          <h1 className="stage-title">זהו, נגמר! 🏁</h1>
          {rankInfo && (
            <>
              <p className="points-pop">{rankInfo.score} נקודות</p>
              <p className="stage-subtitle">
                {rankInfo.rank === 1 ? 'מקום ראשון - כל הכבוד! 🏆' : `סיימתם במקום ${rankInfo.rank} מתוך ${rankInfo.total}`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
