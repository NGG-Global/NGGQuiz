import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { OPTION_SHAPES, optionColor, optionLabel } from '../lib/optionStyle'
import { deadlineMs } from '../lib/timer'
import { serverNow, syncServerClock } from '../lib/serverClock'
import { followSession, newerSession, withTimeout } from '../lib/liveSync'
import { loadSavedPlayer, savePlayer, forgetPlayer, newPlayerId } from '../lib/playerStore'
import { TEAM_COLORS, teamColor, shuffled, hasCorrectOption } from '../lib/questionTypes'
import { quizFlags } from '../lib/quizMode'
import { isMultiSelect, wordEntries, cleanWords, MAX_WORD_LENGTH } from '../lib/multiAnswer'
import { useI18n } from '../lib/i18n.js'
import LanguageToggle from '../components/LanguageToggle.jsx'
import Countdown, { useSecondsLeft } from '../components/Countdown.jsx'
import Scale from '../components/Scale.jsx'
import Explanation from '../components/Explanation.jsx'

// the quiz columns a phone needs, for both the join and the game screens
const QUIZ_FIELDS = 'kind, scored, anonymous, teams_enabled, team_mode, teams, title'
const QUESTION_FIELDS = 'id, qtype, text, options, meta, position, explanation, time_limit'
const ANSWER_FIELDS = 'question_id, is_correct, points, answer_index, answer'

// how long a read or a write may hang on a flaky mobile network before the
// phone gives up on it and tries again
const READ_TIMEOUT_MS = 8000
const WRITE_TIMEOUT_MS = 10000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// a failed request with no database error code never reached the database
// (offline, timed out); one with a code was answered and refused
const isNetworkError = (error) => Boolean(error) && !error.code

