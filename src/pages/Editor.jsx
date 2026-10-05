import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { QUESTION_TYPES, TEAM_COLORS, TRUE_FALSE_OPTIONS } from '../lib/questionTypes'
import { MAX_OPTIONS, MIN_OPTIONS, MIN_RANKING_OPTIONS, DEFAULT_OPTIONS, optionColor } from '../lib/optionStyle'
import { TIMER_PRESETS } from '../lib/timer'
import { SURVEY_TYPES, SCALE_PRESETS, DEFAULT_SCALE, scalePoints } from '../lib/survey'
import { useI18n } from '../lib/i18n.js'

function blankQuestion(qtype = 'multiple_choice', timeLimit = null) {
  const trueFalse = qtype === 'true_false'
  return {
    qtype,
    text: '',
    options: trueFalse ? [...TRUE_FALSE_OPTIONS] : Array(DEFAULT_OPTIONS).fill(''),
    // a true/false question starts unmarked, so its answer is always one the
    // author chose rather than a default nobody noticed
    correct_index: trueFalse ? null : 0,
    explanation: '',
    time_limit: timeLimit,
    meta: qtype === 'scale' ? { ...DEFAULT_SCALE } : {},
  }
}

// ordering three items is the smallest ranking worth asking for; every other
// type needs two answers
function minOptions(qtype) {
  return qtype === 'ranking' ? MIN_RANKING_OPTIONS : MIN_OPTIONS
}

// Rows the editor shows: every saved answer, padded out to the default four
// so there is room to type without adding rows first.
function optionRows(saved) {
  const opts = saved || []
  const rows = Math.max(opts.length, DEFAULT_OPTIONS)
  return Array.from({ length: rows }, (_, i) => opts[i] || '')
}

// the longest explanation the live answer slide is sure to fit on one screen
const EXPLANATION_ADVISED_LENGTH = 250

const TYPE_LABEL = Object.fromEntries(
  [...QUESTION_TYPES, ...SURVEY_TYPES].map((t) => [t.value, t.label])
)

