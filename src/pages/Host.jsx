import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../supabaseClient'
import { playLink } from '../lib/links'
import Elapsed from '../components/Elapsed.jsx'
import Countdown, { useSecondsLeft } from '../components/Countdown.jsx'
import Confetti from '../components/Confetti.jsx'
import WordCloud from '../components/WordCloud.jsx'
import PollChart from '../components/PollChart.jsx'
import Scale from '../components/Scale.jsx'
import SurveyConclusion from '../components/SurveyConclusion.jsx'
import LiveConclusion from '../components/LiveConclusion.jsx'
import Explanation from '../components/Explanation.jsx'
import { scaleCounts, scalePoints } from '../lib/survey'
import { scaleSummary, correctShare } from '../lib/stats'
import { OPTION_SHAPES, optionColor, optionLabel } from '../lib/optionStyle'
import { deadlineMs } from '../lib/timer'
import { serverNow, syncServerClock } from '../lib/serverClock'
import { newerSession, withTimeout } from '../lib/liveSync'
import { TEAM_COLORS, kendallSimilarity, hasCorrectOption } from '../lib/questionTypes'
import { quizFlags, LIVE_BAR_TYPES, ANSWER_SLIDE_TYPES } from '../lib/quizMode'
import { fetchAll, mergeById, upsertById } from '../lib/fetchAll'
import { isMultiSelect, wordEntries, answerTexts, optionCounts as countOptions } from '../lib/multiAnswer'
import { useI18n } from '../lib/i18n.js'

const READ_TIMEOUT_MS = 10000
const WRITE_TIMEOUT_MS = 10000
// Realtime rows are gathered and applied together at most this often: a
// hall answering at once sends hundreds of inserts a second, and one render
// per insert would make the bars stutter on the projector
const FLUSH_MS = 200
// the projector's safety-net resync: slower while the channel is up, faster
// while it is down (each delay drawn within ±10%)
const RESYNC_HEALTHY_MS = 10000
const RESYNC_DEGRADED_MS = 4000

// a failed request with no database error code never reached the database
const isNetworkError = (error) => Boolean(error) && !error.code

// Every answer to one question, read past the API's 1,000-row cap. Ordered
// by arrival, so an answer that lands mid-read joins the last page instead
// of shifting the pages already read.
function fetchAnswers(sessionId, questionId) {
  return fetchAll(() =>
    withTimeout(
      supabase
        .from('answers')
        .select('*')
        .eq('session_id', sessionId)
        .eq('question_id', questionId)
        .order('answered_at')
        .order('id'),
      READ_TIMEOUT_MS
    )
  )
}

// The session's players, read past the row cap as well; id breaks ties so
// the pages keep a stable order.
function fetchPlayers(sessionId, column = 'joined_at', ascending = true) {
  return fetchAll(() =>
    withTimeout(
      supabase
        .from('players')
        .select('*')
        .eq('session_id', sessionId)
        .order(column, { ascending })
        .order('id'),
      READ_TIMEOUT_MS
    )
  )
}