// An anonymous player still needs a players row - every answer points at
// one - so each phone gets a random nickname that no screen ever shows.
function anonymousNickname() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `anon-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

// the open session behind a PIN, and its quiz
async function lookupJoin(cleanPin) {
  const { data: s, error: sErr } = await withTimeout(
    supabase.from('game_sessions').select('*').eq('pin', cleanPin).neq('status', 'finished').maybeSingle(),
    READ_TIMEOUT_MS
  )
  if (sErr) return { error: 'offline' }
  if (!s) return { error: 'missing' }
  const { data: qz, error: qErr } = await withTimeout(
    supabase.from('quizzes').select(QUIZ_FIELDS).eq('id', s.quiz_id).single(),
    READ_TIMEOUT_MS
  )
  if (qErr) return { error: 'offline' }
  return { session: s, quiz: qz }
}

// the saved player and its session, read back after a refresh
async function fetchSavedPlayer({ playerId, sessionId }) {
  const [s, p] = await Promise.all([
    withTimeout(supabase.from('game_sessions').select('*').eq('id', sessionId).maybeSingle(), READ_TIMEOUT_MS),
    withTimeout(supabase.from('players').select('*').eq('id', playerId).maybeSingle(), READ_TIMEOUT_MS),
  ])
  if (s.error || p.error) return { error: 'offline' }
  if (!s.data || !p.data || p.data.session_id !== sessionId) return { error: 'missing' }
  return { session: s.data, player: p.data }
}

let standingRpcMissing = false

// This player's score and rank. player_standing() counts in the database;
// before that function exists, every player's score is read instead (the
// old way - heavier, and capped at the API's first 1,000 rows).
async function fetchStanding(playerId, sessionId) {
  if (!standingRpcMissing) {
    const { data, error } = await withTimeout(
      supabase.rpc('player_standing', { p_player: playerId }).maybeSingle(),
      READ_TIMEOUT_MS
    )
    if (!error) return data ? { rank: data.rank, total: data.total, score: data.score } : null
    // PGRST202: no such function in the API schema - the migration has not run
    if (error.code !== 'PGRST202' && error.code !== '42883') return null
    standingRpcMissing = true
  }
  const { data } = await withTimeout(
    supabase.from('players').select('id, score').eq('session_id', sessionId).order('score', { ascending: false }),
    READ_TIMEOUT_MS
  )
  if (!data) return null
  const idx = data.findIndex((p) => p.id === playerId)
  return idx >= 0 ? { rank: idx + 1, total: data.length, score: data[idx].score } : null
}

export default function Play() {
  const { t } = useI18n()
  const { pin: pinParam } = useParams()
  const navigate = useNavigate()

  const [pin, setPin] = useState(pinParam || '')
  const [nickname, setNickname] = useState('')
  const [session, setSession] = useState(null)
  const [quiz, setQuiz] = useState(null)
  const [player, setPlayer] = useState(null)
  const [pendingJoin, setPendingJoin] = useState(null) // {session, quiz, nickname} waiting for team pick
  const [joinInfo, setJoinInfo] = useState(null) // {pin, session, quiz} looked up for the join form
  const [autoJoining, setAutoJoining] = useState(false)
  const [restoring, setRestoring] = useState(null) // null | 'restoring' | 'failed'
  const [restoreToken, setRestoreToken] = useState(0)
  const [questions, setQuestions] = useState([])
  const [myAnswers, setMyAnswers] = useState({}) // question_id -> result row
  const [rankInfo, setRankInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(null) // {questionId, index} while an answer is on its way
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const answering = useRef(false)
  const autoJoinStarted = useRef(false)
  const playerRef = useRef(null)
  // one player id per join on this page, reused when a join is retried, so
  // a retry after a lost response finds the row the first try created
  const joinIds = useRef({})
  // questions this phone tried to answer; if the outcome was lost on the
  // way back, the reveal reads it from the database
  const attempted = useRef(new Set())

  // per-question input state
  const [cloudText, setCloudText] = useState('')
  const [words, setWords] = useState([]) // a word cloud that takes several words
  const [wordNote, setWordNote] = useState('') // why the last word was not added
  const [picked, setPicked] = useState([]) // a poll that takes several options
  const [rankOrder, setRankOrder] = useState([]) // original indices in chosen order
  const [tapPos, setTapPos] = useState(null)

  playerRef.current = player

  const currentQuestion = useMemo(
    () => (session && session.current_index >= 0 ? questions[session.current_index] : null),
    [session, questions]
  )
  const myAnswer = currentQuestion ? myAnswers[currentQuestion.id] : null
  const { survey, scored, anonymous } = quizFlags(quiz)
  const timeLimit = (session?.status === 'question' && currentQuestion?.time_limit) || null
  const timeLeft = useSecondsLeft(session?.question_started_at, timeLimit)
  const timeUp = timeLimit != null && timeLeft === 0
  const finished = session?.status === 'finished'

  // restore a previous join after a refresh, a discarded tab or a second
  // scan of the QR code; with nothing to restore, a link to an anonymous
  // quiz joins straight away, since there is nothing to type. A network
  // failure is retried and never taken for "no such player": that would
  // make the phone join again as somebody new.
  useEffect(() => {
    if (!pinParam) return
    const saved = loadSavedPlayer(pinParam)
    if (!saved) {
      autoJoinIfAnonymous(pinParam)
      return
    }
    // just joined on this page: the address changed to /play/<pin>, the
    // player is already here
    if (playerRef.current?.id === saved.playerId) return
    let cancelled = false
    let timer = null
    setRestoring('restoring')

    async function attempt(n) {
      const result = await fetchSavedPlayer(saved)
      if (cancelled) return
      if (result.error === 'offline') {
        if (n >= 4) setRestoring('failed')
        else timer = setTimeout(() => attempt(n + 1), 1000 * 2 ** n)
        return
      }
      setRestoring(null)
      if (result.error) {
        // the session or the player is gone: start over as a new join
        forgetPlayer(pinParam)
        autoJoinIfAnonymous(pinParam)
        return
      }
      setSession((prev) => newerSession(prev, result.session))
      setPlayer(result.player)
    }

    attempt(0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pinParam, restoreToken]) // eslint-disable-line react-hooks/exhaustive-deps

  // an anonymous quiz needs no nickname: once a full PIN is typed (or comes
  // in the link), look the quiz up so the form can drop the field
  useEffect(() => {
    if (player || pin.length !== 6 || joinInfo?.pin === pin) return
    // a link's PIN is already being looked up by the automatic join
    if (pin === pinParam && autoJoinStarted.current) return
    let cancelled = false
    lookupJoin(pin).then((info) => {
      if (!cancelled && !info.error) setJoinInfo({ pin, ...info })
    })
    return () => { cancelled = true }
  }, [pin, player]) // eslint-disable-line react-hooks/exhaustive-deps

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
        withTimeout(supabase.from('quizzes').select(QUIZ_FIELDS).eq('id', quizId).single(), READ_TIMEOUT_MS),
        withTimeout(
          supabase.from('questions').select(QUESTION_FIELDS).eq('quiz_id', quizId).order('position'),
          READ_TIMEOUT_MS
        ),
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
    withTimeout(
      supabase.from('answers').select(ANSWER_FIELDS).eq('session_id', session.id).eq('player_id', player.id),
      READ_TIMEOUT_MS
    ).then(({ data }) => {
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

  // follow the session in realtime, with the resync safety net described in
  // lib/liveSync.js. A finished game changes no more, so the phone stops
  // following it and leaves the database alone.
  useEffect(() => {
    if (!session?.id || finished) return
    syncServerClock(supabase)
    const follower = followSession(supabase, session.id, {
      label: 'play',
      onState: (row) => setSession((prev) => newerSession(prev, row)),
    })
    return () => follower.stop()
  }, [session?.id, finished])

  // reset per-question input state when a new question starts
  useEffect(() => {
    if (!currentQuestion) return
    answering.current = false // a submit that hung on the previous question must not block this one
    setSending(null)
    setError('')
    setCloudText('')
    setWords([])
    setWordNote('')
    setPicked([])
    setTapPos(null)
    if (currentQuestion.qtype === 'ranking') {
      setRankOrder(shuffled(currentQuestion.options?.length || 0))
    }
  }, [currentQuestion?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // at the reveal, a phone that sent an answer but never heard back (the
  // response was lost, or the request timed out after it landed) reads the
  // outcome, so it does not show "no answer received" for an answer that
  // counted. Phones that answered normally, or never tapped, skip this.
  useEffect(() => {
    if (session?.status !== 'reveal' || !currentQuestion || !player) return
    const questionId = currentQuestion.id
    const known = myAnswers[questionId]
    if (known && !known.pending) return
    if (!known && !attempted.current.has(questionId)) return
    let cancelled = false
    fetchMyAnswer(questionId).then((row) => {
      if (!cancelled && row) setMyAnswers((m) => ({ ...m, [questionId]: row }))
    })
    return () => { cancelled = true }
  }, [session?.status, currentQuestion?.id, player?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // pull my rank when scores are shown. Not in an unscored quiz: there is no
  // rank to show - and until the quiz has loaded, quizFlags reads any quiz as
  // scored, so nothing is asked before then. The reads of a whole hall are
  // spread over a second or so, since every phone asks at the same moment.
  const quizLoaded = Boolean(quiz)
  useEffect(() => {
    if (!session || !player || !quizLoaded || !scored) return
    if (!['leaderboard', 'finished', 'reveal'].includes(session.status)) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const standing = await fetchStanding(player.id, session.id)
      if (!cancelled && standing) setRankInfo(standing)
    }, Math.random() * 1200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [session?.status, session?.current_index, session?.id, player?.id, quizLoaded, scored]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchMyAnswer(questionId) {
    if (!playerRef.current) return null
    const { data } = await withTimeout(
      supabase
        .from('answers')
        .select(ANSWER_FIELDS)
        .eq('question_id', questionId)
        .eq('player_id', playerRef.current.id)
        .maybeSingle(),
      READ_TIMEOUT_MS
    )
    return data || null
  }

  async function autoJoinIfAnonymous(cleanPin) {
    // once per page: React's development double-run of effects, or a second
    // call while the first is in flight, must not register two players
    if (autoJoinStarted.current) return
    autoJoinStarted.current = true
    setAutoJoining(true)
    let info = await lookupJoin(cleanPin)
    // a hall full of phones on one Wi-Fi: a failed lookup is retried before
    // the phone falls back to the form
    for (let attempt = 0; info.error === 'offline' && attempt < 3; attempt++) {
      await sleep(1000 * 2 ** attempt)
      info = await lookupJoin(cleanPin)
    }
    if (!info.error) setJoinInfo({ pin: cleanPin, ...info })
    if (info.error === 'offline') setError(t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'))
    if (!info.error && quizFlags(info.quiz).anonymous) {
      await registerAnonymous(info.session, info.quiz, cleanPin, { retries: 3 })
    }
    setAutoJoining(false)
  }

  async function join(e) {
    e.preventDefault()
    setError('')
    const cleanPin = pin.trim()
    const cleanNick = nickname.trim()
    if (!cleanPin) return
    // the nickname may only be skipped once the quiz is known to be anonymous
    const knownAnonymous = joinInfo?.pin === cleanPin && quizFlags(joinInfo.quiz).anonymous
    if (!cleanNick && !knownAnonymous) return
    setBusy(true)

    const info = await lookupJoin(cleanPin)
    if (info.error === 'offline') {
      // a failed request is not a wrong PIN - saying so sends the player
      // hunting for a code that was correct all along
      setError(t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'))
      setBusy(false)
      return
    }
    if (info.error) {
      setError(t('לא נמצא חידון פעיל עם הקוד הזה.'))
      setBusy(false)
      return
    }
    const { session: s, quiz: qz } = info
    setJoinInfo({ pin: cleanPin, ...info })

    // this device already joined this game (a refresh of the /play form, or
    // a second tab): continue as that player instead of registering again
    const saved = loadSavedPlayer(cleanPin)
    if (saved?.sessionId === s.id) {
      const restored = await fetchSavedPlayer(saved)
      if (restored.player) {
        setBusy(false)
        completeJoin(restored.session, qz, restored.player, cleanPin)
        return
      }
      if (restored.error === 'missing') forgetPlayer(cleanPin)
    }

    if (quizFlags(qz).anonymous) {
      await registerAnonymous(s, qz, cleanPin)
      return
    }
    if (!cleanNick) {
      // the quiz turned out not to be anonymous after all: the form now
      // shows the nickname field again
      setBusy(false)
      return
    }

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
    const { data } = await withTimeout(
      supabase.from('players').select('team').eq('session_id', sessionId),
      READ_TIMEOUT_MS
    )
    const counts = Object.fromEntries(teams.map((t) => [t, 0]))
    ;(data || []).forEach((p) => {
      if (p.team in counts) counts[p.team] += 1
    })
    const min = Math.min(...teams.map((t) => counts[t]))
    const candidates = teams.filter((t) => counts[t] === min)
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  // Inserts the players row under an id chosen here. The id is saved before
  // the insert goes out, so a refresh while it is in flight still finds the
  // row; and a retry reuses it, so a duplicate-key answer can be told apart:
  // our own earlier row (same id) or another player's nickname.
  async function insertPlayer(s, cleanPin, idKey, fields) {
    const id = (joinIds.current[idKey] ||= newPlayerId())
    savePlayer(cleanPin, { playerId: id, sessionId: s.id })
    const { data, error: insertError } = await withTimeout(
      supabase.from('players').insert({ id, session_id: s.id, ...fields }).select().single(),
      WRITE_TIMEOUT_MS
    )
    if (!insertError) return { player: data }
    if (insertError.code === '23505') {
      const { data: mine, error: readError } = await withTimeout(
        supabase.from('players').select('*').eq('id', id).maybeSingle(),
        READ_TIMEOUT_MS
      )
      if (mine) return { player: mine }
      if (!readError) {
        // the nickname is someone else's; a new attempt gets a new id
        delete joinIds.current[idKey]
        forgetPlayer(cleanPin)
        return { error: 'taken' }
      }
      return { error: 'offline' }
    }
    if (isNetworkError(insertError)) return { error: 'offline' }
    // refused by the database (the game ended, for one): nothing to restore
    delete joinIds.current[idKey]
    forgetPlayer(cleanPin)
    return { error: 'refused' }
  }

  async function registerPlayer(s, qz, cleanNick, cleanPin, team) {
    setBusy(true)
    const result = await insertPlayer(s, cleanPin, `${s.id}:${cleanNick}`, { nickname: cleanNick, team })
    setBusy(false)
    if (result.error) {
      setError(result.error === 'taken' ? t('הכינוי הזה כבר תפוס במשחק. בחרו כינוי אחר.') : t('ההצטרפות נכשלה. נסו שוב.'))
      setPendingJoin(null)
      return
    }
    completeJoin(s, qz, result.player, cleanPin)
  }

  async function registerAnonymous(s, qz, cleanPin, { retries = 0 } = {}) {
    setBusy(true)
    let result = null
    // a clash between two random nicknames is all but impossible, but it is
    // retried rather than shown to someone who never typed a nickname; so is
    // a network failure on the automatic join, where there is no form to retry
    for (let clash = 0, lost = 0; ; ) {
      result = await insertPlayer(s, cleanPin, s.id, { nickname: anonymousNickname(), team: null })
      if (result.player) break
      if (result.error === 'taken' && clash < 3) clash += 1
      else if (result.error === 'offline' && lost < retries) await sleep(1000 * 2 ** lost++)
      else break
    }
    setBusy(false)
    if (!result.player) {
      setError(t('ההצטרפות נכשלה. נסו שוב.'))
      return
    }
    setError('')
    completeJoin(s, qz, result.player, cleanPin)
  }

  // a joined player is remembered per PIN, so a refresh keeps the same
  // player; the address becomes /play/<pin>, which is what a refresh restores
  function completeJoin(s, qz, p, cleanPin) {
    savePlayer(cleanPin, { playerId: p.id, sessionId: s.id })
    playerRef.current = p
    setSession((prev) => newerSession(prev, s))
    setQuiz(qz)
    setPlayer(p)
    setPendingJoin(null)
    if (pinParam !== cleanPin) navigate(`/play/${cleanPin}`, { replace: true })
  }

  async function submitAnswer(payload, index = null) {
    if (!currentQuestion || myAnswer || answering.current) return
    // a timed question stops accepting answers at its deadline (the
    // database enforces the same deadline, with a small grace window)
    const deadline = deadlineMs(session.question_started_at, currentQuestion.time_limit)
    if (deadline != null && serverNow() >= deadline) return
    answering.current = true
    setError('')
    const questionId = currentQuestion.id
    const questionIndex = session.current_index
    attempted.current.add(questionId)
    setSending({ questionId, index })
    try {
      // don't let a request that hangs on a flaky mobile network keep the player stuck
      const { data, error: insertError } = await withTimeout(
        supabase
          .from('answers')
          .insert({
            session_id: session.id,
            question_id: questionId,
            player_id: player.id,
            ...payload,
          })
          .select('is_correct, points, answer_index, answer')
          .single(),
        WRITE_TIMEOUT_MS
      )
      if (!insertError && data) {
        setMyAnswers((m) => ({ ...m, [questionId]: { question_id: questionId, ...data } }))
        return
      }
      // a duplicate means an earlier try did land; a failure may also have
      // landed with only the response lost - either way, read what the
      // database holds, so the reveal shows the real result
      const landed = await fetchMyAnswer(questionId)
      if (landed || insertError?.code === '23505') {
        setMyAnswers((m) => ({ ...m, [questionId]: landed || { pending: true } }))
        return
      }
      // the host may have already closed the question - resync so the
      // screen follows the game instead of freezing; otherwise ask the
      // player to try again rather than failing silently
      const { data: s } = await withTimeout(
        supabase.from('game_sessions').select('*').eq('id', session.id).maybeSingle(),
        READ_TIMEOUT_MS
      )
      if (s) setSession((prev) => newerSession(prev, s))
      const missedDeadline = deadline != null && serverNow() >= deadline
      if (!missedDeadline && (!s || (s.status === 'question' && s.current_index === questionIndex))) {
        setError(t('שליחת התשובה נכשלה. בדקו את החיבור ונסו שוב.'))
      }
    } finally {
      answering.current = false
      setSending(null)
    }
  }

  function togglePicked(index) {
    setPicked((list) => (list.includes(index) ? list.filter((i) => i !== index) : [...list, index]))
  }

  // adds the typed word to the list; the same word twice is kept once
  function addWord(max) {
    const next = cleanWords([...words, cloudText], max)
    if (next.length === words.length && cloudText.trim()) {
      setWordNote(words.length >= max
        ? t('אפשר לשלוח עד {count} מילים.', { count: max })
        : t('המילה הזו כבר ברשימה.'))
      return
    }
    setWordNote('')
    setWords(next)
    setCloudText('')
  }

  // a word still in the box when the player presses send goes with the rest,
  // rather than being silently left behind
  function sendWords(max) {
    const all = cleanWords([...words, cloudText], max)
    if (all.length) submitAnswer({ answer: { texts: all } })
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

  // coming back after a refresh: never flash the join form, which would
  // invite a second join as somebody new
  if (!player && restoring === 'failed') {
    return (
      <div className="center-screen">
        <div className="card login-card">
          <h1 className="brand">NGG Quiz</h1>
          <p className="muted" style={{ textAlign: 'center' }}>
            {t('אין כרגע חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.')}
          </p>
          <button
            className="btn primary"
            onClick={() => { setRestoring('restoring'); setRestoreToken((n) => n + 1) }}
          >
            {t('ניסיון חוזר')}
          </button>
        </div>
      </div>
    )
  }

  if (!player && (autoJoining || restoring)) {
    return (
      <div className="center-screen">
        <div className="card login-card">
          <h1 className="brand">NGG Quiz</h1>
          <div className="spinner" />
          <p className="muted" style={{ textAlign: 'center' }}>
            {restoring ? t('מתחברים מחדש למשחק...') : t('מצטרף...')}
          </p>
        </div>
      </div>
    )
  }

  if (!player) {
    const anonymousJoin = joinInfo?.pin === pin && quizFlags(joinInfo.quiz).anonymous
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
          {anonymousJoin ? (
            <p className="muted small no-margin">{t('הצטרפות אנונימית - אין צורך בכינוי.')}</p>
          ) : (
            <label>
              {t('כינוי')}
              <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
            </label>
          )}
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
        {/* the hidden nickname of an anonymous player is never shown, not even
            for the moment before the quiz settings arrive */}
        {quiz && !anonymous && <span className="chip">{player.nickname}</span>}
        {player.team && (
          <span className="chip" style={myTeamColor ? { background: myTeamColor } : undefined}>
            {player.team}
          </span>
        )}
        {scored && rankInfo && <span className="chip">{t("{score} נק'", { score: rankInfo.score })}</span>}
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
            {timeLimit && !myAnswer && <Countdown left={timeLeft ?? timeLimit} />}
          </div>
          {error && <div className="error-box">{error}</div>}
          {myAnswer ? (
            <div className="wait-note">
              <h1 className="stage-title">{t('התשובה נקלטה ✓')}</h1>
              <p className="stage-subtitle">{t('ממתינים לשאר המשתתפים...')}</p>
            </div>
          ) : timeUp ? (
            <div className="wait-note">
              <h1 className="stage-title">{t('הזמן נגמר ⏱')}</h1>
              <p className="stage-subtitle">{t('ממתינים לחשיפת התשובה...')}</p>
            </div>
          ) : (
            <>
              <h2 className="player-question">{currentQuestion.text}</h2>
              {sending && <p className="stage-subtitle sending-note">{t('שולחים את התשובה...')}</p>}

              {isMultiSelect(currentQuestion) && (
                <div className="multi-play">
                  <p className="multi-hint">{t('אפשר לבחור יותר מאפשרות אחת')}</p>
                  <div
                    className={`options-grid player multi${currentQuestion.options.length > 4 ? ' many' : ''}`}
                    role="group"
                  >
                    {currentQuestion.options.map((_, i) => {
                      const on = picked.includes(i)
                      return (
                        <button
                          className={`option-tile clickable color-${optionColor(currentQuestion, i)}${on ? ' picked' : ''}`}
                          style={{ '--i': i }}
                          key={i}
                          aria-pressed={on}
                          disabled={Boolean(sending)}
                          onClick={() => togglePicked(i)}
                        >
                          <span className="pick-box" aria-hidden="true">{on ? '✓' : ''}</span>
                          <span>{optionLabel(currentQuestion, i, t)}</span>
                        </button>
                      )
                    })}
                  </div>
                  <button
                    className="btn light xl multi-submit"
                    disabled={!picked.length || Boolean(sending)}
                    onClick={() => submitAnswer({ answer: { indexes: [...picked].sort((a, b) => a - b) } })}
                  >
                    {picked.length
                      ? t('שליחת התשובה ({count} נבחרו)', { count: picked.length })
                      : t('בחרו אפשרות אחת או יותר')}
                  </button>
                </div>
              )}

              {(hasCorrectOption(currentQuestion.qtype) || currentQuestion.qtype === 'poll') && !isMultiSelect(currentQuestion) && (
                <div
                  className={`options-grid player${currentQuestion.qtype === 'true_false' ? ' true-false' : ''}${currentQuestion.options.length > 4 ? ' many' : ''}`}
                >
                  {currentQuestion.options.map((_, i) => (
                    <button
                      className={`option-tile clickable color-${optionColor(currentQuestion, i)}${sending && sending.index !== i ? ' dimmed' : ''}`}
                      style={{ '--i': i }}
                      key={i}
                      disabled={Boolean(sending)}
                      onClick={() => submitAnswer({ answer_index: i }, i)}
                    >
                      <span className="shape">{OPTION_SHAPES[optionColor(currentQuestion, i)]}</span>
                      <span>{optionLabel(currentQuestion, i, t)}</span>
                    </button>
                  ))}
                </div>
              )}

              {currentQuestion.qtype === 'scale' && (
                <div className="scale-play">
                  <Scale
                    meta={currentQuestion.meta}
                    chosen={sending?.index}
                    onPick={(value) => submitAnswer({ answer_index: value }, value)}
                  />
                </div>
              )}

              {currentQuestion.qtype === 'word_cloud' && wordEntries(currentQuestion) > 1 && (() => {
                const max = wordEntries(currentQuestion)
                const full = words.length >= max
                return (
                  <div className="cloud-form multi">
                    <p className="multi-hint">
                      {t('אפשר לשלוח עד {count} מילים', { count: max })}
                      <span className="word-count">{words.length}/{max}</span>
                    </p>
                    {words.length > 0 && (
                      <ul className="word-chips">
                        {words.map((w) => (
                          <li className="word-chip" key={w.toLowerCase()}>
                            <span>{w}</span>
                            <button
                              type="button"
                              aria-label={t('הסרת "{word}"', { word: w })}
                              disabled={Boolean(sending)}
                              onClick={() => setWords((list) => list.filter((x) => x !== w))}
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!full && (
                      <form
                        className="word-add"
                        onSubmit={(e) => {
                          e.preventDefault()
                          addWord(max)
                        }}
                      >
                        <input
                          value={cloudText}
                          onChange={(e) => {
                            setCloudText(e.target.value)
                            setWordNote('')
                          }}
                          aria-describedby={wordNote ? 'word-note' : undefined}
                          maxLength={MAX_WORD_LENGTH}
                          placeholder={words.length ? t('מילה נוספת...') : t('הקלידו תשובה קצרה...')}
                          enterKeyHint="enter"
                          autoFocus
                        />
                        <button className="btn ghost light-ghost" disabled={!cloudText.trim() || Boolean(sending)}>
                          {t('+ הוספה')}
                        </button>
                      </form>
                    )}
                    {wordNote && <p className="word-note" id="word-note" role="status">{wordNote}</p>}
                    <button
                      className="btn light xl"
                      disabled={(!words.length && !cloudText.trim()) || Boolean(sending)}
                      onClick={() => sendWords(max)}
                    >
                      {t('שליחה ☁️')}
                    </button>
                  </div>
                )
              })()}

              {currentQuestion.qtype === 'word_cloud' && wordEntries(currentQuestion) === 1 && (
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
                  <button className="btn light xl" disabled={!cloudText.trim() || Boolean(sending)}>{t('שליחה ☁️')}</button>
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
                  <button
                    className="btn light xl"
                    disabled={Boolean(sending)}
                    onClick={() => submitAnswer({ answer: { order: rankOrder } })}
                  >
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
                    disabled={!tapPos || Boolean(sending)}
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
          {currentQuestion && ['poll', 'word_cloud', 'scale'].includes(currentQuestion.qtype) ? (
            <>
              <h1 className="stage-title">{!myAnswer || myAnswer.pending ? t('לא נקלטה תשובה הפעם') : t('תודה על השיתוף! 🙌')}</h1>
              <p className="stage-subtitle">{t('התוצאות מוצגות על המסך המוקרן.')}</p>
            </>
          ) : !myAnswer || myAnswer.pending ? (
            <h1 className="stage-title">{t('לא נקלטה תשובה הפעם 😅')}</h1>
          ) : myAnswer.is_correct ? (
            <>
              <h1 className="stage-title correct-text">
                {hasCorrectOption(currentQuestion?.qtype) ? t('נכון! 🎉') : t('מדויק! 🎯')}
              </h1>
              {scored && <p className="points-pop">{t('+{points} נקודות', { points: myAnswer.points })}</p>}
            </>
          ) : scored && myAnswer.points > 0 ? (
            <>
              <h1 className="stage-title correct-text">{t('כמעט! 👏')}</h1>
              <p className="points-pop">{t('+{points} נקודות', { points: myAnswer.points })}</p>
            </>
          ) : (
            <h1 className="stage-title wrong-text">{t('לא נכון הפעם 💪')}</h1>
          )}
          {currentQuestion?.explanation && (
            <div className="explain-box"><Explanation text={currentQuestion.explanation} lead="💡" /></div>
          )}
          {scored && rankInfo && currentQuestion && !['poll', 'word_cloud', 'scale'].includes(currentQuestion.qtype) && (
            <p className="stage-subtitle">{t('מקום {rank} מתוך {total}', { rank: rankInfo.rank, total: rankInfo.total })}</p>
          )}
        </div>
      )}

      {/* an unscored quiz never opens the leaderboard; if it ever did, the
          phone thanks the player instead of showing a rank it does not have */}
      {session.status === 'leaderboard' && !scored && (
        <div className="stage-inner" key={`l-${session.current_index}`}>
          <h1 className="stage-title">{t('תודה על השיתוף! 🙌')}</h1>
          <p className="stage-subtitle">{t('התוצאות מוצגות על המסך המוקרן.')}</p>
        </div>
      )}

      {session.status === 'leaderboard' && scored && (
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

      {session.status === 'finished' && survey && (
        <div className="stage-inner">
          <h1 className="stage-title">{t('תודה על השיתוף! 🙌')}</h1>
          <p className="stage-subtitle">{t('סיכום הסקר מוצג על המסך המוקרן.')}</p>
        </div>
      )}

      {session.status === 'finished' && !scored && !survey && (
        <div className="stage-inner">
          <h1 className="stage-title">{t('תודה על השיתוף! 🙌')}</h1>
          <p className="stage-subtitle">{t('התוצאות מוצגות על המסך המוקרן.')}</p>
        </div>
      )}

      {session.status === 'finished' && scored && (
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
