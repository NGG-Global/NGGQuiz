import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { QUESTION_TYPES, TEAM_COLORS } from '../lib/questionTypes'

function blankQuestion(qtype = 'multiple_choice') {
  return {
    qtype,
    text: '',
    options: ['', '', '', ''],
    correct_index: 0,
    explanation: '',
    meta: {},
  }
}

const TYPE_LABEL = Object.fromEntries(QUESTION_TYPES.map((t) => [t.value, t.label]))

export default function Editor() {
  const { quizId } = useParams()
  const isNew = quizId === 'new'
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [folderId, setFolderId] = useState('')
  const [folders, setFolders] = useState([])
  const [teamsEnabled, setTeamsEnabled] = useState(false)
  const [teamMode, setTeamMode] = useState('manual')
  const [teams, setTeams] = useState(['', ''])
  const [questions, setQuestions] = useState([blankQuestion()])
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
        setError('טעינת החידון נכשלה.')
        setLoading(false)
        return
      }
      setTitle(quiz.title)
      setSubtitle(quiz.subtitle || '')
      setLogoUrl(quiz.logo_url || '')
      setFolderId(quiz.folder_id || '')
      setTeamsEnabled(quiz.teams_enabled || false)
      setTeamMode(quiz.team_mode || 'manual')
      setTeams(quiz.teams?.length ? quiz.teams : ['', ''])
      setQuestions(
        qs.length
          ? qs.map((q) => {
              const opts = q.options || []
              return {
                qtype: q.qtype || 'multiple_choice',
                text: q.text,
                options: [...opts, '', '', ''].slice(0, Math.max(opts.length, 2, 4)),
                correct_index: q.correct_index ?? 0,
                explanation: q.explanation || '',
                meta: q.meta || {},
              }
            })
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
    // a new question inherits the type of the previous question
    setQuestions((qs) => [...qs, blankQuestion(qs[qs.length - 1]?.qtype || 'multiple_choice')])
  }

  async function uploadToBucket(bucket, file) {
    if (!file) return null
    if (file.size > 3 * 1024 * 1024) {
      setError('הקובץ גדול מדי (מקסימום 3MB).')
      return null
    }
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file)
    if (upErr) {
      setError('העלאת הקובץ נכשלה. ודאו שהסכמה העדכנית הורצה ב-Supabase.')
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
    if (!title.trim()) return 'יש להזין כותרת לחידון.'
    if (teamsEnabled) {
      const names = teams.map((t) => t.trim()).filter(Boolean)
      if (names.length < 2) return 'מצב צוותים דורש לפחות שתי קבוצות עם שם.'
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
        return 'לכל קבוצה חייב להיות שם ייחודי.'
    }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const label = `שאלה ${i + 1}`
      if (!q.text.trim()) return `${label}: חסר טקסט לשאלה.`
      const filled = q.options.map((o) => o.trim())
      const nonEmpty = filled.filter(Boolean)
      if (q.qtype === 'multiple_choice') {
        if (nonEmpty.length < 2) return `${label}: נדרשות לפחות שתי תשובות.`
        if (!filled[q.correct_index]) return `${label}: יש לסמן תשובה נכונה שאינה ריקה.`
      }
      if (q.qtype === 'poll' && nonEmpty.length < 2) return `${label}: סקר דורש לפחות שתי אפשרויות.`
      if (q.qtype === 'ranking' && nonEmpty.length < 3) return `${label}: סדר נכון דורש לפחות שלושה פריטים.`
      if (q.qtype === 'hotspot') {
        if (!q.meta?.image_url) return `${label}: יש להעלות תמונה.`
        if (q.meta?.x == null || q.meta?.y == null) return `${label}: יש ללחוץ על התמונה כדי לסמן את הנקודה הנכונה.`
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
    const quizFields = {
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      logo_url: logoUrl || null,
      folder_id: folderId || null,
      teams_enabled: teamsEnabled,
      team_mode: teamMode,
      teams: teamsEnabled ? cleanTeams : null,
    }

    let id = quizId
    if (isNew) {
      const { data, error } = await supabase.from('quizzes').insert(quizFields).select('id').single()
      if (error) {
        setError('שמירת החידון נכשלה.')
        setSaving(false)
        return
      }
      id = data.id
    } else {
      const { error } = await supabase.from('quizzes').update(quizFields).eq('id', id)
      if (error) {
        setError('שמירת החידון נכשלה.')
        setSaving(false)
        return
      }
      await supabase.from('questions').delete().eq('quiz_id', id)
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
      if (q.qtype === 'poll' || q.qtype === 'ranking') {
        return { ...base, options: q.options.map((o) => o.trim()).filter(Boolean) }
      }
      if (q.qtype === 'hotspot') {
        return { ...base, meta: { image_url: q.meta.image_url, x: q.meta.x, y: q.meta.y } }
      }
      return base // word_cloud
    })

    const { error: insErr } = await supabase.from('questions').insert(rows)
    setSaving(false)
    if (insErr) {
      setError('שמירת השאלות נכשלה.')
      return
    }
    navigate('/')
  }

  if (loading) return <div className="center-screen"><div className="spinner" /></div>

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">NGG Quiz</h1>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={() => navigate('/')}>חזרה לספרייה</button>
        </div>
      </header>

      <div className="page-head">
        <h2>{isNew ? 'חידון חדש' : 'עריכת חידון'}</h2>
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? 'שומר...' : 'שמירה בספרייה'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <label>
          כותרת
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="לדוגמה: חידון בטיחות שנתי" />
        </label>
        <label>
          תת-כותרת
          <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="לדוגמה: מחלקת הנדסה, 2026" />
        </label>
        <label>
          תיקייה
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">ללא תיקייה</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>

        <div className="logo-field">
          <span className="field-title">לוגו הלקוח (יוצג במסך הפתיחה)</span>
          {logoUrl ? (
            <div className="logo-preview">
              <img src={logoUrl} alt="לוגו הלקוח" />
              <div className="row">
                <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                  החלפת לוגו
                </button>
                <button className="btn ghost danger" onClick={() => setLogoUrl('')}>הסרה</button>
              </div>
            </div>
          ) : (
            <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? 'מעלה...' : '+ העלאת לוגו'}
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

      <div className="card teams-card">
        <div className="row space-between">
          <div>
            <span className="field-title">מצב צוותים</span>
            <p className="muted small no-margin">שיוך משתתפים לקבוצות וניקוד קבוצתי מצטבר</p>
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
                שיוך ידני - כל משתתף בוחר קבוצה בהצטרפות
              </label>
              <label className="radio-line">
                <input type="radio" name="team-mode" checked={teamMode === 'random'} onChange={() => setTeamMode('random')} />
                שיוך אקראי - חלוקה אוטומטית מאוזנת
              </label>
            </div>
            {teams.map((t, i) => (
              <div className="row team-name-row" key={i}>
                <span className="dot big" style={{ background: TEAM_COLORS[i % TEAM_COLORS.length] }} />
                <input
                  value={t}
                  maxLength={24}
                  placeholder={`שם קבוצה ${i + 1}`}
                  onChange={(e) => setTeams((ts) => ts.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button
                  className="btn ghost danger"
                  disabled={teams.length <= 2}
                  title="הסרת קבוצה"
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
              + הוספת קבוצה
            </button>
          </div>
        )}
      </div>

      {questions.map((q, i) => (
        <div className="card question-card" key={i}>
          <div className="question-head">
            <h3>שאלה {i + 1}</h3>
            <div className="row">
              <button className="btn ghost" onClick={() => moveQuestion(i, -1)} disabled={i === 0} title="הזז למעלה">↑</button>
              <button className="btn ghost" onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} title="הזז למטה">↓</button>
              <button className="btn ghost danger" onClick={() => removeQuestion(i)} disabled={questions.length === 1} title="הסר שאלה">✕</button>
            </div>
          </div>

          <label className="inline-label">
            סוג השאלה:
            <select value={q.qtype} onChange={(e) => updateQuestion(i, { qtype: e.target.value })}>
              {QUESTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
              ))}
            </select>
          </label>

          <label>
            טקסט השאלה
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
                        title={q.correct_index === j ? 'זו התשובה הנכונה' : 'סמן כתשובה נכונה'}
                        onClick={() => updateQuestion(i, { correct_index: j })}
                      >
                        ✓
                      </button>
                    )}
                    <input
                      className="option-input"
                      value={opt}
                      placeholder={`${q.qtype === 'poll' ? 'אפשרות' : 'מסיח'} ${j + 1}${j < 2 ? '' : ' (רשות)'}`}
                      onChange={(e) => updateOption(i, j, e.target.value)}
                    />
                    {q.qtype === 'multiple_choice' && q.correct_index === j && (
                      <span className="correct-label">נכונה</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="muted small">
                {q.qtype === 'multiple_choice'
                  ? 'לחצו על ה-✓ כדי לסמן את התשובה הנכונה.'
                  : 'סקר - אין תשובה נכונה ואין ניקוד; המסך המוקרן יציג את ההתפלגות.'}
              </p>
            </>
          )}

          {q.qtype === 'word_cloud' && (
            <p className="muted small type-hint">
              ☁️ המשתתפים יקלידו תשובה חופשית קצרה, והמסך המוקרן יבנה ענן מילים חי.
              אין תשובה נכונה ואין ניקוד.
            </p>
          )}

          {q.qtype === 'ranking' && (
            <>
              <span className="field-title">הפריטים בסדר הנכון (מלמעלה למטה)</span>
              <div className="rank-edit">
                {q.options.map((opt, j) => (
                  <div className="rank-edit-row" key={j}>
                    <span className="rank-num">{j + 1}</span>
                    <input
                      value={opt}
                      placeholder={`פריט ${j + 1}${j < 3 ? '' : ' (רשות)'}`}
                      onChange={(e) => updateOption(i, j, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <p className="muted small">
                המשתתפים יקבלו את הפריטים בסדר מעורבב ויצטרכו לסדרם. ניקוד חלקי לפי קרבת הסדר לתשובה.
              </p>
            </>
          )}

          {q.qtype === 'hotspot' && (
            <div className="hotspot-edit">
              {q.meta?.image_url ? (
                <>
                  <div className="hotspot-frame" onClick={(e) => setHotspotTarget(i, e)}>
                    <img src={q.meta.image_url} alt="תמונת השאלה" draggable={false} />
                    {q.meta.x != null && (
                      <span className="hotspot-marker target" style={{ left: `${q.meta.x}%`, top: `${q.meta.y}%` }} />
                    )}
                  </div>
                  <p className="muted small">
                    {q.meta.x != null
                      ? 'הנקודה הנכונה סומנה. לחצו במקום אחר כדי לעדכן.'
                      : 'לחצו על התמונה כדי לסמן את הנקודה הנכונה.'}
                  </p>
                  <button className="btn" onClick={() => { imageTargetIndex.current = i; imageInput.current?.click() }}>
                    החלפת תמונה
                  </button>
                </>
              ) : (
                <button
                  className="btn"
                  disabled={uploadingImageFor === i}
                  onClick={() => { imageTargetIndex.current = i; imageInput.current?.click() }}
                >
                  {uploadingImageFor === i ? 'מעלה...' : '+ העלאת תמונה'}
                </button>
              )}
            </div>
          )}

          <label>
            הסבר לתשובה (רשות - יוצג בעת חשיפת התשובה)
            <textarea
              rows={2}
              value={q.explanation}
              onChange={(e) => updateQuestion(i, { explanation: e.target.value })}
              placeholder="לדוגמה: התשובה נכונה מפני ש..."
            />
          </label>
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
        + הוספת שאלה ({TYPE_LABEL[questions[questions.length - 1]?.qtype || 'multiple_choice']})
      </button>
    </div>
  )
}