function readSession(sessionId) {
  return withTimeout(supabase.from('game_sessions').select('*').eq('id', sessionId).maybeSingle(), READ_TIMEOUT_MS)
}

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
  const [acting, setActing] = useState(false) // a host action is on its way
  const [clockReady, setClockReady] = useState(false)
  const actingRef = useRef(false)
  const revealDone = useRef(null)
  const currentQuestionId = useRef(null) // read by the resync, which outlives renders

  const currentQuestion = useMemo(
    () => (session && session.current_index >= 0 ? questions[session.current_index] : null),
    [session, questions]
  )
  const isHost = session && user && session.host_id === user.id
  const { survey, scored, anonymous, live } = quizFlags(quiz)
  // teams compete on points, so they need a scored quiz (the database holds
  // the same rule; this also covers a row written before it existed)
  const teamsOn = scored && quiz?.teams_enabled && quiz?.teams?.length
  const timeLimit = (session?.status === 'question' && currentQuestion?.time_limit) || null
  const timeLeft = useSecondsLeft(session?.question_started_at, timeLimit)

  useEffect(() => {
    currentQuestionId.current = currentQuestion?.id ?? null
  }, [currentQuestion?.id])

  // initial load. A projector refreshed on a weak venue network retries
  // instead of sitting on a spinner; only a session that does not exist
  // is reported as such
  useEffect(() => {
    let cancelled = false
    let timer = null
    // the projector's countdown and its automatic reveal run on the
    // database clock, not on this machine's
    syncServerClock(supabase).then(() => { if (!cancelled) setClockReady(true) })

    async function load(attempt = 0) {
      const retry = () => {
        if (attempt >= 5) {
          setError(t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'))
          return
        }
        timer = setTimeout(() => load(attempt + 1), 1000 * 2 ** attempt)
      }
      const { data: s, error: sErr } = await readSession(sessionId)
      if (cancelled) return
      if (sErr) return retry()
      if (!s) {
        setError(t('המפגש לא נמצא.'))
        return
      }
      setSession((prev) => newerSession(prev, s))
      const [{ data: q }, { data: qs, error: qsErr }, { data: ps }] = await Promise.all([
        withTimeout(supabase.from('quizzes').select('*').eq('id', s.quiz_id).maybeSingle(), READ_TIMEOUT_MS),
        withTimeout(supabase.from('questions').select('*').eq('quiz_id', s.quiz_id).order('position'), READ_TIMEOUT_MS),
        fetchPlayers(sessionId),
      ])
      if (cancelled) return
      if (ps) setPlayers((prev) => upsertById(prev, ps))
      if (!q || qsErr) return retry()
      setError('')
      setQuiz(q)
      setQuestions(qs || [])
      QRCode.toDataURL(playLink(s.pin), { width: 320, margin: 1 })
        .then((url) => { if (!cancelled) setQr(url) })
        .catch(() => {})
    }

    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId])

  // realtime subscriptions, plus a resync safety net - realtime events
  // that arrive while the projector machine is asleep or offline are
  // never replayed, which would leave the host screen showing a stale
  // player list and answer count for the rest of the game.
  // The resync reads only the open question's answers, in full, and adds
  // them to what is already held: a whole-session read would hit the API's
  // row cap past 1,000 answers, and replacing state with it would silently
  // drop the rest. The session row only ever moves forward (newerSession),
  // so a slow resync can never flip the screen back a step.
  useEffect(() => {
    let cancelled = false
    let healthy = false
    let pollTimer = null
    let flushTimer = null
    let inflight = false
    let incoming = { players: [], answers: [] }

    function flush() {
      flushTimer = null
      const { players: ps, answers: as } = incoming
      incoming = { players: [], answers: [] }
      if (ps.length) setPlayers((prev) => mergeById(prev, ps))
      if (as.length) setAnswers((prev) => mergeById(prev, as))
    }

    function queue(kind, row) {
      incoming[kind].push(row)
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
    }

    async function resync() {
      if (inflight) return
      inflight = true
      try {
        const questionId = currentQuestionId.current
        const [{ data: s }, { data: ps }, { data: as }] = await Promise.all([
          readSession(sessionId),
          fetchPlayers(sessionId),
          questionId ? fetchAnswers(sessionId, questionId) : Promise.resolve({ data: null }),
        ])
        if (cancelled) return
        if (s) setSession((prev) => newerSession(prev, s))
        if (ps) setPlayers((prev) => upsertById(prev, ps))
        if (as) setAnswers((prev) => mergeById(prev, as))
      } finally {
        inflight = false
      }
    }

    function schedule() {
      clearTimeout(pollTimer)
      if (cancelled) return
      const pace = healthy ? RESYNC_HEALTHY_MS : RESYNC_DEGRADED_MS
      pollTimer = setTimeout(() => {
        resync()
        schedule()
      }, pace * (0.9 + Math.random() * 0.2))
    }

    // a fresh topic per subscription, so a channel whose removal timed out
    // is never handed back by supabase-js (see lib/liveSync.js)
    const channel = supabase
      .channel(`host-${sessionId}-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
        (payload) => setSession((prev) => newerSession(prev, payload.new))
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` },
        (payload) => queue('players', payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'answers', filter: `session_id=eq.${sessionId}` },
        (payload) => queue('answers', payload.new)
      )
      .subscribe((status) => {
        if (cancelled) return
        const ok = status === 'SUBSCRIBED'
        if (ok !== healthy) {
          healthy = ok
          schedule()
        }
        if (ok) resync()
      })

    const onWake = () => {
      if (document.visibilityState === 'visible') resync()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)
    schedule()

    return () => {
      cancelled = true
      clearTimeout(pollTimer)
      clearTimeout(flushTimer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  // refresh scores + answers when the phase changes (scores are updated by a DB trigger)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    async function refresh() {
      // only a scored quiz has scores to show; in live mode and surveys
      // every score is 0, and the joins already arrive through Realtime
      if (scored && ['reveal', 'leaderboard', 'finished'].includes(session.status)) {
        const { data } = await fetchPlayers(sessionId, 'score', false)
        if (!cancelled && data) setPlayers((prev) => upsertById(prev, data))
      }
      // the survey and live summaries read every answer, one question at a
      // time; a scored quiz ends on its podium and needs none of them
      if (session.status === 'finished' && !scored) {
        const wanted = survey ? questions : questions.filter((q) => LIVE_BAR_TYPES.includes(q.qtype))
        const results = await Promise.all(wanted.map((q) => fetchAnswers(sessionId, q.id)))
        if (!cancelled) setAnswers((prev) => mergeById(prev, results.flatMap((r) => r.data || [])))
      }
      if (['question', 'reveal'].includes(session.status) && currentQuestion) {
        const { data } = await fetchAnswers(sessionId, currentQuestion.id)
        if (!cancelled && data) setAnswers((prev) => mergeById(prev, data))
      }
    }
    refresh()
    return () => { cancelled = true }
    // currentQuestion is part of the key: on a host refresh mid-question the
    // session arrives before the questions, so without it the answers for the
    // open question are never fetched and the screen shows "answered: 0".
    // scored and the question count join it for the summary, which needs the
    // quiz and its questions to know what to read
  }, [session?.status, session?.current_index, currentQuestion?.id, scored, questions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => [...players].sort((a, b) => b.score - a.score), [players])

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

  // One host action at a time: a double click on "next question" must not
  // send two. Each action applies the session row it gets back straight
  // away, so the projector moves on the moment the database has, without
  // waiting for its own Realtime echo - which a busy hall can delay.
  async function act(run) {
    if (actingRef.current) return false
    actingRef.current = true
    setActing(true)
    setError('')
    try {
      return await run()
    } finally {
      actingRef.current = false
      setActing(false)
    }
  }

  function reportActionError(actionError) {
    setError(isNetworkError(actionError)
      ? t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.')
      : t('רק מנהל המפגש יכול לשלוט בחידון. ודאו שאתם מחוברים לחשבון המתאים.'))
  }

  // .select().single() also turns "no row updated" (not the host) into an
  // error, where a bare update would succeed silently
  async function updateStatus(status) {
    const { data, error: updateError } = await withTimeout(
      supabase.from('game_sessions').update({ status }).eq('id', sessionId).select().single(),
      WRITE_TIMEOUT_MS
    )
    if (updateError) {
      reportActionError(updateError)
      return false
    }
    setSession((prev) => newerSession(prev, data))
    return true
  }

  async function reveal() {
    if (!isHost || !currentQuestion || revealDone.current === currentQuestion.id) return
    revealDone.current = currentQuestion.id
    // the automatic reveal must not be lost to a click that is still on its
    // way, so it waits for that click rather than being dropped
    while (actingRef.current) await new Promise((resolve) => setTimeout(resolve, 100))
    const ok = await act(() => updateStatus('reveal'))
    if (!ok) revealDone.current = null
  }

  // A timed question closes itself: at the deadline the host screen
  // reveals the answer, exactly as if the button had been pressed. The
  // deadline is enforced in the database as well, so a late answer never
  // scores even if this timer misses (host screen closed, tab throttled).
  // Not in live mode: there the presenter talks the room through the
  // results and reveals in their own time, so the timer only closes
  // answering and the reveal waits for the button.
  useEffect(() => {
    if (!isHost || !timeLimit || live) return
    const deadline = deadlineMs(session.question_started_at, timeLimit)
    if (deadline == null) return
    const wait = deadline - serverNow()
    if (wait <= 0) {
      reveal()
      return
    }
    const timer = setTimeout(reveal, wait)
    return () => clearTimeout(timer)
  }, [isHost, timeLimit, live, session?.question_started_at, currentQuestion?.id, clockReady]) // eslint-disable-line react-hooks/exhaustive-deps

  function startQuestion(index) {
    return act(async () => {
      const { error: rpcError } = await withTimeout(
        supabase.rpc('start_question', { p_session: sessionId, p_index: index }),
        WRITE_TIMEOUT_MS
      )
      if (rpcError) {
        reportActionError(rpcError)
        return false
      }
      const { data } = await readSession(sessionId)
      if (data) setSession((prev) => newerSession(prev, data))
      return true
    })
  }

  function setStatus(status) {
    return act(() => updateStatus(status))
  }

  if (!session || !quiz) {
    return (
      <div className="center-screen">
        {error ? <div className="error-box">{error}</div> : <div className="spinner" />}
      </div>
    )
  }

  const isLast = session.current_index >= questions.length - 1
  const cloudTexts = currentAnswers.flatMap(answerTexts)
  // a poll that takes several options: its percentages are of the people who
  // answered, so they can add up to more than 100%
  const multiSelect = isMultiSelect(currentQuestion)
  const respondents = multiSelect ? currentAnswers.length : undefined
  const maxWords = wordEntries(currentQuestion)

  const neutralOrder = currentQuestion?.qtype === 'ranking'
    ? [...(currentQuestion.options || [])].sort((a, b) => String(a).localeCompare(String(b), 'he'))
    : []

  const optionCounts = countOptions(currentAnswers, (currentQuestion?.options || []).length)
  const maxOptionCount = Math.max(1, ...optionCounts)
  const optionLabels = (currentQuestion?.options || []).map((_, i) => optionLabel(currentQuestion, i, t))
  const optionColors = (currentQuestion?.options || []).map((_, i) => optionColor(currentQuestion, i))

  // live mode: the projector shows results rising while the question is open
  // (never which answer is right), and reveals with a single answer slide
  const liveBars = live && LIVE_BAR_TYPES.includes(currentQuestion?.qtype)
  const answerSlide = live && ANSWER_SLIDE_TYPES.includes(currentQuestion?.qtype)
  const share = answerSlide ? correctShare(optionCounts, currentQuestion.correct_index) : null
  const answerText = answerSlide ? optionLabel(currentQuestion, currentQuestion.correct_index, t) : ''
  // a long answer steps down in size so the slide still fits on one screen
  const answerLength = answerText.length > 28 ? ' longer' : answerText.length > 12 ? ' long' : ''
  // and so does a long explanation, never below the 24px floor
  const explanationLength = (currentQuestion?.explanation || '').length
  const explanationSize = explanationLength > 260 ? ' longer' : explanationLength > 120 ? ' long' : ''

  const scale = currentQuestion?.qtype === 'scale' ? currentQuestion.meta : null
  const scalePointList = scale ? scalePoints(scale) : []
  const scaleTally = scale ? scaleCounts(currentAnswers, scale) : []
  const scaleStats = scale
    ? scaleSummary(scaleTally, scalePointList[0], scalePointList[scalePointList.length - 1])
    : null

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
        {scored && (
          <button className="btn light xl" disabled={acting} onClick={() => setStatus('leaderboard')}>
            {t('טבלת המובילים')}
          </button>
        )}
        {isLast ? (
          <button className="btn primary xl" disabled={acting} onClick={() => setStatus('finished')}>
            {survey ? t('לסיכום הסקר') : live ? t('לסיכום החידון') : t('לתוצאות הסופיות')}
          </button>
        ) : (
          <button className="btn primary xl" disabled={acting} onClick={() => startQuestion(session.current_index + 1)}>
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
    <div className={`stage${live ? ' live' : ''}`}>
      {error && <div className="error-box floating">{error}</div>}

      {session.status === 'lobby' && (
        <div className="stage-inner" key="lobby">
          {quiz.logo_url && <img className="client-logo" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
          <h1 className="stage-title">{quiz.title}</h1>
          {quiz.subtitle && <h2 className="stage-subtitle">{quiz.subtitle}</h2>}
          {anonymous ? (
            // no names in anonymous mode: the join code and the QR side by
            // side, and one count the whole room can read
            <div className="lobby-join">
              <div className="lobby-join-info">
                <div className="pin-banner big glow">
                  {t('קוד הצטרפות:')} <span className="pin">{session.pin}</span>
                </div>
                <p className="join-url" dir="ltr">{playLink(session.pin)}</p>
                <div className="join-counter">
                  <span className="join-counter-value" key={players.length}>{players.length}</span>
                  <span className="join-counter-label">
                    {players.length === 1 ? t('משתתף הצטרף') : t('משתתפים הצטרפו')}
                  </span>
                </div>
              </div>
              {qr && <img className="qr-big" src={qr} alt={t('קוד QR להצטרפות')} />}
            </div>
          ) : (
            <>
              <div className="pin-banner big glow">
                {t('קוד הצטרפות:')} <span className="pin">{session.pin}</span>
              </div>
              <p className="join-url" dir="ltr">{playLink(session.pin)}</p>
              {qr && <img className="qr-big" src={qr} alt={t('קוד QR להצטרפות')} />}
              <h3>{t('משתתפים ({count})', { count: players.length })}</h3>
            </>
          )}
          {anonymous ? null : teamsOn ? (
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
              disabled={players.length === 0 || acting}
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
            {timeLimit ? <Countdown left={timeLeft ?? timeLimit} /> : <Elapsed since={session.question_started_at} />}
            <span className="meta-pill">{t('ענו: {answered}/{total}', { answered: currentAnswers.length, total: players.length })}</span>
          </div>
          {timeLimit && (
            <div className="timer-bar" aria-hidden="true">
              <div style={{ width: `${((timeLeft ?? timeLimit) / timeLimit) * 100}%` }} />
            </div>
          )}
          <h1 className="stage-title">{currentQuestion.text}</h1>
          {multiSelect && <p className="stage-subtitle multi-note">{t('☑️ אפשר לבחור יותר מאפשרות אחת')}</p>}

          {liveBars ? (
            // the chart stays mounted for the whole question, so each answer
            // eases the bars up instead of redrawing them; no correctIndex,
            // and colours by position only, so nothing hints at the answer
            <PollChart
              live
              options={optionLabels}
              counts={optionCounts}
              colorIndexes={optionColors}
              reference={false}
              respondents={respondents}
            />
          ) : (hasCorrectOption(currentQuestion.qtype) || currentQuestion.qtype === 'poll') && (
            <div className={`options-grid${currentQuestion.options.length > 4 ? ' many' : ''}`}>
              {currentQuestion.options.map((_, i) => (
                <div className={`option-tile color-${optionColor(currentQuestion, i)}`} style={{ '--i': i }} key={i}>
                  <span className="shape">{OPTION_SHAPES[optionColor(currentQuestion, i)]}</span>
                  <span>{optionLabel(currentQuestion, i, t)}</span>
                </div>
              ))}
            </div>
          )}

          {currentQuestion.qtype === 'scale' && (
            <>
              <p className="stage-subtitle">{t('📏 בחרו את המספר שמייצג אתכם במכשיר שלכם')}</p>
              <Scale meta={currentQuestion.meta} />
            </>
          )}

          {currentQuestion.qtype === 'word_cloud' && (
            <>
              <p className="stage-subtitle">
                {maxWords > 1
                  ? t('☁️ ענו מהטלפון, עד {count} מילים - הענן נבנה בזמן אמת', { count: maxWords })
                  : t('☁️ ענו מהטלפון - הענן נבנה בזמן אמת')}
              </p>
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

          {/* live mode, time up: answering is closed and the room is waiting
              for the presenter, so the screen says so and the button calls */}
          {live && timeLimit && timeLeft === 0 && (
            <p className="stage-subtitle time-up-note">{t('⏱ הזמן נגמר - המענה נסגר')}</p>
          )}
          {isHost && (
            <button
              className={`btn light xl${live && timeLimit && timeLeft === 0 ? ' call' : ''}`}
              disabled={acting}
              onClick={reveal}
            >
              {survey ? t('הצגת התוצאות') : t('חשיפת התשובה')}
            </button>
          )}
        </div>
      )}

      {session.status === 'reveal' && currentQuestion && answerSlide && (
        <div className="stage-inner wide answer-slide" key={`r-${session.current_index}`}>
          <p className="answer-question">{currentQuestion.text}</p>
          <div className="answer-panel">
            <span className="answer-label">{t('התשובה הנכונה')}</span>
            <span className={`answer-text${answerLength}`}>{answerText}</span>
          </div>
          <div
            className={`answer-body${currentQuestion.explanation ? ' with-explanation' : ''}${currentQuestion.options.length > 4 ? ' many' : ''}`}
          >
            {currentQuestion.explanation && (
              <div className={`answer-explanation${explanationSize}`}>
                <Explanation text={currentQuestion.explanation} />
              </div>
            )}
            <div className="answer-results">
              {share ? (
                <div className="answer-stat">
                  <span className="answer-stat-value">{t('{percent}% ענו נכון', { percent: share.percent })}</span>
                  <span className="answer-stat-detail">
                    {t('{correct} מתוך {total} משתתפים', { correct: share.correct, total: share.total })}
                  </span>
                </div>
              ) : (
                <p className="answer-stat-detail">{t('לא התקבלו תשובות לשאלה זו.')}</p>
              )}
              <PollChart
                options={optionLabels}
                counts={optionCounts}
                correctIndex={currentQuestion.correct_index}
                colorIndexes={optionColors}
                reference={false}
              />
            </div>
          </div>
          {nextButtons()}
        </div>
      )}

      {session.status === 'reveal' && currentQuestion && !answerSlide && (
        <div className="stage-inner" key={`r-${session.current_index}`}>
          <h1 className="stage-title">{currentQuestion.text}</h1>

          {hasCorrectOption(currentQuestion.qtype) && (
            <div className={`options-grid${currentQuestion.options.length > 4 ? ' many' : ''}`}>
              {currentQuestion.options.map((_, i) => {
                const correct = i === currentQuestion.correct_index
                return (
                  <div
                    className={`option-tile color-${optionColor(currentQuestion, i)} ${correct ? 'correct' : 'dimmed'}`}
                    style={{ '--i': i }}
                    key={i}
                  >
                    <span className="shape">{OPTION_SHAPES[optionColor(currentQuestion, i)]}</span>
                    <span>{optionLabel(currentQuestion, i, t)} {correct && '✓'}</span>
                    <div className="bar-track">
                      <div className="bar" style={{ width: `${(optionCounts[i] / maxOptionCount) * 100}%` }} />
                    </div>
                    <span className="count">{optionCounts[i]}</span>
                  </div>
                )
              })}
            </div>
          )}

          {currentQuestion.qtype === 'poll' && (
            <PollChart
              options={currentQuestion.options || []}
              counts={optionCounts}
              reference={!survey && !multiSelect}
              respondents={respondents}
            />
          )}

          {currentQuestion.qtype === 'scale' && (
            <>
              <PollChart options={scalePointList.map(String)} counts={scaleTally} scale />
              <div className="survey-scale-ends muted small">
                <span>{currentQuestion.meta?.low_label}</span>
                <span>{currentQuestion.meta?.high_label}</span>
              </div>
              {scaleStats && (
                <div className="survey-metrics compact">
                  <div className="metric"><span>{scaleStats.mean.toFixed(2)}</span><small>{t('ממוצע')}</small></div>
                  <div className="metric"><span>{scaleStats.median}</span><small>{t('חציון')}</small></div>
                  <div className="metric"><span>{scaleStats.modes.join(', ')}</span><small>{t('השכיח')}</small></div>
                  <div className="metric"><span>{scaleStats.sd.toFixed(2)}</span><small>{t('סטיית תקן')}</small></div>
                  <div className="metric"><span>{scaleStats.n}</span><small>{t('עונים')}</small></div>
                </div>
              )}
            </>
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

      {/* an unscored quiz never opens the leaderboard; should the state be
          reached anyway, no names or scores are shown - only the way on */}
      {session.status === 'leaderboard' && !scored && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">{quiz.title}</h1>
          {nextButtons()}
        </div>
      )}

      {session.status === 'leaderboard' && scored && (
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
              <button className="btn primary xl" disabled={acting} onClick={() => setStatus('finished')}>
                {t('סיום החידון')}
              </button>
            ) : (
              <button className="btn primary xl" disabled={acting} onClick={() => startQuestion(session.current_index + 1)}>
                {t('השאלה הבאה')}
              </button>
            )
          )}
        </div>
      )}

      {session.status === 'finished' && survey && (
        <div className="stage-inner wide" key="finished-survey">
          {quiz.logo_url && <img className="client-logo small" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
          <h1 className="stage-title">📋 {quiz.title}</h1>
          <h2 className="stage-subtitle">{t('סיכום הסקר')}</h2>
          <SurveyConclusion questions={questions} answers={answers} participants={players.length} />
          {isHost && (
            <button className="btn ghost light-ghost" onClick={() => navigate('/')}>{t('חזרה לספרייה')}</button>
          )}
        </div>
      )}

      {session.status === 'finished' && live && (
        <div className="stage-inner wide" key="finished-live">
          {quiz.logo_url && <img className="client-logo small" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
          <h1 className="stage-title">⚡ {quiz.title}</h1>
          <h2 className="stage-subtitle">{t('סיכום החידון')}</h2>
          <LiveConclusion questions={questions} answers={answers} participants={players.length} />
          {isHost && (
            <button className="btn ghost light-ghost" onClick={() => navigate('/')}>{t('חזרה לספרייה')}</button>
          )}
        </div>
      )}

      {session.status === 'finished' && scored && (
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
