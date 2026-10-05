// Supabase caps every API read at 1,000 rows by default (the project's
// "Max rows" setting), and a capped read looks exactly like a complete one.
// fetchAll reads page after page until a page comes back short, so a
// session with thousands of answers is read in full.
//
// makeQuery must build a fresh query on every call (a query is sent once)
// and order it on columns that keep the order stable from page to page;
// without that, pages overlap and rows are skipped. If the project's max
// rows is ever lowered below PAGE_SIZE, lower PAGE_SIZE to match: a capped
// page would otherwise be taken for the last one.
export const PAGE_SIZE = 1000

export async function fetchAll(makeQuery, pageSize = PAGE_SIZE) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

// Adds rows to a list by id, keeping the copy already held. A refetch then
// only ever adds to what realtime delivered and never drops a row; answers
// and players are never deleted mid-session, so nothing goes stale.
export function mergeById(prev, rows) {
  if (!rows?.length) return prev
  const known = new Set(prev.map((r) => r.id))
  const fresh = rows.filter((r) => !known.has(r.id))
  return fresh.length ? [...prev, ...fresh] : prev
}
