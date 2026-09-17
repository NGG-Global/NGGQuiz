import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useI18n } from '../lib/i18n.js'
import LanguageToggle from '../components/LanguageToggle.jsx'

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

const FOLDER_COLORS = [
  '#7c3aed', '#2563eb', '#0d9488', '#16a34a',
  '#d97706', '#dc2626', '#db2777', '#64748b',
]
const DEFAULT_FOLDER_COLOR = '#64748b'

export default function Library({ user }) {
  const { t } = useI18n()
  const [quizzes, setQuizzes] = useState(null)
  const [folders, setFolders] = useState([])
  const [filter, setFilter] = useState('all') // 'all' | 'none' | folder id
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderColor, setNewFolderColor] = useState(FOLDER_COLORS[0])
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState(null)
  const [duplicatingId, setDuplicatingId] = useState(null)
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
      if (qErr || fErr) setError(t('טעינת ספריית החידונים נכשלה.'))
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
        setError(t('הפעלת החידון נכשלה. נסו שוב.'))
        break
      }
    }
    setStartingId(null)
  }

  async function createFolder(e) {
    e.preventDefault()
    const name = newFolderName.trim()
    if (!name) return
    const { data, error } = await supabase
      .from('folders')
      .insert({ name, color: newFolderColor })
      .select()
      .single()
    if (error) {
      setError(t('יצירת התיקייה נכשלה.'))
      return
    }
    setFolders((fs) => [...fs, data].sort((a, b) => a.name.localeCompare(b.name, 'he')))
    setNewFolderName('')
    setNewFolderOpen(false)
    setFilter(data.id)
  }

  async function deleteFolder(folder) {
    const ok = window.confirm(
      t('למחוק את התיקייה "{name}"?\nהחידונים שבתוכה לא יימחקו - הם יועברו ל"ללא תיקייה".', { name: folder.name })
    )
    if (!ok) return
    const { error } = await supabase.from('folders').delete().eq('id', folder.id)
    if (error) {
      setError(t('מחיקת התיקייה נכשלה. ניתן למחוק רק תיקיות שיצרתם בעצמכם.'))
      return
    }
    setFolders((fs) => fs.filter((f) => f.id !== folder.id))
    setQuizzes((qs) => qs.map((q) => (q.folder_id === folder.id ? { ...q, folder_id: null } : q)))
    if (filter === folder.id) setFilter('all')
  }

  async function setFolderColor(folder, color) {
    const { error } = await supabase.from('folders').update({ color }).eq('id', folder.id)
    if (error) {
      setError(t('עדכון צבע התיקייה נכשל. ניתן לעדכן רק תיקיות שיצרתם בעצמכם.'))
      return
    }
    setFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, color } : f)))
  }

  async function duplicateQuiz(quiz) {
    setError('')
    setDuplicatingId(quiz.id)
    const { data: src } = await supabase
      .from('quizzes')
      .select('teams_enabled, team_mode, teams')
      .eq('id', quiz.id)
      .single()
    const { data: newQuiz, error } = await supabase
      .from('quizzes')
      .insert({
        title: `${quiz.title} (עותק)`,
        subtitle: quiz.subtitle,
        logo_url: quiz.logo_url,
        folder_id: quiz.folder_id,
        teams_enabled: src?.teams_enabled ?? false,
        team_mode: src?.team_mode ?? 'manual',
        teams: src?.teams ?? null,
      })
      .select('id, owner_id, folder_id, title, subtitle, logo_url, updated_at')
      .single()
    if (error) {
      setError(t('שכפול החידון נכשל.'))
      setDuplicatingId(null)
      return
    }
    const { data: qs, error: qErr } = await supabase
      .from('questions')
      .select('position, qtype, text, options, correct_index, meta, explanation, time_limit')
      .eq('quiz_id', quiz.id)
    let copied = 0
    if (!qErr && qs?.length) {
      const { error: insErr } = await supabase
        .from('questions')
        .insert(qs.map((q) => ({ ...q, quiz_id: newQuiz.id })))
      if (insErr) setError(t('החידון שוכפל, אך העתקת השאלות נכשלה. פתחו את העותק לעריכה.'))
      else copied = qs.length
    }
    setQuizzes((list) => [{ ...newQuiz, questions: [{ count: copied }] }, ...list])
    setDuplicatingId(null)
  }

  async function moveQuiz(quiz, folderId) {
    const { error } = await supabase.from('quizzes').update({ folder_id: folderId }).eq('id', quiz.id)
    if (error) {
      setError(t('העברת החידון נכשלה.'))
      return
    }
    setQuizzes((qs) => qs.map((q) => (q.id === quiz.id ? { ...q, folder_id: folderId } : q)))
  }

  async function deleteQuiz(quiz) {
    const ok = window.confirm(
      t('למחוק את החידון "{name}"?\nיימחקו גם השאלות וכל תוצאות המפגשים שהופעלו ממנו. פעולה זו אינה ניתנת לשחזור.', { name: quiz.title })
    )
    if (!ok) return
    const { error } = await supabase.from('quizzes').delete().eq('id', quiz.id)
    if (error) {
      setError(t('מחיקת החידון נכשלה. ניתן למחוק רק חידונים שיצרתם בעצמכם.'))
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
  const folderOf = (id) => folders.find((f) => f.id === id)
  const activeFolder = folders.find((f) => f.id === filter)

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="brand">NGG Quiz</h1>
        <div className="topbar-actions">
          <LanguageToggle />
          <span className="muted">{user?.email}</span>
          <button className="btn ghost" onClick={signOut}>{t('יציאה')}</button>
        </div>
      </header>

      <div className="page-head">
        <h2>{t('ספריית החידונים')}</h2>
        <button className="btn primary" onClick={() => navigate('/edit/new')}>
          {t('+ חידון חדש')}
        </button>
      </div>

      <div className="folder-bar">
        <button className={`chip-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          {t('הכל')}
        </button>
        {folders.map((f) => {
          const color = f.color || DEFAULT_FOLDER_COLOR
          const isActive = filter === f.id
          return (
            <button
              key={f.id}
              className={`chip-btn ${isActive ? 'active' : ''}`}
              style={isActive ? { background: color, borderColor: color } : { borderColor: `${color}66` }}
              onClick={() => setFilter(f.id)}
            >
              <span className="dot" style={{ background: isActive ? '#fff' : color }} />
              {f.name}
              {f.owner_id === user?.id && (
                <span
                  className="chip-x"
                  title={t('מחיקת תיקייה')}
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteFolder(f)
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          )
        })}
        <button className={`chip-btn ${filter === 'none' ? 'active' : ''}`} onClick={() => setFilter('none')}>
          {t('ללא תיקייה')}
        </button>
        <button className="chip-btn new" onClick={() => setNewFolderOpen((v) => !v)}>
          {t('+ תיקייה חדשה')}
        </button>
      </div>

      {newFolderOpen && (
        <form className="row new-folder-form" onSubmit={createFolder}>
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder={t('שם התיקייה')}
            maxLength={40}
            autoFocus
          />
          <div className="row swatch-row">
            {FOLDER_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${newFolderColor === c ? 'on' : ''}`}
                style={{ background: c }}
                title={t('בחירת צבע')}
                onClick={() => setNewFolderColor(c)}
              />
            ))}
          </div>
          <button className="btn primary">{t('יצירה')}</button>
        </form>
      )}

      {activeFolder && activeFolder.owner_id === user?.id && (
        <div className="row color-row">
          <span className="muted small">{t('צבע התיקייה:')}</span>
          <div className="row swatch-row">
            {FOLDER_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${(activeFolder.color || DEFAULT_FOLDER_COLOR) === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => setFolderColor(activeFolder, c)}
              />
            ))}
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      {visible === null ? (
        <div className="spinner" />
      ) : visible.length === 0 ? (
        <div className="card empty-state">
          <p>{filter === 'all' ? t('הספרייה ריקה עדיין. צרו את החידון הראשון שלכם!') : t('אין חידונים בתיקייה זו.')}</p>
        </div>
      ) : (
        <div className="quiz-grid">
          {visible.map((quiz) => {
            const count = quiz.questions?.[0]?.count ?? 0
            const isOwner = quiz.owner_id === user?.id
            return (
              <div className="card quiz-card" key={quiz.id}>
                {quiz.logo_url && <img className="quiz-logo-thumb" src={quiz.logo_url} alt={t('לוגו הלקוח')} />}
                <h3>{quiz.title}</h3>
                {quiz.subtitle && <p className="muted">{quiz.subtitle}</p>}
                <p className="muted small">
                  {t('{count} שאלות', { count })}
                  {filter === 'all' && quiz.folder_id && folderOf(quiz.folder_id) && (
                    <span
                      className="folder-badge"
                      style={{
                        background: `${folderOf(quiz.folder_id).color || DEFAULT_FOLDER_COLOR}1f`,
                        color: folderOf(quiz.folder_id).color || DEFAULT_FOLDER_COLOR,
                      }}
                    >
                      ● {folderOf(quiz.folder_id).name}
                    </span>
                  )}
                </p>
                <div className="row">
                  <button className="btn" onClick={() => navigate(`/edit/${quiz.id}`)}>
                    {t('עריכה')}
                  </button>
                  <button
                    className="btn primary"
                    disabled={count === 0 || startingId === quiz.id}
                    title={count === 0 ? t('אין שאלות בחידון') : ''}
                    onClick={() => startQuiz(quiz)}
                  >
                    {startingId === quiz.id ? t('מפעיל...') : t('הפעלה')}
                  </button>
                </div>
                <div className="row card-manage">
                  <select
                    value={quiz.folder_id || ''}
                    onChange={(e) => moveQuiz(quiz, e.target.value || null)}
                    title={t('העברה לתיקייה')}
                  >
                    <option value="">{t('ללא תיקייה')}</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  <button
                    className="btn ghost"
                    disabled={duplicatingId === quiz.id}
                    title={t('יצירת עותק של החידון')}
                    onClick={() => duplicateQuiz(quiz)}
                  >
                    {duplicatingId === quiz.id ? t('משכפל...') : t('צור עותק')}
                  </button>
                  {isOwner && (
                    <button className="btn ghost danger" onClick={() => deleteQuiz(quiz)}>
                      {t('מחיקה')}
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
