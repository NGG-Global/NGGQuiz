// The Postgres schema that holds the quiz's tables and functions.
//
// The NGG apps share one Supabase project, each in a schema of its own
// (supabase/schema.sql). Every client and every Realtime subscription has to
// name it, or requests land on the empty `public` schema. Plain JavaScript
// with no imports, so the load simulator in scripts/ can use it too.

export const DB_SCHEMA = 'quiz'