export default function Editor() {
  const { t } = useI18n()
  const { quizId } = useParams()
  const isNew = quizId === 'new'
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // a survey is created from the library's menu (/edit/new?kind=survey), and
  // so is a live quiz (/edit/new?mode=live: unscored, anonymous join, a
  // true/false question to start); an existing quiz carries its kind and
  // settings on the row
  const presetSurvey = isNew && searchParams.get('kind') === 'survey'
  const presetLive = isNew && !presetSurvey && searchParams.get('mode') === 'live'
  const [kind, setKind] = useState(presetSurvey ? 'survey' : 'quiz')
  const survey = kind === 'survey'
  const questionTypes = survey ? SURVEY_TYPES : QUESTION_TYPES
  const [scored, setScored] = useState(!presetLive)
  const [anonymous, setAnonymous] = useState(presetLive)
  const live = !survey && !scored

  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [folderId, setFolderId] = useState('')
  const [folders, setFolders] = useState([])
  const [teamsEnabled, setTeamsEnabled] = useState(false)
  const [teamMode, setTeamMode] = useState('manual')
  const [teams, setTeams] = useState(['', ''])
  const [questions, setQuestions] = useState(() =>
    [blankQuestion(presetSurvey ? 'scale' : presetLive ? 'true_false' : 'multiple_choice')]
  )
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadingImageFor, setUploadingImageFor] = useState(null)
  const [error, setError] = useState('')
  const fileInput = useRef(null)
  const imageInput = useRef(null)
  const imageTargetIndex = useRef(null)

  useEffect(() => {
    let cancelled = false
    supabase.from('folders').select('id, name').order('name').then(({ data }) => {
      if (!cancelled && data) setFolders(data)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    async function load() {
      const [{ data: quiz, error: qErr }, { data: qs, error: qsErr }] = await Promise.all([
        supabase.from('quizzes').select('*').eq('id', quizId).single(),
        supabase.from('questions').select('*').eq('quiz_id', quizId).order('position'),
      ])
      if (cancelled) return
      if (qErr || qsErr) {
        setError(t('טעינת החידון נכשלה.'))
        setLoading(false)
        return
      }
      setKind(quiz.kind || 'quiz')
      setTitle(quiz.title)
      setSubtitle(quiz.subtitle || '')
      setLogoUrl(quiz.logo_url || '')
      setFolderId(quiz.folder_id || '')
      setScored(quiz.scored !== false)
      setAnonymous(quiz.anonymous === true)
      setTeamsEnabled(quiz.teams_enabled || false)
      setTeamMode(quiz.team_mode || 'manual')
      setTeams(quiz.teams?.length ? quiz.teams : ['', ''])
      setQuestions(
        qs.length
          ? qs.map((q) => ({
              qtype: q.qtype || 'multiple_choice',
              text: q.text,
              options: q.qtype === 'true_false' ? [...TRUE_FALSE_OPTIONS] : optionRows(q.options),
              correct_index: q.qtype === 'true_false' ? (q.correct_index ?? null) : (q.correct_index ?? 0),
              explanation: q.explanation || '',
              time_limit: q.time_limit ?? null,
              meta: q.meta || {},
            }))
          : [blankQuestion()]
      )
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [quizId, isNew])

  function updateQuestion(index, patch) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  }

  function updateOption(qIndex, oIndex, value) {
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qIndex ? { ...q, options: q.options.map((o, j) => (j === oIndex ? value : o)) } : q
      )
    )
  }

  // switching type can raise the floor (ranking needs three items), so top the
  // rows up rather than leaving the question short of its own minimum
  function changeType(index, qtype) {
    setQuestions((qs) =>
      qs.map((current, i) => {
        if (i !== index) return current
        if (qtype === 'true_false') {
          // its two answers are fixed; which one is right is still the author's call
          return { ...current, qtype, options: [...TRUE_FALSE_OPTIONS], correct_index: null }
        }
        // leaving true/false: its fixed answers are not text the author wrote,
        // so start from blank rows
        const q = current.qtype === 'true_false'
          ? { ...current, options: Array(DEFAULT_OPTIONS).fill(''), correct_index: 0 }
          : current
        const missing = Math.max(0, minOptions(qtype) - q.options.length)
        const meta = qtype === 'scale' ? { ...DEFAULT_SCALE, ...q.meta } : q.meta
        return { ...q, qtype, meta, options: [...q.options, ...Array(missing).fill('')] }
      })
    )
  }

  function addOption(qIndex) {
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qIndex && q.options.length < MAX_OPTIONS ? { ...q, options: [...q.options, ''] } : q
      )
    )
  }

  function removeOption(qIndex, oIndex) {
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qIndex || q.options.length <= minOptions(q.qtype)) return q
        const options = q.options.filter((_, j) => j !== oIndex)
        // keep the mark on the same answer; if that answer is the one being
        // removed, fall back to the first
        let correct = q.correct_index
        if (oIndex < correct) correct -= 1
        else if (oIndex === correct) correct = 0
        return { ...q, options, correct_index: Math.min(correct, options.length - 1) }
      })
    )
  }

  function moveQuestion(index, delta) {
    setQuestions((qs) => {
      const target = index + delta
      if (target < 0 || target >= qs.length) return qs
      const next = [...qs]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function removeQuestion(index) {
    setQuestions((qs) => (qs.length > 1 ? qs.filter((_, i) => i !== index) : qs))
  }

  function addQuestion() {
    // a new question inherits the type and the timer of the previous question
    setQuestions((qs) => {
      const prev = qs[qs.length - 1]
      const fallback = survey ? 'scale' : 'multiple_choice'
      return [...qs, blankQuestion(prev?.qtype || fallback, prev?.time_limit ?? null)]
    })
  }

  // live mode usually runs with anonymous join, so choosing it turns that on;
  // the author can still switch it off
  function chooseScored(next) {
    setScored(next)
    if (!next) setAnonymous(true)
  }

  function applyTimerToAll(limit) {
    setQuestions((qs) => qs.map((q) => ({ ...q, time_limit: limit })))
  }

  async function uploadToBucket(bucket, file) {
    if (!file) return null
    if (file.size > 3 * 1024 * 1024) {
      setError(t('הקובץ גדול מדי (מקסימום 3MB).'))
      return null
    }
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file)
    if (upErr) {
      setError(t('העלאת הקובץ נכשלה. ודאו שהסכמה העדכנית הורצה ב-Supabase.'))
      return null
    }
    return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
  }

  async function uploadLogo(file) {
    setError('')
    setUploading(true)
    const url = await uploadToBucket('logos', file)
    setUploading(false)
    if (url) setLogoUrl(url)
  }

  async function uploadQuestionImage(index, file) {
    setError('')
    setUploadingImageFor(index)
    const url = await uploadToBucket('media', file)
    setUploadingImageFor(null)
    if (url) {
      setQuestions((qs) =>
        qs.map((q, i) => (i === index ? { ...q, meta: { ...q.meta, image_url: url, x: null, y: null } } : q))
      )
    }
  }

  function setHotspotTarget(index, e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, meta: { ...q.meta, x, y } } : q)))
  }

  function validate() {
    if (!title.trim()) return t('יש להזין כותרת לחידון.')
    if (teamsEnabled && !live) {
      const names = teams.map((t) => t.trim()).filter(Boolean)
      if (names.length < 2) return t('מצב צוותים דורש לפחות שתי קבוצות עם שם.')
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
        return t('לכל קבוצה חייב להיות שם ייחודי.')
    }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const label = t('שאלה {number}', { number: i + 1 })
      if (!q.text.trim()) return `${label}: ${t('חסר טקסט לשאלה.')}`
      const filled = q.options.map((o) => o.trim())
      const nonEmpty = filled.filter(Boolean)
      if (q.qtype === 'multiple_choice') {
        if (nonEmpty.length < 2) return `${label}: ${t('נדרשות לפחות שתי תשובות.')}`
        if (!filled[q.correct_index]) return `${label}: ${t('יש לסמן תשובה נכונה שאינה ריקה.')}`
      }
      if (q.qtype === 'true_false' && ![0, 1].includes(q.correct_index))
        return `${label}: ${t('יש לסמן אם התשובה הנכונה היא "נכון" או "לא נכון".')}`
      if (q.qtype === 'poll' && nonEmpty.length < 2) return `${label}: ${t('סקר דורש לפחות שתי אפשרויות.')}`
      if (q.qtype === 'ranking' && nonEmpty.length < 3) return `${label}: ${t('סדר נכון דורש לפחות שלושה פריטים.')}`
      if (['multiple_choice', 'poll', 'ranking'].includes(q.qtype) && nonEmpty.length > MAX_OPTIONS)
        return `${label}: ${t('ניתן להגדיר עד {max} אפשרויות לשאלה.', { max: MAX_OPTIONS })}`
      if (q.qtype === 'scale') {
        if (scalePoints(q.meta).length < 2) return `${label}: ${t('יש לבחור טווח לסולם.')}`
        if (!(q.meta?.low_label || '').trim() || !(q.meta?.high_label || '').trim())
          return `${label}: ${t('יש לתת שם לשני קצות הסולם (למשל 1=לא מסכים, 5=מסכים).')}`
      }
      if (q.qtype === 'hotspot') {
        if (!q.meta?.image_url) return `${label}: ${t('יש להעלות תמונה.')}`
        if (q.meta?.x == null || q.meta?.y == null) return `${label}: ${t('יש ללחוץ על התמונה כדי לסמן את הנקודה הנכונה.')}`
      }
    }
    return ''
  }

  async function save() {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setSaving(true)

    const cleanTeams = teams.map((t) => t.trim()).filter(Boolean)
    // teams need a leaderboard and anonymous join needs its absence; the
    // database enforces both, so the switches the author can no longer see
    // are cleared here rather than rejected there
    const teamsOn = teamsEnabled && !live
    const quizFields = {
      kind,
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      logo_url: logoUrl || null,
      folder_id: folderId || null,
      teams_enabled: teamsOn,
      team_mode: teamMode,
      teams: teamsOn ? cleanTeams : null,
    }
    // the mode belongs to quizzes; a survey row keeps the column defaults
    if (!survey) {
      quizFields.scored = scored
      quizFields.anonymous = !scored && anonymous
    }

    let id = quizId
    let oldQuestionIds = []
    if (isNew) {
      const { data, error } = await supabase.from('quizzes').insert(quizFields).select('id').single()
      if (error) {
        setError(t('שמירת החידון נכשלה.'))
        setSaving(false)
        return
      }
      id = data.id
    } else {
      const { error } = await supabase.from('quizzes').update(quizFields).eq('id', id)
      if (error) {
        setError(t('שמירת החידון נכשלה.'))
        setSaving(false)
        return
      }
      // note the existing questions but keep them until the new ones are
      // safely stored (see below)
      const { data: existing, error: exErr } = await supabase.from('questions').select('id').eq('quiz_id', id)
      if (exErr) {
        setError(t('שמירת החידון נכשלה.'))
        setSaving(false)
        return
      }
      oldQuestionIds = (existing || []).map((q) => q.id)
    }

    const rows = questions.map((q, position) => {
      const base = {
        quiz_id: id,
        position,
        qtype: q.qtype,
        text: q.text.trim(),
        options: null,
        correct_index: null,
        meta: null,
        explanation: q.explanation.trim() || null,
        time_limit: q.time_limit || null,
      }
      if (q.qtype === 'multiple_choice') {
        const kept = []
        let correct = 0
        q.options.forEach((opt, j) => {
          if (opt.trim()) {
            if (j === q.correct_index) correct = kept.length
            kept.push(opt.trim())
          }
        })
        return { ...base, options: kept, correct_index: correct }
      }
      if (q.qtype === 'true_false') {
        return { ...base, options: [...TRUE_FALSE_OPTIONS], correct_index: q.correct_index }
      }
      if (q.qtype === 'poll' || q.qtype === 'ranking') {
        return { ...base, options: q.options.map((o) => o.trim()).filter(Boolean) }
      }
      if (q.qtype === 'scale') {
        return {
          ...base,
          meta: {
            min: Number(q.meta?.min ?? DEFAULT_SCALE.min),
            max: Number(q.meta?.max ?? DEFAULT_SCALE.max),
            low_label: (q.meta?.low_label || '').trim(),
            high_label: (q.meta?.high_label || '').trim(),
          },
        }
      }
      if (q.qtype === 'hotspot') {
        return { ...base, meta: { image_url: q.meta.image_url, x: q.meta.x, y: q.meta.y } }
      }
      return base // word_cloud
    })

    // the new questions are written BEFORE the old ones are removed: if the
    // write fails the stored quiz stays exactly as it was, instead of being
    // left without any questions at all
    const { data: inserted, error: insErr } = await supabase.from('questions').insert(rows).select('id')
    if (insErr) {
      setError(t('שמירת השאלות נכשלה. החידון השמור לא השתנה.'))
      setSaving(false)
      return
    }

    if (oldQuestionIds.length) {
      const { error: delErr } = await supabase.from('questions').delete().in('id', oldQuestionIds)
      if (delErr) {
        // undo the insert so the quiz is not left with duplicated questions
        await supabase.from('questions').delete().in('id', (inserted || []).map((q) => q.id))
        setError(t('שמירת השאלות נכשלה. החידון השמור לא השתנה.'))
        setSaving(false)
        return
      }
    }

    setSaving(false)
    navigate('/')
  }

  if (loading) return <div className="center-screen"><div className="spinner" /></div>

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">NGG Quiz</h1>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={() => navigate('/')}>{t('חזרה לספרייה')}</button>
        </div>
      </header>

      <div className="page-head">
        <h2>
          {survey
            ? (isNew ? t('סקר חדש') : t('עריכת סקר'))
            : live
              ? (isNew ? t('חידון חי חדש') : t('עריכת חידון חי'))
              : (isNew ? t('חידון חדש') : t('עריכת חידון'))}
        </h2>
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? t('שומר...') : t('שמירה בספרייה')}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <label>
          {t('כותרת')}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('לדוגמה: חידון בטיחות שנתי')} />
        </label>
        <label>
          {t('תת-כותרת')}
          <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder={t('לדוגמה: מחלקת הנדסה, 2026')} />
        </label>
        <label>
          {t('תיקייה')}
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">{t('ללא תיקייה')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>

        <div className="logo-field">
          <span className="field-title">{t('לוגו הלקוח (יוצג במסך הפתיחה)')}</span>
          {logoUrl ? (
            <div className="logo-preview">
              <img src={logoUrl} alt={t('לוגו הלקוח')} />
              <div className="row">
                <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                  {t('החלפת לוגו')}
                </button>
                <button className="btn ghost danger" onClick={() => setLogoUrl('')}>{t('הסרה')}</button>
              </div>
            </div>
          ) : (
            <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? t('מעלה...') : t('+ העלאת לוגו')}
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              uploadLogo(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {!survey && (
        <div className="card mode-card">
          <span className="field-title">{t('מצב החידון')}</span>
          <div className="mode-tabs" role="radiogroup" aria-label={t('מצב החידון')}>
            <button
              type="button"
              role="radio"
              aria-checked={scored}
              className={scored ? 'active' : ''}
              onClick={() => chooseScored(true)}
            >
              {t('עם ניקוד ותחרות')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!scored}
              className={!scored ? 'active' : ''}
              onClick={() => chooseScored(false)}
            >
              {t('ללא ניקוד – תוצאות בזמן אמת')}
            </button>
          </div>
          <p className="muted small mode-hint">
            {scored
              ? t('ניקוד לפי נכונות ומהירות, טבלת מובילים ופודיום בסיום.')
              : t('ללא ניקוד וללא טבלת מובילים: התוצאות עולות על המסך המוקרן בזמן שהמשתתפים עונים, ובחשיפה מוצגת התשובה הנכונה עם ההסבר.')}
          </p>
          {!scored && (
            <div className="row space-between mode-anonymous">
              <div>
                <span className="field-title">{t('כניסה אנונימית (בלי כינוי)')}</span>
                <p className="muted small no-margin">
                  {t('המשתתפים נכנסים ישירות מהקישור או מקוד ה-QR, ושמות אינם מוצגים בשום מקום.')}
                </p>
              </div>
              <label className="switch">
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                <span className="slider" />
              </label>
            </div>
          )}
        </div>
      )}

      {!survey && scored && (
      <div className="card teams-card">
        <div className="row space-between">
          <div>
            <span className="field-title">{t('מצב צוותים')}</span>
            <p className="muted small no-margin">{t('שיוך משתתפים לקבוצות וניקוד קבוצתי מצטבר')}</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={teamsEnabled} onChange={(e) => setTeamsEnabled(e.target.checked)} />
            <span className="slider" />
          </label>
        </div>

        {teamsEnabled && (
          <div className="teams-config">
            <div className="row team-mode-row">
              <label className="radio-line">
                <input type="radio" name="team-mode" checked={teamMode === 'manual'} onChange={() => setTeamMode('manual')} />
                {t('שיוך ידני - כל משתתף בוחר קבוצה בהצטרפות')}
              </label>
              <label className="radio-line">
                <input type="radio" name="team-mode" checked={teamMode === 'random'} onChange={() => setTeamMode('random')} />
                {t('שיוך אקראי - חלוקה אוטומטית מאוזנת')}
              </label>
            </div>
            {teams.map((name, i) => (
              <div className="row team-name-row" key={i}>
                <span className="dot big" style={{ background: TEAM_COLORS[i % TEAM_COLORS.length] }} />
                <input
                  value={name}
                  maxLength={24}
                  placeholder={t('שם קבוצה {number}', { number: i + 1 })}
                  onChange={(e) => setTeams((ts) => ts.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button
                  className="btn ghost danger"
                  disabled={teams.length <= 2}
                  title={t('הסרת קבוצה')}
                  onClick={() => setTeams((ts) => ts.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn"
              disabled={teams.length >= 6}
              onClick={() => setTeams((ts) => [...ts, ''])}
            >
              {t('+ הוספת קבוצה')}
            </button>
          </div>
        )}
      </div>
      )}

      {questions.map((q, i) => (
        <div className="card question-card" key={i}>
          <div className="question-head">
            <h3>{t('שאלה {number}', { number: i + 1 })}</h3>
            <div className="row">
              <button className="btn ghost" onClick={() => moveQuestion(i, -1)} disabled={i === 0} title={t('הזז למעלה')}>↑</button>
              <button className="btn ghost" onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} title={t('הזז למטה')}>↓</button>
              <button className="btn ghost danger" onClick={() => removeQuestion(i)} disabled={questions.length === 1} title={t('הסר שאלה')}>✕</button>
            </div>
          </div>

          <div className="question-config">
            <label className="inline-label">
              {t('סוג השאלה:')}
              <select value={q.qtype} onChange={(e) => changeType(i, e.target.value)}>
                {questionTypes.map((qt) => (
                  <option key={qt.value} value={qt.value}>{qt.icon} {t(qt.label)}</option>
                ))}
              </select>
            </label>
            <label className="inline-label">
              {t('הגבלת זמן:')}
              <select
                value={q.time_limit ?? ''}
                onChange={(e) => updateQuestion(i, { time_limit: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t('ללא הגבלת זמן')}</option>
                {TIMER_PRESETS.map((sec) => (
                  <option key={sec} value={sec}>⏱ {t('{seconds} שניות', { seconds: sec })}</option>
                ))}
              </select>
            </label>
          </div>

          <p className="muted small timer-hint">
            {q.time_limit
              ? t('⏱ השאלה תיסגר אוטומטית אחרי {seconds} שניות והתשובה תיחשף.', { seconds: q.time_limit })
              : t('ללא הגבלת זמן - המנחה חושף את התשובה בלחיצה.')}
            {questions.length > 1 && (
              <button type="button" className="link-btn" onClick={() => applyTimerToAll(q.time_limit ?? null)}>
                {t('החלה על כל השאלות')}
              </button>
            )}
          </p>

          <label>
            {t('טקסט השאלה')}
            <input value={q.text} onChange={(e) => updateQuestion(i, { text: e.target.value })} />
          </label>

          {(q.qtype === 'multiple_choice' || q.qtype === 'poll') && (
            <>
              <div className="options-edit">
                {q.options.map((opt, j) => (
                  <div
                    className={`option-edit color-${j} ${q.qtype === 'multiple_choice' && q.correct_index === j ? 'selected' : ''}`}
                    key={j}
                  >
                    {q.qtype === 'multiple_choice' && (
                      <button
                        type="button"
                        className={`correct-mark ${q.correct_index === j ? 'on' : ''}`}
                        title={q.correct_index === j ? t('זו התשובה הנכונה') : t('סמן כתשובה נכונה')}
                        onClick={() => updateQuestion(i, { correct_index: j })}
                      >
                        ✓
                      </button>
                    )}
                    <input
                      className="option-input"
                      value={opt}
                      placeholder={t(
                        q.qtype === 'poll'
                          ? (j < 2 ? 'אפשרות {number}' : 'אפשרות {number} (רשות)')
                          : (j < 2 ? 'מסיח {number}' : 'מסיח {number} (רשות)'),
                        { number: j + 1 }
                      )}
                      onChange={(e) => updateOption(i, j, e.target.value)}
                    />
                    {q.qtype === 'multiple_choice' && q.correct_index === j && (
                      <span className="correct-label">{t('נכונה')}</span>
                    )}
                    <button
                      type="button"
                      className="option-remove"
                      title={t(q.qtype === 'poll' ? 'הסרת אפשרות' : 'הסרת מסיח')}
                      disabled={q.options.length <= minOptions(q.qtype)}
                      onClick={() => removeOption(i, j)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="row options-actions">
                <button
                  className="btn"
                  disabled={q.options.length >= MAX_OPTIONS}
                  title={t('ניתן להגדיר עד {max} אפשרויות לשאלה.', { max: MAX_OPTIONS })}
                  onClick={() => addOption(i)}
                >
                  {t(q.qtype === 'poll' ? '+ הוספת אפשרות' : '+ הוספת מסיח')}
                </button>
                <span className="muted small option-count">{q.options.length}/{MAX_OPTIONS}</span>
              </div>
              <p className="muted small">
                {q.qtype === 'multiple_choice'
                  ? t('לחצו על ה-✓ כדי לסמן את התשובה הנכונה.')
                  : t('סקר - אין תשובה נכונה ואין ניקוד; המסך המוקרן יציג את ההתפלגות.')}
              </p>
            </>
          )}

          {q.qtype === 'true_false' && (
            <>
              <span className="field-title">{t('מהי התשובה הנכונה?')}</span>
              <div className={`tf-edit${[0, 1].includes(q.correct_index) ? ' marked' : ''}`}>
                {TRUE_FALSE_OPTIONS.map((opt, j) => (
                  <button
                    type="button"
                    key={j}
                    className={`tf-choice color-${optionColor(q, j)}${q.correct_index === j ? ' selected' : ''}`}
                    aria-pressed={q.correct_index === j}
                    onClick={() => updateQuestion(i, { correct_index: j })}
                  >
                    {q.correct_index === j && <span className="tf-check">✓</span>}
                    {t(opt)}
                  </button>
                ))}
              </div>
              <p className="muted small">
                {t('המשתתפים יבחרו "נכון" או "לא נכון". לחצו על התשובה הנכונה כדי לסמן אותה.')}
              </p>
            </>
          )}

          {q.qtype === 'scale' && (() => {
            const points = scalePoints(q.meta)
            const low = points[0]
            const high = points[points.length - 1]
            return (
              <div className="scale-edit">
                <label className="inline-label">
                  {t('טווח הסולם:')}
                  <select
                    value={`${low}-${high}`}
                    onChange={(e) => {
                      const [min, max] = e.target.value.split('-').map(Number)
                      updateQuestion(i, { meta: { ...q.meta, min, max } })
                    }}
                  >
                    {SCALE_PRESETS.map((preset) => (
                      <option key={`${preset.min}-${preset.max}`} value={`${preset.min}-${preset.max}`}>
                        {preset.min} – {preset.max}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="scale-ends">
                  <label>
                    {t('הקצה הנמוך ({value}=)', { value: low })}
                    <input
                      value={q.meta?.low_label || ''}
                      maxLength={30}
                      placeholder={t('לדוגמה: לא מסכים')}
                      onChange={(e) => updateQuestion(i, { meta: { ...q.meta, low_label: e.target.value } })}
                    />
                  </label>
                  <label>
                    {t('הקצה הגבוה ({value}=)', { value: high })}
                    <input
                      value={q.meta?.high_label || ''}
                      maxLength={30}
                      placeholder={t('לדוגמה: מסכים')}
                      onChange={(e) => updateQuestion(i, { meta: { ...q.meta, high_label: e.target.value } })}
                    />
                  </label>
                </div>

                <span className="field-title">{t('כך זה ייראה למשתתפים:')}</span>
                <div className="scale-preview">
                  {points.map((point) => (
                    <span className="scale-point" key={point}>{point}</span>
                  ))}
                </div>
                <div className="scale-preview-ends muted small">
                  <span>{q.meta?.low_label || t('לדוגמה: לא מסכים')}</span>
                  <span>{q.meta?.high_label || t('לדוגמה: מסכים')}</span>
                </div>
              </div>
            )
          })()}

          {q.qtype === 'word_cloud' && (
            <p className="muted small type-hint">
              {t('☁️ המשתתפים יקלידו תשובה חופשית קצרה, והמסך המוקרן יבנה ענן מילים חי. אין תשובה נכונה ואין ניקוד.')}
            </p>
          )}

          {q.qtype === 'ranking' && (
            <>
              <span className="field-title">{t('הפריטים בסדר הנכון (מלמעלה למטה)')}</span>
              <div className="rank-edit">
                {q.options.map((opt, j) => (
                  <div className="rank-edit-row" key={j}>
                    <span className="rank-num">{j + 1}</span>
                    <input
                      value={opt}
                      placeholder={t(j < 3 ? 'פריט {number}' : 'פריט {number} (רשות)', { number: j + 1 })}
                      onChange={(e) => updateOption(i, j, e.target.value)}
                    />
                    <button
                      className="btn ghost danger"
                      disabled={q.options.length <= minOptions(q.qtype)}
                      title={t('הסרת פריט')}
                      onClick={() => removeOption(i, j)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="row options-actions">
                <button
                  className="btn"
                  disabled={q.options.length >= MAX_OPTIONS}
                  title={t('ניתן להגדיר עד {max} אפשרויות לשאלה.', { max: MAX_OPTIONS })}
                  onClick={() => addOption(i)}
                >
                  {t('+ הוספת פריט')}
                </button>
                <span className="muted small option-count">{q.options.length}/{MAX_OPTIONS}</span>
              </div>
              <p className="muted small">
                {t('המשתתפים יקבלו את הפריטים בסדר מעורבב ויצטרכו לסדרם. ניקוד חלקי לפי קרבת הסדר לתשובה.')}
              </p>
            </>
          )}

          {q.qtype === 'hotspot' && (
            <div className="hotspot-edit">
              {q.meta?.image_url ? (
                <>
                  <div className="hotspot-frame" onClick={(e) => setHotspotTarget(i, e)}>
                    <img src={q.meta.image_url} alt={t('תמונת השאלה')} draggable={false} />
                    {q.meta.x != null && (
                      <span className="hotspot-marker target" style={{ left: `${q.meta.x}%`, top: `${q.meta.y}%` }} />
                    )}
                  </div>
                  <p className="muted small">
                    {q.meta.x != null
                      ? t('הנקודה הנכונה סומנה. לחצו במקום אחר כדי לעדכן.')
                      : t('לחצו על התמונה כדי לסמן את הנקודה הנכונה.')}
                  </p>
                  <button className="btn" onClick={() => { imageTargetIndex.current = i; imageInput.current?.click() }}>
                    {t('החלפת תמונה')}
                  </button>
                </>
              ) : (
                <button
                  className="btn"
                  disabled={uploadingImageFor === i}
                  onClick={() => { imageTargetIndex.current = i; imageInput.current?.click() }}
                >
                  {uploadingImageFor === i ? t('מעלה...') : t('+ העלאת תמונה')}
                </button>
              )}
            </div>
          )}

          {!survey && (
          <label>
            {t('הסבר לתשובה (רשות - יוצג בעת חשיפת התשובה)')}
            <textarea
              rows={4}
              value={q.explanation}
              onChange={(e) => updateQuestion(i, { explanation: e.target.value })}
              placeholder={t('לדוגמה: התשובה נכונה מפני ש...')}
            />
            {live && (
              <span className="muted small field-hint">
                {t('שורה שמתחילה במקף (-) תוצג כנקודה ברשימה.')}
                {/* the answer slide keeps a 24px floor for the hall, so a
                    long explanation can no longer fit on one screen */}
                {q.explanation.length > EXPLANATION_ADVISED_LENGTH && (
                  <span className="field-warning">
                    {' '}
                    {t('ההסבר ארוך ({count} תווים). מעל {max} תווים ייתכן שהשקופית לא תיכנס במסך אחד.', {
                      count: q.explanation.length,
                      max: EXPLANATION_ADVISED_LENGTH,
                    })}
                  </span>
                )}
              </span>
            )}
          </label>
          )}
        </div>
      ))}

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          uploadQuestionImage(imageTargetIndex.current, e.target.files?.[0])
          e.target.value = ''
        }}
      />

      <button className="btn wide" onClick={addQuestion}>
        {t('+ הוספת שאלה ({type})', { type: t(TYPE_LABEL[questions[questions.length - 1]?.qtype || 'multiple_choice']) })}
      </button>
    </div>
  )
}
