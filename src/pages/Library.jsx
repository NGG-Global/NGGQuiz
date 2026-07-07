import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export default function Library({ user }) {
  const [quizzes, setQuizzes] = useState(null)
  const [folders, setFolders] = useState([])
  const [filter, setFilter] = useState('all') // 'all' | 'none' | folder id
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [{ data: qz, error: qErr }, { data: fs, error: fErr }] = await Promise.all([
        supabase
          .from('quizzes')
          .select('id, owner_id, folder_id, title, subtitle, logo_url, updated_at, questions(count)')
          .order('updated_at', { ascending: false }),
        supabase.from('folders').select('*').order('name'),
      ])
      if (cancelled) return
      if (qErr || fErr) setError('טעינת ספריית החידונים נכשלה.')
      else {
        setQuizzes(qz)
        setFolders(fs)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function startQuiz(quiz) {
    setStartingId(quiz.id)
    setError('')
    // retry a few times in the unlikely case of a PIN collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabase
        .from('game_sessions')
        .insert({ quiz_id: quiz.id, pin: generatePin() })
        .select('id')
        .single()
      if (!error) {
        navigate(`/run/${data.id}`)
        return
      }
      if (error.code !== '23505') {
        setError('הפעלת החידון נכשלה. נסו שוב.')
        break
      }
    }
    setStartingId(null)
  }

  async function createFolder(e) {
    e.preventDefault()
    const name = newFolderName.trim()
    if (!name) return
    const { data, error } = await supabase.from('folders').insert({ name }).select().single()
    if (error) {
      setError('יצירת התיקייה נכשלה.')
      return
    }
    setFolders((fs) => [...fs, data].sort((a, b) => a.name.localeCompare(b.name, 'he')))
    setNewFolderName('')
    setNewFolderOpen(false)
    setFilter(data.id)
  }

  async function deleteFolder(folder) {
    const ok = window.confirm(
      `למחוק את התיקייה "${folder.name}"?\nהחידונים שבתוכה לא יימחקו - הם יועברו ל"ללא תיקייה".`
    )
    if (!ok) return
    const { error } = await supabase.from('folders').delete().eq('id', folder.id)
    if (error) {
      setError('מחיקת התיקייה נכשלה. ניתן למחוק רק תיקיות שיצרתם בעצמכם.')
      return
    }
    setFolders((fs) => fs.filter((f) => f.id !== folder.id))
    setQuizzes((qs) => qs.map((q) => (q.folder_id === folder.id ? { ...q, folder_id: null } : q)))
    if (filter === folder.id) setFilter('all')
  }

  async function moveQuiz(quiz, folderId) {
    const { error } = await supabase.from('quizzes').update({ folder_id: folderId }).eq('id', quiz.id)
    if (error) {
      setError('העברת החידון נכשלה.')
      return
    }
    setQuizzes((qs) => qs.map((q) => (q.id === quiz.id ? { ...q, folder_id: folderId } : q)))
  }

  async function deleteQuiz(quiz) {
    const ok = window.confirm(
      `למחוק את החידון "${quiz.title}"?\nיימחקו גם השאלות וכל תוצאות המפגשים שהופעלו ממנו. פעולה זו אינה ניתנת לשחזור.`
    )
    if (!ok) return
    const { error } = await supabase.from('quizzes').delete().eq('id', quiz.id)
    if (error) {
      setError('מחיקת החידון נכשלה. ניתן למחוק רק חידונים שיצרתם בעצמכם.')
      return
    }
    setQuizzes((qs) => qs.filter((q) => q.id !== quiz.id))
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  const visible =
    quizzes === null
      ? null
      : quizzes.filter((q) =>
          filter === 'all' ? true : filter === 'none' ? !q.folder_id : q.folder_id === filter
        )
  const folderName = (id) => folders.find((f) => f.id === id)?.name

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">NGG Quiz</h1>
        <div className="topbar-actions">
          <span className="muted">{user?.email}</span>
          <button className="btn ghost" onClick={signOut}>יציאה</button>
        </div>
      </header>

      <div className="page-head">
        <h2>ספריית החידונים</h2>
        <button className="btn primary" onClick={() => navigate('/edit/new')}>
          + חידון חדש
        </button>
      </div>

      <div className="folder-bar">
        <button className={`chip-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          הכל
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            className={`chip-btn ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            📁 {f.name}
            {f.owner_id === user?.id && (
              <span
                className="chip-x"
                title="מחיקת תיקייה"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteFolder(f)
                }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
        <button className={`chip-btn ${filter === 'none' ? 'active' : ''}`} onClick={() => setFilter('none')}>
          ללא תיקייה
        </button>
        <button className="chip-btn new" onClick={() => setNewFolderOpen((v) => !v)}>
          + תיקייה חדשה
        </button>
      </div>

      {newFolderOpen && (
        <form className="row new-folder-form" onSubmit={createFolder}>
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="שם התיקייה"
            maxLength={40}
            autoFocus
          />
          <button className="btn primary">יצירה</button>
        </form>
      )}

      {error && <div className="error-box">{error}</div>}

      {visible === null ? (
        <div className="spinner" />
      ) : visible.length === 0 ? (
        <div className="card empty-state">
          <p>{filter === 'all' ? 'הספרייה ריקה עדיין. צרו את החידון הראשון שלכם!' : 'אין חידונים בתיקייה זו.'}</p>
        </div>
      ) : (
        <div className="quiz-grid">
          {visible.map((quiz) => {
            const count = quiz.questions?.[0]?.count ?? 0
            const isOwner = quiz.owner_id === user?.id
            return (
              <div className="card quiz-card" key={quiz.id}>
                {quiz.logo_url && <img className="quiz-logo-thumb" src={quiz.logo_url} alt="לוגו הלקוח" />}
                <h3>{quiz.title}</h3>
                {quiz.subtitle && <p className="muted">{quiz.subtitle}</p>}
                <p className="muted small">
                  {count} שאלות
                  {filter === 'all' && quiz.folder_id && folderName(quiz.folder_id) && (
                    <span className="folder-badge">📁 {folderName(quiz.folder_id)}</span>
                  )}
                </p>
                <div className="row">
                  <button className="btn" onClick={() => navigate(`/edit/${quiz.id}`)}>
                    עריכה
                  </button>
                  <button
                    className="btn primary"
                    disabled={count === 0 || startingId === quiz.id}
                    title={count === 0 ? 'אין שאלות בחידון' : ''}
                    onClick={() => startQuiz(quiz)}
                  >
                    {startingId === quiz.id ? 'מפעיל...' : 'הפעלה'}
                  </button>
                </div>
                <div className="row card-manage">
                  <select
                    value={quiz.folder_id || ''}
                    onChange={(e) => moveQuiz(quiz, e.target.value || null)}
                    title="העברה לתיקייה"
                  >
                    <option value="">ללא תיקייה</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  {isOwner && (
                    <button className="btn ghost danger" onClick={() => deleteQuiz(quiz)}>
                      מחיקה
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
