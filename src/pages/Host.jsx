import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../supabaseClient'
import { playLink } from '../lib/links'
import Elapsed from '../components/Elapsed.jsx'
import Confetti from '../components/Confetti.jsx'
import { OPTION_SHAPES } from '../lib/optionStyle'

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
        supabase.from('quizzes').select('title, subtitle, logo_url').eq('id', s.quiz_id).single(),
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
    const { error } = await supabase.from('game_sessions').update({ status: 'reveal' }).eq('id', sessionId)
    if (error) {
      revealDone.current = null
      setError('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.')
    }
  }

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
        <div className="stage-inner" key="lobby">
          {quiz.logo_url && <img className="client-logo" src={quiz.logo_url} alt="לוגו הלקוח" />}
          <h1 className="stage-title">{quiz.title}</h1>
          {quiz.subtitle && <h2 className="stage-subtitle">{quiz.subtitle}</h2>}
          <div className="pin-banner big glow">
            קוד הצטרפות: <span className="pin">{session.pin}</span>
          </div>
          <p className="join-url" dir="ltr">{playLink(session.pin)}</p>
          {qr && <img className="qr-big" src={qr} alt="קוד QR להצטרפות" />}
          <h3>משתתפים ({players.length})</h3>
          <div className="player-chips">
            {players.map((p, i) => (
              <span className="chip pop" style={{ '--i': i % 12 }} key={p.id}>{p.nickname}</span>
            ))}
            {players.length === 0 && <span className="waiting-dots">ממתינים למצטרפים</span>}
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
        <div className="stage-inner" key={`q-${session.current_index}`}>
          <div className="question-meta">
            <span className="meta-pill">שאלה {session.current_index + 1} / {questions.length}</span>
            <Elapsed since={session.question_started_at} />
            <span className="meta-pill">ענו: {currentAnswers.length}/{players.length}</span>
          </div>
          <h1 className="stage-title">{currentQuestion.text}</h1>
          <div className="options-grid">
            {currentQuestion.options.map((opt, i) => (
              <div className={`option-tile color-${i}`} style={{ '--i': i }} key={i}>
                <span className="shape">{OPTION_SHAPES[i]}</span>
                <span>{opt}</span>
              </div>
            ))}
          </div>
          {isHost && (
            <button className="btn light xl" onClick={reveal}>
              חשיפת התשובה
            </button>
          )}
        </div>
      )}

      {session.status === 'reveal' && currentQuestion && (
        <div className="stage-inner" key={`r-${session.current_index}`}>
          <h1 className="stage-title">{currentQuestion.text}</h1>
          <div className="options-grid">
            {currentQuestion.options.map((opt, i) => {
              const count = currentAnswers.filter((a) => a.answer_index === i).length
              const max = Math.max(1, ...currentQuestion.options.map(
                (_, j) => currentAnswers.filter((a) => a.answer_index === j).length
              ))
              const correct = i === currentQuestion.correct_index
              return (
                <div className={`option-tile color-${i} ${correct ? 'correct' : 'dimmed'}`} style={{ '--i': i }} key={i}>
                  <span className="shape">{OPTION_SHAPES[i]}</span>
                  <span>{opt} {correct && '✓'}</span>
                  <div className="bar-track">
                    <div className="bar" style={{ width: `${(count / max) * 100}%` }} />
                  </div>
                  <span className="count">{count}</span>
                </div>
              )
            })}
          </div>
          {isHost && (
            <div className="row center-row">
              <button className="btn light xl" onClick={() => setStatus('leaderboard')}>
                טבלת המובילים
              </button>
              {isLast ? (
                <button className="btn primary xl" onClick={() => setStatus('finished')}>
                  לתוצאות הסופיות
                </button>
              ) : (
                <button className="btn primary xl" onClick={() => startQuestion(session.current_index + 1)}>
                  השאלה הבאה
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {session.status === 'leaderboard' && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">טבלת המובילים</h1>
          <ol className="leaderboard">
            {sorted.slice(0, 10).map((p, i) => (
              <li key={p.id} style={{ '--i': i }} className={i < 3 ? `top-${i + 1}` : ''}>
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
        <div className="stage-inner" key="finished">
          <Confetti />
          {quiz.logo_url && <img className="client-logo small" src={quiz.logo_url} alt="לוגו הלקוח" />}
          <h1 className="stage-title">🏆 {quiz.title}</h1>
          <h2 className="stage-subtitle">התוצאות הסופיות</h2>
          <div className="podium">
            {[1, 0, 2].map((rank) =>
              sorted[rank] ? (
                <div className={`podium-slot place-${rank + 1}`} key={sorted[rank].id}>
                  <div className="podium-medal">{['🥇', '🥈', '🥉'][rank]}</div>
                  <div className="podium-name">{sorted[rank].nickname}</div>
                  <div className="podium-block">
                    <div className="podium-rank">{rank + 1}</div>
                    <div className="podium-score">{sorted[rank].score}</div>
                  </div>
                </div>
              ) : null
            )}
          </div>
          {sorted.length > 3 && (
            <ol className="leaderboard compact">
              {sorted.slice(3, 10).map((p, i) => (
                <li key={p.id} style={{ '--i': i }}>
                  <span className="rank">{i + 4}</span>
                  <span className="name">{p.nickname}</span>
                  <span className="score">{p.score}</span>
                </li>
              ))}
            </ol>
          )}
          {isHost && (
            <button className="btn ghost light-ghost" onClick={() => navigate('/')}>חזרה לספרייה</button>
          )}
        </div>
      )}
    </div>
  )
}
