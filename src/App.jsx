import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase, isConfigured } from './supabaseClient'
import Login from './pages/Login.jsx'
import Library from './pages/Library.jsx'
import Editor from './pages/Editor.jsx'
import RunSetup from './pages/RunSetup.jsx'
import Host from './pages/Host.jsx'
import Play from './pages/Play.jsx'

function SetupNotice() {
  return (
    <div className="center-screen">
      <div className="card" style={{ maxWidth: 560 }}>
        <h1>NGG Quiz</h1>
        <p>
          המערכת עדיין לא חוברה ל-Supabase. יש להגדיר את משתני הסביבה
          <code> VITE_SUPABASE_URL </code>ו-<code> VITE_SUPABASE_ANON_KEY </code>
          (מקומית בקובץ <code>.env</code>, ובדפלוי כ-GitHub Secrets) ולבנות מחדש.
        </p>
        <p>הוראות מלאות בקובץ README.md.</p>
      </div>
    </div>
  )
}

function Protected({ session, ready, children }) {
  if (!ready) return <div className="center-screen"><div className="spinner" /></div>
  if (!session) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const [session, setSession] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!isConfigured) return <SetupNotice />

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login session={session} />} />
        <Route path="/play" element={<Play />} />
        <Route path="/play/:pin" element={<Play />} />
        <Route
          path="/"
          element={<Protected session={session} ready={ready}><Library user={session?.user} /></Protected>}
        />
        <Route
          path="/edit/:quizId"
          element={<Protected session={session} ready={ready}><Editor user={session?.user} /></Protected>}
        />
        <Route
          path="/run/:sessionId"
          element={<Protected session={session} ready={ready}><RunSetup /></Protected>}
        />
        <Route
          path="/host/:sessionId"
          element={<Protected session={session} ready={ready}><Host user={session?.user} /></Protected>}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
