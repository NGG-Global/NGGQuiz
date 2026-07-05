import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export default function Library({ user }) {
  const [quizzes, setQuizzes] = useState(null)
  const [error, setError] = useState('')
  const [startingId, setStartingId] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error } = await supabase
        .from('quizzes')
        .select('id, owner_id, title, subtitle, updated_at, questions(count)')
        .order('updated_at', { ascending: false })
      if (cancelled) return
      if (error) setError('טעינת ספריית החידונים נכשלה.')
      else setQuizzes(data)
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

  async function signOut() {
    await supabase.auth.signOut()
  }

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

      {error && <div className="error-box">{error}</div>}

      {quizzes === null ? (
        <div className="spinner" />
      ) : quizzes.length === 0 ? (
        <div className="card empty-state">
          <p>הספרייה ריקה עדיין. צרו את החידון הראשון שלכם!</p>
        </div>
      ) : (
        <div className="quiz-grid">
          {quizzes.map((quiz) => {
            const count = quiz.questions?.[0]?.count ?? 0
            const isOwner = quiz.owner_id === user?.id
            return (
              <div className="card quiz-card" key={quiz.id}>
                <h3>{quiz.title}</h3>
                {quiz.subtitle && <p className="muted">{quiz.subtitle}</p>}
                <p className="muted small">{count} שאלות</p>
                <div className="row">
                  {isOwner && (
                    <button className="btn" onClick={() => navigate(`/edit/${quiz.id}`)}>
                      עריכה
                    </button>
                  )}
                  <button
                    className="btn primary"
                    disabled={count === 0 || startingId === quiz.id}
                    title={count === 0 ? 'אין שאלות בחידון' : ''}
                    onClick={() => startQuiz(quiz)}
                  >
                    {startingId === quiz.id ? 'מפעיל...' : 'הפעלה'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
