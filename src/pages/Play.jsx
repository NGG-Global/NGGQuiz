import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { OPTION_SHAPES } from '../lib/optionStyle'
import { TEAM_COLORS, teamColor, shuffled } from '../lib/questionTypes'
import { useI18n } from '../lib/i18n.js'
import LanguageToggle from '../components/LanguageToggle.jsx'

function storageKey(pin) {
  return `nggquiz-player-${pin}`
}

export default function Play() {
  const { t } = useI18n()
  const { pin: pinParam } = useParams()

  const [pin, setPin] = useState(pinParam || '')
  const [nickname, setNickname] = useState('')
  const [session, setSession] = useState(null)
  const [quiz, setQuiz] = useState(null)
  const [player, setPlayer] = useState(null)
  const [pendingJoin, setPendingJoin] = useState(null) // {session, quiz, nickname} waiting for team pick
  const [questions, setQuestions] = useState([])
  const [myAnswers, setMyAnswers] = useState({}) // question_id -> result row
  const [rankInfo, setRankInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const answering = useRef(false)

  // per-question input state
  const [cloudText, setCloudText] = useState('')
  const [rankOrder, setRankOrder] = useState([]) // original indices in chosen order
  const [tapPos, setTapPos] = useState(null)

  const currentQuestion = useMemo(
    () => (session && session.current_index >= 0 ? questions[session.current_index] : null),
    [session, questions]
  )
  const myAnswer = currentQuestion ? myAnswers[currentQuestion.id] : null

  // restore a previous join after refresh
  useEffect(() => {
    if (!pinParam) return
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey(pinParam)) || 'null')
    } catch {
      saved = null // corrupted entry - fall back to the join screen
    }
    if (!saved?.playerId || !saved?.sessionId) return
    const { playerId, sessionId } = saved
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

  // load quiz info + questions once the session is known.
  // This must not fail silently: without the questions the player sees an
  // empty screen for the rest of the game, so a failed fetch is retried
  // with backoff and surfaced only if every attempt fails.
  useEffect(() => {
    if (!session?.quiz_id) return
    const quizId = session.quiz_id
    let cancelled = false
    let timer = null

    async function load(attempt = 0) {
      const [{ data: qz }, { data: qs }] = await Promise.all([
        supabase.from('quizzes').select('teams_enabled, team_mode, teams, title').eq('id', quizId).single(),
        supabase
          .from('questions')
          .select('id, qtype, text, options, meta, position, explanation')
          .eq('quiz_id', quizId)
          .order('position'),
      ])
      if (cancelled) return
      if (qz) setQuiz(qz)
      if (qs?.length) {
        setQuestions(qs)
        setLoadFailed(false)
        return
      }
      // the request failed, or came back without questions - retry with
      // backoff, and give the player a retry button once we give up, so
      // nobody is left staring at an empty screen
      if (attempt >= 4) {
        setLoadFailed(true)
        return
      }
      timer = setTimeout(() => load(attempt + 1), 1000 * 2 ** attempt)
    }

    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [session?.quiz_id, reloadToken])

  // restore my answers for this session (a refresh mid-game would
  // otherwise let the player answer again - which the unique constraint
  // rejects - and show "no answer received" on the reveal screen)
  useEffect(() => {
    if (!session?.id || !player?.id) return
    let cancelled = false
    supabase
      .from('answers')
      .select('question_id, is_correct, points, answer_index, answer')
      .eq('session_id', session.id)
      .eq('player_id', player.id)
      .then(({ data }) => {
        if (cancelled || !data?.length) return
        setMyAnswers((m) => {
          const next = { ...m }
          data.forEach((a) => {
            // never overwrite a locally known result with a stale row
            if (!next[a.question_id] || next[a.question_id].pending) next[a.question_id] = a
          })
          return next
        })
      })
    return () => { cancelled = true }
  }, [session?.id, player?.id])

  // follow the session state in realtime, with a resync safety net:
  // realtime updates are lost while the phone is locked, the tab is in
  // the background or the network blips, and missed events are never
  // replayed - so we also refetch on (re)connect and on wake, and keep
  // a slow poll running as a last resort
  useEffect(() => {
    if (!session?.id) return
    const sessionId = session.id
    let cancelled = false

    async function sync() {
      const { data } = await supabase
        .from('game_sessions')
        .select('*')
        .eq('id', sessionId)
        .single()
      if (cancelled || !data) return
      setSession((prev) =>
        prev &&
        prev.status === data.status &&
        prev.current_index === data.current_index &&
        prev.question_started_at === data.question_started_at
          ? prev
          : data
      )
    }

    const channel = supabase
      .channel(`play-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
        (payload) => setSession(payload.new)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') sync()
      })

    const onWake = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    const poll = setInterval(sync, 5000)

    return () => {
      cancelled = true
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
      supabase.removeChannel(channel)
    }
  }, [session?.id])

  // reset per-question input state when a new question starts
  useEffect(() => {
    if (!currentQuestion) return
    answering.current = false // a submit that hung on the previous question must not block this one
    setError('')
    setCloudText('')
    setTapPos(null)
    if (currentQuestion.qtype === 'ranking') {
      setRankOrder(shuffled(currentQuestion.options?.length || 0))
    }
  }, [currentQuestion?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // pull my rank when scores are shown
  useEffect(() => {
    if (!session || !player) return
    if (!['leaderboard', 'finished', 'reveal'].includes(session.status)) return
    let cancelled = false
    supabase
      .from('players')
      .select('id, score, team')
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
    if (sErr) {
      // a failed request is not a wrong PIN - saying so sends the player
      // hunting for a code that was correct all along
      setError(t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'))
      setBusy(false)
      return
    }
    if (!s) {
      setError(t('לא נמצא חידון פעיל עם הקוד הזה.'))
      setBusy(false)
      return
    }

    const { data: qz } = await supabase
      .from('quizzes')
      .select('teams_enabled, team_mode, teams, title')
      .eq('id', s.quiz_id)
      .single()

    if (qz?.teams_enabled && qz.team_mode === 'manual' && qz.teams?.length) {
      // let the player pick a team before registering
      setPendingJoin({ session: s, quiz: qz, nickname: cleanNick, pin: cleanPin })
      setBusy(false)
      return
    }

    let team = null
    if (qz?.teams_enabled && qz.teams?.length) {
      team = await pickBalancedTeam(s.id, qz.teams)
    }
    await registerPlayer(s, qz, cleanNick, cleanPin, team)
  }

  async function pickBalancedTeam(sessionId, teams) {
    const { data } = await supabase.from('players').select('team').eq('session_id', sessionId)
    const counts = Object.fromEntries(teams.map((t) => [t, 0]))
    ;(data || []).forEach((p) => {
      if (p.team in counts) counts[p.team] += 1
    })
    const min = Math.min(...teams.map((t) => counts[t]))
    const candidates = teams.filter((t) => counts[t] === min)
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  async function registerPlayer(s, qz, cleanNick, cleanPin, team) {
    setBusy(true)
    const { data: p, error: pErr } = await supabase
      .from('players')
      .insert({ session_id: s.id, nickname: cleanNick, team })
      .select()
      .single()
    setBusy(false)
    if (pErr) {
      setError(pErr.code === '23505' ? t('הכינוי הזה כבר תפוס במשחק. בחרו כינוי אחר.') : t('ההצטרפות נכשלה. נסו שוב.'))
      setPendingJoin(null)
      return
    }
    sessionStorage.setItem(storageKey(cleanPin), JSON.stringify({ playerId: p.id, sessionId: s.id }))
    setSession(s)
    setQuiz(qz)
    setPlayer(p)
    setPendingJoin(null)
  }

  async function submitAnswer(payload) {
    if (!currentQuestion || myAnswer || answering.current) return
    answering.current = true
    setError('')
    const questionId = currentQuestion.id
    try {
      let request = supabase
        .from('answers')
        .insert({
          session_id: session.id,
          question_id: questionId,
          player_id: player.id,
          ...payload,
        })
        .select('is_correct, points, answer_index, answer')
        .single()
      // don't let a request that hangs on a flaky mobile network keep the player stuck
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        request = request.abortSignal(AbortSignal.timeout(10000))
      }
      const { data, error: insertError } = await request
      if (!insertError && data) {
        setMyAnswers((m) => ({ ...m, [questionId]: data }))
      } else if (insertError?.code === '23505') {
        // an earlier attempt did land - mark it so the player moves on
        setMyAnswers((m) => ({ ...m, [questionId]: { pending: true } }))
      } else if (insertError) {
        // the host may have already closed the question - resync so the
        // screen follows the game instead of freezing; otherwise ask the
        // player to try again rather than failing silently
        const { data: s } = await supabase
          .from('game_sessions')
          .select('*')
          .eq('id', session.id)
          .single()
        if (s) setSession(s)
        if (!s || (s.status === 'question' && s.current_index === session.current_index)) {
          setError(t('שליחת התשובה נכשלה. בדקו את החיבור ונסו שוב.'))
        }
      }
    } finally {
      answering.current = false
    }
  }

  function moveRankItem(pos, delta) {
    setRankOrder((order) => {
      const target = pos + delta
      if (target < 0 || target >= order.length) return order
      const next = [...order]
      ;[next[pos], next[target]] = [next[target], next[pos]]
      return next
    })
  }

  // ---- join / team pick screens ----

  if (pendingJoin) {
    return (
      <div className="stage player-stage">
        <div className="stage-inner">
          <h1 className="stage-title">{t('בחרו קבוצה')}</h1>
          <p className="stage-subtitle">{t('{nickname}, לאיזו קבוצה תצטרפו?', { nickname: pendingJoin.nickname })}</p>
          <div className="team-pick">
            {pendingJoin.quiz.teams.map((t, i) => (
              <button
                key={t}
                className="team-pick-btn"
                style={{ '--i': i, background: TEAM_COLORS[i % TEAM_COLORS.length] }}
                disabled={busy}
                onClick={() => registerPlayer(pendingJoin.session, pendingJoin.quiz, pendingJoin.nickname, pendingJoin.pin, t)}
              >
                {t}
              </button>
            ))}
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    )
  }

  if (!player) {
    return (
      <div className="center-screen">
        <form className="card login-card" onSubmit={join}>
          <h1 className="brand">NGG Quiz</h1>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><LanguageToggle /></div>
          <p className="muted">{t('הצטרפות לחידון')}</p>
          <label>
            {t('קוד הצטרפות')}
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
            {t('כינוי')}
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
          </label>
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? t('מצטרף...') : t('הצטרפות')}
          </button>
        </form>
      </div>
    )
  }

  // ---- in-game ----

  const myTeamColor = player.team && quiz ? teamColor(quiz, player.team) : null

  return (
    <div className="stage player-stage">
      <div className="player-topbar">
        <span className="chip">{player.nickname}</span>
        {player.team && (
          <span className="chip" style={myTeamColor ? { background: myTeamColor } : undefined}>
            {player.team}
          </span>
        )}
        {rankInfo && <span className="chip">{t("{score} נק'", { score: rankInfo.score })}</span>}
      </div>

      {session.status === 'lobby' && (
        <div className="stage-inner">
          <h1 className="stage-title">{t('אתם בפנים! 🎉')}</h1>
          <p className="stage-subtitle">
            {player.team ? t('אתם בקבוצת "{team}". ', { team: player.team }) : ''}
            {t('חכו שהמנחה יתחיל את החידון. שימו לב למסך המוקרן.')}
          </p>
        </div>
      )}

      {session.status === 'question' && !currentQuestion && (
        // the question is open but its content has not arrived on this
        // device yet - show progress (and a way out) instead of a blank screen
        <div className="stage-inner">
          {loadFailed ? (
            <>
              <h1 className="stage-title">{t('לא הצלחנו לטעון את השאלה 😕')}</h1>
              <p className="stage-subtitle">{t('בדקו את החיבור לאינטרנט ונסו שוב.')}</p>
              <button
                className="btn light xl"
                onClick={() => { setLoadFailed(false); setReloadToken((n) => n + 1) }}
              >
                {t('טעינה מחדש')}
              </button>
            </>
          ) : (
            <>
              <div className="spinner" />
              <p className="stage-subtitle">{t('טוען את השאלה...')}</p>
            </>
          )}
        </div>
      )}

      {session.status === 'question' && currentQuestion && (
        <div className="stage-inner full" key={`q-${session.current_index}`}>
          <div className="question-meta">
            <span className="meta-pill">{t('שאלה {number}', { number: session.current_index + 1 })}</span>
          </div>
          {error && <div className="error-box">{error}</div>}
          {myAnswer ? (
            <div className="wait-note">
              <h1 className="stage-title">{t('התשובה נקלטה ✓')}</h1>
              <p className="stage-subtitle">{t('ממתינים לשאר המשתתפים...')}</p>
            </div>
          ) : (
            <>
              <h2 className="player-question">{currentQuestion.text}</h2>

              {(currentQuestion.qtype === 'multiple_choice' || currentQuestion.qtype === 'poll') && (
                <div className="options-grid player">
                  {currentQuestion.options.map((opt, i) => (
                    <button
                      className={`option-tile clickable color-${i}`}
                      style={{ '--i': i }}
                      key={i}
                      onClick={() => submitAnswer({ answer_index: i })}
                    >
                      <span className="shape">{OPTION_SHAPES[i]}</span>
                      <span>{opt}</span>
                    </button>
                  ))}
                </div>
              )}

              {currentQuestion.qtype === 'word_cloud' && (
                <form
                  className="cloud-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (cloudText.trim()) submitAnswer({ answer: { text: cloudText.trim() } })
                  }}
                >
                  <input
                    value={cloudText}
                    onChange={(e) => setCloudText(e.target.value)}
                    maxLength={40}
                    placeholder={t('הקלידו תשובה קצרה...')}
                    autoFocus
                  />
                  <button className="btn light xl" disabled={!cloudText.trim()}>{t('שליחה ☁️')}</button>
                </form>
              )}

              {currentQuestion.qtype === 'ranking' && (
                <div className="rank-play">
                  <p className="stage-subtitle">{t('סדרו את הפריטים בסדר הנכון (מלמעלה למטה)')}</p>
                  {rankOrder.map((origIdx, pos) => (
                    <div className="rank-item" key={origIdx}>
                      <span className="rank-num">{pos + 1}</span>
                      <span className="rank-text">{currentQuestion.options[origIdx]}</span>
                      <span className="rank-arrows">
                        <button onClick={() => moveRankItem(pos, -1)} disabled={pos === 0} title={t('למעלה')}>↑</button>
                        <button onClick={() => moveRankItem(pos, 1)} disabled={pos === rankOrder.length - 1} title={t('למטה')}>↓</button>
                      </span>
                    </div>
                  ))}
                  <button className="btn light xl" onClick={() => submitAnswer({ answer: { order: rankOrder } })}>
                    {t('שליחת הסדר')}
                  </button>
                </div>
              )}

              {currentQuestion.qtype === 'hotspot' && (
                <div className="hotspot-play">
                  <p className="stage-subtitle">{t('הקישו על המיקום הנכון בתמונה')}</p>
                  <div
                    className="hotspot-frame"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setTapPos({
                        x: Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10,
                        y: Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10,
                      })
                    }}
                  >
                    <img src={currentQuestion.meta?.image_url} alt={t('תמונת השאלה')} draggable={false} />
                    {tapPos && <span className="hotspot-marker mine" style={{ left: `${tapPos.x}%`, top: `${tapPos.y}%` }} />}
                  </div>
                  <button
                    className="btn light xl"
                    disabled={!tapPos}
                    onClick={() => submitAnswer({ answer: tapPos })}
                  >
                    {t('שליחת המיקום')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {session.status === 'reveal' && (
        <div className="stage-inner" key={`r-${session.current_index}`}>
          {currentQuestion && ['poll', 'word_cloud'].includes(currentQuestion.qtype) ? (
            <>
              <h1 className="stage-title">{!myAnswer || myAnswer.pending ? t('לא נקלטה תשובה הפעם') : t('תודה על השיתוף! 🙌')}</h1>
              <p className="stage-subtitle">{t('התוצאות מוצגות על המסך המוקרן.')}</p>
            </>
          ) : !myAnswer || myAnswer.pending ? (
            <h1 className="stage-title">{t('לא נקלטה תשובה הפעם 😅')}</h1>
          ) : myAnswer.is_correct ? (
            <>
              <h1 className="stage-title correct-text">
                {currentQuestion?.qtype === 'multiple_choice' ? t('נכון! 🎉') : t('מדויק! 🎯')}
              </h1>
              <p className="points-pop">{t('+{points} נקודות', { points: myAnswer.points })}</p>
            </>
          ) : myAnswer.points > 0 ? (
            <>
              <h1 className="stage-title correct-text">{t('כמעט! 👏')}</h1>
              <p className="points-pop">{t('+{points} נקודות', { points: myAnswer.points })}</p>
            </>
          ) : (
            <h1 className="stage-title wrong-text">{t('לא נכון הפעם 💪')}</h1>
          )}
          {currentQuestion?.explanation && (
            <div className="explain-box">💡 {currentQuestion.explanation}</div>
          )}
          {rankInfo && currentQuestion && !['poll', 'word_cloud'].includes(currentQuestion.qtype) && (
            <p className="stage-subtitle">{t('מקום {rank} מתוך {total}', { rank: rankInfo.rank, total: rankInfo.total })}</p>
          )}
        </div>
      )}

      {session.status === 'leaderboard' && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">{t('המצב שלך')}</h1>
          {rankInfo && (
            <>
              <p className="points-pop">{t('{score} נקודות', { score: rankInfo.score })}</p>
              <p className="stage-subtitle">{t('מקום {rank} מתוך {total}', { rank: rankInfo.rank, total: rankInfo.total })}</p>
            </>
          )}
        </div>
      )}

      {session.status === 'finished' && (
        <div className="stage-inner">
          <h1 className="stage-title">{t('זהו, נגמר! 🏁')}</h1>
          {rankInfo && (
            <>
              <p className="points-pop">{t('{score} נקודות', { score: rankInfo.score })}</p>
              <p className="stage-subtitle">
                {rankInfo.rank === 1 ? t('מקום ראשון - כל הכבוד! 🏆') : t('סיימתם במקום {rank} מתוך {total}', { rank: rankInfo.rank, total: rankInfo.total })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
