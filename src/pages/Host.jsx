import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../supabaseClient'
import { playLink } from '../lib/links'
import Countdown from '../components/Countdown.jsx'
import { OPTION_COLORS, OPTION_SHAPES } from '../lib/optionStyle'

export default function Host({ user }) {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [quiz, setQuiz] = useState(null)
  const [questions, setQuestions] = useState([])
  const [players, setPlayers] = useState([])
  const [answers, setAnswers] = useState([])
  const [qr, setQr] = useState('')
  const [error, setError] = useState('')
  const revealDone = useRef(null)

  const currentQuestion = useMemo(
    () => (session && session.current_index >= 0 ? questions[session.current_index] : null),
    [session, questions]
  )
  const isHost = session && user && session.host_id === user.id

  // initial load
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data: s, error: sErr } = await supabase
        .from('game_sessions')
        .select('*')
        .eq('id', sessionId)
        .single()
      if (cancelled) return
      if (sErr || !s) {
        setError('המפגש לא נמצא.')
        return
      }
      setSession(s)
      const [{ data: q }, { data: qs }, { data: ps }] = await Promise.all([
        supabase.from('quizzes').select('title, subtitle').eq('id', s.quiz_id).single(),
        supabase.from('questions').select('*').eq('quiz_id', s.quiz_id).order('position'),
        supabase.from('players').select('*').eq('session_id', sessionId).order('joined_at'),
      ])
      if (cancelled) return
      setQuiz(q)
      setQuestions(qs || [])
      setPlayers(ps || [])
      QRCode.toDataURL(playLink(s.pin), { width: 320, margin: 1 })
        .then((url) => { if (!cancelled) setQr(url) })
        .catch(() => {})
    }
    load()
    return () => { cancelled = true }
  }, [sessionId])

  // realtime subscriptions
  useEffect(() => {
    const channel = supabase
      .channel(`host-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
        (payload) => setSession(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` },
        (payload) => setPlayers((ps) => (ps.some((p) => p.id === payload.new.id) ? ps : [...ps, payload.new]))
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` },
        (payload) => setAnswers((as) => (as.some((a) => a.id === payload.new.id) ? as : [...as, payload.new]))
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [sessionId])

  // refresh scores + answers when the phase changes (scores are updated by a DB trigger)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    async function refresh() {
      if (['reveal', 'leaderboard', 'finished'].includes(session.status)) {
        const { data } = await supabase
          .from('players')
          .select('*')
          .eq('session_id', sessionId)
          .order('score', { ascending: false })
        if (!cancelled && data) setPlayers(data)
      }
      if (session.status === 'question' && currentQuestion) {
        const { data } = await supabase
          .from('answers')
          .select('*')
          .eq('session_id', sessionId)
          .eq('question_id', currentQuestion.id)
        if (!cancelled && data) {
          setAnswers((prev) => {
            const known = new Set(prev.map((a) => a.id))
            return [...prev, ...data.filter((a) => !known.has(a.id))]
          })
        }
      }
    }
    refresh()
    return () => { cancelled = true }
  }, [session?.status, session?.current_index]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentAnswers = useMemo(
    () => (currentQuestion ? answers.filter((a) => a.question_id === currentQuestion.id) : []),
    [answers, currentQuestion]
  )

  async function reveal() {
    if (!isHost || !currentQuestion || revealDone.current === currentQuestion.id) return
    revealDone.current = currentQuestion.id
    await supabase.from('game_sessions').update({ status: 'reveal' }).eq('id', sessionId)
  }

  // auto-reveal when everyone answered
  useEffect(() => {
    if (
      isHost &&
      session?.status === 'question' &&
      players.length > 0 &&
      currentAnswers.length >= players.length
    ) {
      reveal()
    }
  }, [currentAnswers.length, players.length, session?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function startQuestion(index) {
    const { error } = await supabase.rpc('start_question', { p_session: sessionId, p_index: index })
    if (error) setError('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.')
  }

  async function setStatus(status) {
    const { error } = await supabase.from('game_sessions').update({ status }).eq('id', sessionId)
    if (error) setError('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.')
  }

  if (error && !session) return <div className="center-screen"><div className="error-box">{error}</div></div>
  if (!session || !quiz) return <div className="center-screen"><div className="spinner" /></div>

  const isLast = session.current_index >= questions.length - 1
  const sorted = [...players].sort((a, b) => b.score - a.score)

  return (
    <div className="stage">
      {error && <div className="error-box floating">{error}</div>}

      {session.status === 'lobby' && (
        <div className="stage-inner">
          <h1 className="stage-title">{quiz.title}</h1>
          {quiz.subtitle && <h2 className="stage-subtitle">{quiz.subtitle}</h2>}
          <div className="pin-banner big">
            קוד הצטרפות: <span className="pin">{session.pin}</span>
          </div>
          <p className="join-url" dir="ltr">{playLink(session.pin)}</p>
          {qr && <img className="qr-big" src={qr} alt="קוד QR להצטרפות" />}
          <h3>משתתפים ({players.length})</h3>
          <div className="player-chips">
            {players.map((p) => <span className="chip" key={p.id}>{p.nickname}</span>)}
            {players.length === 0 && <span className="muted">ממתינים למצטרפים...</span>}
          </div>
          {isHost && (
            <button
              className="btn primary xl"
              disabled={players.length === 0}
              onClick={() => startQuestion(0)}
            >
              התחלת החידון
            </button>
          )}
        </div>
      )}

      {session.status === 'question' && currentQuestion && (
        <div className="stage-inner">
          <div className="question-meta">
            <span>שאלה {session.current_index + 1} מתוך {questions.length}</span>
            <Countdown
              startedAt={session.question_started_at}
              seconds={currentQuestion.time_limit}
              onDone={reveal}
            />
            <span>ענו: {currentAnswers.length}/{players.length}</span>
          </div>
          <h1 className="stage-title">{currentQuestion.text}</h1>
          <div className="options-grid">
            {currentQuestion.options.map((opt, i) => (
              <div className={`option-tile color-${i}`} key={i}>
                <span className="shape">{OPTION_SHAPES[i]}</span>
                <span>{opt}</span>
              </div>
            ))}
          </div>
          {isHost && (
            <button className="btn ghost" onClick={reveal}>חשיפת התשובה עכשיו</button>
          )}
        </div>
      )}

      {session.status === 'reveal' && currentQuestion && (
        <div className="stage-inner">
          <h1 className="stage-title">{currentQuestion.text}</h1>
          <div className="options-grid">
            {currentQuestion.options.map((opt, i) => {
              const count = currentAnswers.filter((a) => a.answer_index === i).length
              const max = Math.max(1, ...currentQuestion.options.map(
                (_, j) => currentAnswers.filter((a) => a.answer_index === j).length
              ))
              const correct = i === currentQuestion.correct_index
              return (
                <div className={`option-tile color-${i} ${correct ? 'correct' : 'dimmed'}`} key={i}>
                  <span className="shape">{OPTION_SHAPES[i]}</span>
                  <span>{opt} {correct && '✓'}</span>
                  <div className="bar-track">
                    <div className="bar" style={{ width: `${(count / max) * 100}%`, background: OPTION_COLORS[i] }} />
                  </div>
                  <span className="count">{count}</span>
                </div>
              )
            })}
          </div>
          {isHost && (
            <button className="btn primary xl" onClick={() => setStatus('leaderboard')}>
              טבלת המובילים
            </button>
          )}
        </div>
      )}

      {session.status === 'leaderboard' && (
        <div className="stage-inner">
          <h1 className="stage-title">טבלת המובילים</h1>
          <ol className="leaderboard">
            {sorted.slice(0, 10).map((p, i) => (
              <li key={p.id} className={i < 3 ? `top-${i + 1}` : ''}>
                <span className="rank">{i + 1}</span>
                <span className="name">{p.nickname}</span>
                <span className="score">{p.score}</span>
              </li>
            ))}
          </ol>
          {isHost && (
            isLast ? (
              <button className="btn primary xl" onClick={() => setStatus('finished')}>
                סיום החידון
              </button>
            ) : (
              <button className="btn primary xl" onClick={() => startQuestion(session.current_index + 1)}>
                השאלה הבאה
              </button>
            )
          )}
        </div>
      )}

      {session.status === 'finished' && (
        <div className="stage-inner">
          <h1 className="stage-title">🏆 {quiz.title} - תוצאות סופיות</h1>
          <div className="podium">
            {[1, 0, 2].map((rank) =>
              sorted[rank] ? (
                <div className={`podium-slot place-${rank + 1}`} key={sorted[rank].id}>
                  <div className="podium-name">{sorted[rank].nickname}</div>
                  <div className="podium-block">
                    <div className="podium-rank">{rank + 1}</div>
                    <div className="podium-score">{sorted[rank].score}</div>
                  </div>
                </div>
              ) : null
            )}
          </div>
          <ol className="leaderboard">
            {sorted.slice(3, 10).map((p, i) => (
              <li key={p.id}>
                <span className="rank">{i + 4}</span>
                <span className="name">{p.nickname}</span>
                <span className="score">{p.score}</span>
              </li>
            ))}
          </ol>
          {isHost && (
            <button className="btn ghost" onClick={() => navigate('/')}>חזרה לספרייה</button>
          )}
        </div>
      )}
    </div>
  )
}
