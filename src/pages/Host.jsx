import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../supabaseClient'
import { playLink } from '../lib/links'
import Elapsed from '../components/Elapsed.jsx'
import Confetti from '../components/Confetti.jsx'
import WordCloud from '../components/WordCloud.jsx'
import { OPTION_SHAPES } from '../lib/optionStyle'
import { TEAM_COLORS, kendallSimilarity } from '../lib/questionTypes'
import { useI18n } from '../lib/i18n.js'

export default function Host({ user }) {
  const { t } = useI18n()
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
  const teamsOn = quiz?.teams_enabled && quiz?.teams?.length

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
        setError(t('המפגש לא נמצא.'))
        return
      }
      setSession(s)
      const [{ data: q }, { data: qs }, { data: ps }] = await Promise.all([
        supabase.from('quizzes').select('*').eq('id', s.quiz_id).single(),
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
      if (['question', 'reveal'].includes(session.status) && currentQuestion) {
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

  const teamTotals = useMemo(() => {
    if (!teamsOn) return []
    const totals = quiz.teams.map((name, i) => ({
      name,
      color: TEAM_COLORS[i % TEAM_COLORS.length],
      score: 0,
      members: 0,
    }))
    players.forEach((p) => {
      const t = totals.find((x) => x.name === p.team)
      if (t) {
        t.score += p.score
        t.members += 1
      }
    })
    return [...totals].sort((a, b) => b.score - a.score)
  }, [teamsOn, quiz?.teams, players])

  async function reveal() {
    if (!isHost || !currentQuestion || revealDone.current === currentQuestion.id) return
    revealDone.current = currentQuestion.id
    const { error } = await supabase.from('game_sessions').update({ status: 'reveal' }).eq('id', sessionId)
    if (error) {
      revealDone.current = null
      setError(t('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.'))
    }
  }

  async function startQuestion(index) {
    const { error } = await supabase.rpc('start_question', { p_session: sessionId, p_index: index })
    if (error) setError(t('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.'))
  }

  async function setStatus(status) {
    const { error } = await supabase.from('game_sessions').update({ status }).eq('id', sessionId)
    if (error) setError(t('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.'))
  }

  if (error && !session) return <div className="center-screen"><div className="error-box">{error}</div></div>
  if (!session || !quiz) return <div className="center-screen"><div className="spinner" /></div>

  const isLast = session.current_index >= questions.length - 1
  const sorted = [...players].sort((a, b) => b.score - a.score)
  const cloudTexts = currentAnswers.map((a) => a.answer?.text).filter(Boolean)

  const neutralOrder = currentQuestion?.qtype === 'ranking'
    ? [...(currentQuestion.options || [])].sort((a, b) => String(a).localeCompare(String(b), 'he'))
    : []

  const rankingAvgAccuracy = (() => {
    if (currentQuestion?.qtype !== 'ranking') return null
    const sims = currentAnswers
      .map((a) => a.answer?.order)
      .filter(Array.isArray)
      .map(kendallSimilarity)
    if (!sims.length) return null
    return Math.round((sims.reduce((s, x) => s + x, 0) / sims.length) * 100)
  })()

  function nextButtons() {
    if (!isHost) return null
    return (
      <div className="row center-row">
        <button className="btn light xl" onClick={() => setStatus('leaderboard')}>
          {t('טבלת המובילים')}
        </button>
        {isLast ? (
          <button className="btn primary xl" onClick={() => setStatus('finished')}>
            {t('לתוצאות הסופיות')}
          </button>
        ) : (
          <button className="btn primary xl" onClick={() => startQuestion(session.current_index + 1)}>
            {t('השאלה הבאה')}
          </button>
        )}
      </div>
    )
  }

  function teamScoreBoard() {
    if (!teamsOn) return null
    const max = Math.max(1, ...teamTotals.map((t) => t.score))
    return (
      <div className="team-scores">
        {teamTotals.map((t, i) => (
          <div className="team-row" style={{ '--i': i }} key={t.name}>
            <span className="dot big" style={{ background: t.color }} />
            <span className="name">{t.name}</span>
            <div className="team-bar">
              <div style={{ width: `${(t.score / max) * 100}%`, background: t.color }} />
            </div>
            <span className="score">{t.score}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="stage">
      {error && <div className="error-box floating">{error}</div>}

      {session.status === 'lobby' && (
        <div className="stage-inner" key="lobby">
          {quiz.logo_url && <img className="client-logo" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
          <h1 className="stage-title">{quiz.title}</h1>
          {quiz.subtitle && <h2 className="stage-subtitle">{quiz.subtitle}</h2>}
          <div className="pin-banner big glow">
            {t('קוד הצטרפות:')} <span className="pin">{session.pin}</span>
          </div>
          <p className="join-url" dir="ltr">{playLink(session.pin)}</p>
          {qr && <img className="qr-big" src={qr} alt={t('קוד QR להצטרפות')} />}
          <h3>{t('משתתפים ({count})', { count: players.length })}</h3>
          {teamsOn ? (
            <div className="team-lobby">
              {quiz.teams.map((t, ti) => {
                const members = players.filter((p) => p.team === t)
                const color = TEAM_COLORS[ti % TEAM_COLORS.length]
                return (
                  <div className="team-group" key={t} style={{ borderColor: `${color}88` }}>
                    <div className="team-group-head" style={{ color }}>
                      <span className="dot big" style={{ background: color }} /> {t} ({members.length})
                    </div>
                    <div className="player-chips">
                      {members.map((p, i) => (
                        <span className="chip pop" style={{ '--i': i % 12 }} key={p.id}>{p.nickname}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="player-chips">
              {players.map((p, i) => (
                <span className="chip pop" style={{ '--i': i % 12 }} key={p.id}>{p.nickname}</span>
              ))}
              {players.length === 0 && <span className="waiting-dots">{t('ממתינים למצטרפים')}</span>}
            </div>
          )}
          {isHost && (
            <button
              className="btn primary xl"
              disabled={players.length === 0}
              onClick={() => startQuestion(0)}
            >
              {t('התחלת החידון')}
            </button>
          )}
        </div>
      )}

      {session.status === 'question' && currentQuestion && (
        <div className="stage-inner" key={`q-${session.current_index}`}>
          <div className="question-meta">
            <span className="meta-pill">{t('שאלה {number} / {total}', { number: session.current_index + 1, total: questions.length })}</span>
            <Elapsed since={session.question_started_at} />
            <span className="meta-pill">{t('ענו: {answered}/{total}', { answered: currentAnswers.length, total: players.length })}</span>
          </div>
          <h1 className="stage-title">{currentQuestion.text}</h1>

          {(currentQuestion.qtype === 'multiple_choice' || currentQuestion.qtype === 'poll') && (
            <div className="options-grid">
              {currentQuestion.options.map((opt, i) => (
                <div className={`option-tile color-${i}`} style={{ '--i': i }} key={i}>
                  <span className="shape">{OPTION_SHAPES[i]}</span>
                  <span>{opt}</span>
                </div>
              ))}
            </div>
          )}

          {currentQuestion.qtype === 'word_cloud' && (
            <>
              <p className="stage-subtitle">{t('☁️ ענו מהטלפון - הענן נבנה בזמן אמת')}</p>
              <WordCloud texts={cloudTexts} />
            </>
          )}

          {currentQuestion.qtype === 'ranking' && (
            <>
              <p className="stage-subtitle">{t('🔢 סדרו את הפריטים בסדר הנכון במכשיר שלכם')}</p>
              <div className="rank-board">
                {neutralOrder.map((item, i) => (
                  <div className="rank-item neutral" style={{ '--i': i }} key={item}>
                    <span className="rank-text">{item}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {currentQuestion.qtype === 'hotspot' && (
            <>
              <p className="stage-subtitle">{t('🎯 הקישו על המיקום הנכון במכשיר שלכם')}</p>
              <div className="hotspot-frame stage-image">
                <img src={currentQuestion.meta?.image_url} alt={t('תמונת השאלה')} draggable={false} />
              </div>
            </>
          )}

          {isHost && (
            <button className="btn light xl" onClick={reveal}>
              {t('חשיפת התשובה')}
            </button>
          )}
        </div>
      )}

      {session.status === 'reveal' && currentQuestion && (
        <div className="stage-inner" key={`r-${session.current_index}`}>
          <h1 className="stage-title">{currentQuestion.text}</h1>

          {(currentQuestion.qtype === 'multiple_choice' || currentQuestion.qtype === 'poll') && (
            <div className="options-grid">
              {currentQuestion.options.map((opt, i) => {
                const count = currentAnswers.filter((a) => a.answer_index === i).length
                const max = Math.max(1, ...currentQuestion.options.map(
                  (_, j) => currentAnswers.filter((a) => a.answer_index === j).length
                ))
                const isPoll = currentQuestion.qtype === 'poll'
                const correct = !isPoll && i === currentQuestion.correct_index
                return (
                  <div
                    className={`option-tile color-${i} ${isPoll ? '' : correct ? 'correct' : 'dimmed'}`}
                    style={{ '--i': i }}
                    key={i}
                  >
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
          )}

          {currentQuestion.qtype === 'word_cloud' && <WordCloud texts={cloudTexts} />}

          {currentQuestion.qtype === 'ranking' && (
            <>
              <p className="stage-subtitle">{t('הסדר הנכון:')}</p>
              <div className="rank-board">
                {(currentQuestion.options || []).map((item, i) => (
                  <div className="rank-item revealed" style={{ '--i': i }} key={item}>
                    <span className="rank-num">{i + 1}</span>
                    <span className="rank-text">{item}</span>
                  </div>
                ))}
              </div>
              {rankingAvgAccuracy != null && (
                <p className="stage-subtitle">{t('🎯 דיוק ממוצע: {percent}%', { percent: rankingAvgAccuracy })}</p>
              )}
            </>
          )}

          {currentQuestion.qtype === 'hotspot' && (
            <div className="hotspot-frame stage-image">
              <img src={currentQuestion.meta?.image_url} alt={t('תמונת השאלה')} draggable={false} />
              {currentAnswers.map((a) =>
                a.answer?.x != null ? (
                  <span
                    key={a.id}
                    className="hotspot-marker guess"
                    style={{ left: `${a.answer.x}%`, top: `${a.answer.y}%` }}
                  />
                ) : null
              )}
              <span
                className="hotspot-marker target pulse"
                style={{ left: `${currentQuestion.meta?.x}%`, top: `${currentQuestion.meta?.y}%` }}
              />
            </div>
          )}

          {currentQuestion.explanation && (
            <div className="explain-box">💡 {currentQuestion.explanation}</div>
          )}
          {nextButtons()}
        </div>
      )}

      {session.status === 'leaderboard' && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">{teamsOn ? t('מצב הקבוצות') : t('טבלת המובילים')}</h1>
          {teamScoreBoard()}
          <ol className="leaderboard">
            {sorted.slice(0, teamsOn ? 5 : 10).map((p, i) => (
              <li key={p.id} style={{ '--i': i }} className={i < 3 ? `top-${i + 1}` : ''}>
                <span className="rank">{i + 1}</span>
                <span className="name">{p.nickname}{p.team ? ` · ${p.team}` : ''}</span>
                <span className="score">{p.score}</span>
              </li>
            ))}
          </ol>
          {isHost && (
            isLast ? (
              <button className="btn primary xl" onClick={() => setStatus('finished')}>
                {t('סיום החידון')}
              </button>
            ) : (
              <button className="btn primary xl" onClick={() => startQuestion(session.current_index + 1)}>
                {t('השאלה הבאה')}
              </button>
            )
          )}
        </div>
      )}

      {session.status === 'finished' && (
        <div className="stage-inner" key="finished">
          <Confetti />
          {quiz.logo_url && <img className="client-logo small" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
          <h1 className="stage-title">🏆 {quiz.title}</h1>
          <h2 className="stage-subtitle">{t('התוצאות הסופיות')}</h2>

          {teamsOn ? (
            <>
              <div className="podium">
                {[1, 0, 2].map((rank) =>
                  teamTotals[rank] ? (
                    <div className={`podium-slot place-${rank + 1}`} key={teamTotals[rank].name}>
                      <div className="podium-medal">{['🥇', '🥈', '🥉'][rank]}</div>
                      <div className="podium-name">
                        <span className="dot big" style={{ background: teamTotals[rank].color }} />{' '}
                        {teamTotals[rank].name}
                      </div>
                      <div className="podium-block">
                        <div className="podium-rank">{rank + 1}</div>
                        <div className="podium-score">{teamTotals[rank].score}</div>
                      </div>
                    </div>
                  ) : null
                )}
              </div>
              {teamTotals.length > 3 && teamScoreBoard()}
              <p className="stage-subtitle">{t('המצטיינים האישיים:')}</p>
              <ol className="leaderboard compact">
                {sorted.slice(0, 5).map((p, i) => (
                  <li key={p.id} style={{ '--i': i }}>
                    <span className="rank">{i + 1}</span>
                    <span className="name">{p.nickname}{p.team ? ` · ${p.team}` : ''}</span>
                    <span className="score">{p.score}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
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
            </>
          )}

          {isHost && (
            <button className="btn ghost light-ghost" onClick={() => navigate('/')}>{t('חזרה לספרייה')}</button>
          )}
        </div>
      )}
    </div>
  )
}
