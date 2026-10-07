import { lazy, Suspense, useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase, isConfigured } from './supabaseClient'
import { useI18n } from './lib/i18n.js'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Play from './pages/Play.jsx'

// The participant screen is in the main bundle; the admin and projector
// screens load on demand. A phone scanning the QR code in a hall full of
// phones on one Wi-Fi then downloads only what it needs to join.
const Login = lazy(() => import('./pages/Login.jsx'))
const Library = lazy(() => import('./pages/Library.jsx'))
const Editor = lazy(() => import('./pages/Editor.jsx'))
const RunSetup = lazy(() => import('./pages/RunSetup.jsx'))
const Host = lazy(() => import('./pages/Host.jsx'))

const spinner = <div className="center-screen"><div className="spinner" /></div>

function SetupNotice() {
  const { t } = useI18n()
  return (
    <div className="center-screen">
      <div className="card" style={{ maxWidth: 560 }}>
        <h1>NGG Quiz</h1>
        <p>
          {t('המערכת עדיין לא חוברה ל-Supabase. יש להגדיר את משתני הסביבה')}
          <code> VITE_SUPABASE_URL </code>{t('ו-')}<code> VITE_SUPABASE_ANON_KEY </code>
          {t('(מקומית בקובץ')} <code>.env</code>{t(', ובדפלוי כ-GitHub Secrets) ולבנות מחדש.')}
        </p>
        <p>{t('הוראות מלאות בקובץ README.md.')}</p>
      </div>
    </div>
  )
}

function Protected({ session, ready, children }) {
  if (!ready) return spinner
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
    <ErrorBoundary>
      <HashRouter>
        <Suspense fallback={spinner}>
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
        </Suspense>
      </HashRouter>
    </ErrorBoundary>
  )
}
