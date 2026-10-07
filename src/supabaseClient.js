import { createClient } from '@supabase/supabase-js'
import { reconnectAfterMs } from './lib/liveSync.js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isConfigured = Boolean(url && anonKey)

// reconnects after a hall-wide drop are spread out - see reconnectAfterMs
export const supabase = isConfigured
  ? createClient(url, anonKey, { realtime: { reconnectAfterMs } })
  : null
