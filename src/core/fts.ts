import { run } from './db'

// unicode61's remove_diacritics folds ą/ę/ó/ś/ż/ź/ć/ń but not "ł" (it has no Unicode decomposition),
// so we fold such letters ourselves on both the indexed text and the query.
const EXTRA: Record<string, string> = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ı: 'i' }
const EXTRA_RE = /[łŁøØđĐßæÆœŒı]/g

export function fold(s: string): string {
  return s.replace(EXTRA_RE, (c) => EXTRA[c] || c)
}

export function ftsPut(id: number, subject: string, people: string, body: string, files: string): void {
  run('DELETE FROM fts WHERE rowid = ?', id)
  run('INSERT INTO fts(rowid, subject, people, body, files) VALUES (?, ?, ?, ?, ?)', id, fold(subject), fold(people), fold(body.slice(0, 200_000)), fold(files))
}
