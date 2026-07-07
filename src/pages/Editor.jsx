import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'

function blankQuestion() {
  return { text: '', options: ['', '', '', ''], correct_index: 0, explanation: '' }
}

export default function Editor({ user }) {
  const { quizId } = useParams()
  const isNew = quizId === 'new'
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [folderId, setFolderId] = useState('')
  const [folders, setFolders] = useState([])
  const [questions, setQuestions] = useState([blankQuestion()])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef(null)

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
      setQuestions(
        qs.length
          ? qs.map((q) => ({
              text: q.text,
              options: [...q.options, '', '', ''].slice(0, Math.max(q.options.length, 2)),
              correct_index: q.correct_index,
              explanation: q.explanation || '',
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

  async function uploadLogo(file) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('קובץ הלוגו גדול מדי (מקסימום 2MB).')
      return
    }
    setError('')
    setUploading(true)
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: upErr } = await supabase.storage.from('logos').upload(path, file)
    setUploading(false)
    if (upErr) {
      setError('העלאת הלוגו נכשלה. ודאו שהסכמה העדכנית הורצה ב-Supabase (bucket בשם logos).')
      return
    }
    const { data } = supabase.storage.from('logos').getPublicUrl(path)
    setLogoUrl(data.publicUrl)
  }

  function validate() {
    if (!title.trim()) return 'יש להזין כותרת לחידון.'
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q.text.trim()) return `שאלה ${i + 1}: חסר טקסט לשאלה.`
      const filled = q.options.map((o) => o.trim())
      const nonEmpty = filled.filter(Boolean)
      if (nonEmpty.length < 2) return `שאלה ${i + 1}: נדרשות לפחות שתי תשובות.`
      if (!filled[q.correct_index]) return `שאלה ${i + 1}: יש לסמן תשובה נכונה שאינה ריקה.`
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

    const quizFields = {
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      logo_url: logoUrl || null,
      folder_id: folderId || null,
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

    // rebuild questions: trim empty options and keep correct_index aligned
    const rows = questions.map((q, position) => {
      const kept = []
      let correct = 0
      q.options.forEach((opt, j) => {
        if (opt.trim()) {
          if (j === q.correct_index) correct = kept.length
          kept.push(opt.trim())
        }
      })
      return {
        quiz_id: id,
        position,
        text: q.text.trim(),
        options: kept,
        correct_index: correct,
        explanation: q.explanation.trim() || null,
      }
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

          <label>
            טקסט השאלה
            <input value={q.text} onChange={(e) => updateQuestion(i, { text: e.target.value })} />
          </label>

          <div className="options-edit">
            {q.options.map((opt, j) => (
              <div className={`option-edit color-${j} ${q.correct_index === j ? 'selected' : ''}`} key={j}>
                <button
                  type="button"
                  className={`correct-mark ${q.correct_index === j ? 'on' : ''}`}
                  title={q.correct_index === j ? 'זו התשובה הנכונה' : 'סמן כתשובה נכונה'}
                  onClick={() => updateQuestion(i, { correct_index: j })}
                >
                  ✓
                </button>
                <input
                  className="option-input"
                  value={opt}
                  placeholder={`מסיח ${j + 1}${j < 2 ? '' : ' (רשות)'}`}
                  onChange={(e) => updateOption(i, j, e.target.value)}
                />
                {q.correct_index === j && <span className="correct-label">נכונה</span>}
              </div>
            ))}
          </div>
          <p className="muted small">לחצו על ה-✓ כדי לסמן את התשובה הנכונה.</p>

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

      <button className="btn wide" onClick={() => setQuestions((qs) => [...qs, blankQuestion()])}>
        + הוספת שאלה
      </button>
    </div>
  )
}
