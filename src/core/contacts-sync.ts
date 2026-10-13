// Google Contacts → local contact book (People API, read-only). Names, phones and companies
// from the user's address book fill the contacts table; those senders count as "accepted".
import { t } from '../shared/i18n'
import { getAccount, listAccounts } from './accounts'
import { now, run, tx } from './db'
import { bus, log } from './events'
import { getAccessToken } from './oauth'

const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me/connections'
const MAX_PAGES = 100

interface Meta {
  metadata?: { primary?: boolean }
}
interface Person {
  resourceName?: string
  etag?: string
  names?: (Meta & { displayName?: string })[]
  emailAddresses?: (Meta & { value?: string })[]
  phoneNumbers?: (Meta & { value?: string; canonicalForm?: string })[]
  organizations?: (Meta & { name?: string })[]
}

function primary<T extends Meta>(list: T[] | undefined): T | undefined {
  return list?.find((x) => x.metadata?.primary) ?? list?.[0]
}

const UPSERT = `INSERT INTO contacts(email, name, phone, company, status, source, remote_href, etag, updated_at)
  VALUES (?, ?, ?, ?, 'accepted', 'google', ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET
    name = CASE WHEN contacts.source = 'manual' AND COALESCE(contacts.name, '') != '' THEN contacts.name
                ELSE COALESCE(excluded.name, contacts.name) END,
    phone = COALESCE(excluded.phone, contacts.phone),
    company = COALESCE(excluded.company, contacts.company),
    status = CASE WHEN contacts.status = 'blocked' THEN 'blocked' ELSE 'accepted' END,
    source = CASE WHEN contacts.source = 'manual' THEN 'manual' ELSE 'google' END,
    remote_href = excluded.remote_href, etag = excluded.etag, updated_at = excluded.updated_at`

async function fetchConnections(token: string): Promise<Person[]> {
  const people: Person[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(PEOPLE_URL)
    u.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations')
    u.searchParams.set('pageSize', '1000')
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    let res: Response
    try {
      res = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    } catch (e) {
      throw new Error(t('No connection to Google Contacts: {error}', { error: (e as Error).message }))
    }
    if (res.status === 401) throw new Error(t('Google rejected the token — sign in to the account again (Settings → Accounts).'))
    if (res.status === 403) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(
        t('Google Contacts: access denied (HTTP 403){details}. Check that the People API is enabled in the Google Cloud project and that the account allows access to contacts.', {
          details: j?.error?.message ? ` — ${j.error.message}` : '',
        }),
      )
    }
    if (!res.ok) throw new Error(`Google Contacts: HTTP ${res.status}`)
    const j = (await res.json()) as { connections?: Person[]; nextPageToken?: string }
    people.push(...(j.connections || []))
    pageToken = j.nextPageToken
    if (!pageToken) break
  }
  return people
}

/** Import the Google address book of one OAuth account. Returns the number of addresses stored. */
export async function syncGoogleContacts(accountId: number): Promise<number> {
  const acc = getAccount(accountId)
  if (acc.auth !== 'oauth-google') throw new Error(t('Contact sync works only for Google accounts signed in with OAuth.'))
  const people = await fetchConnections(await getAccessToken(accountId))
  let n = 0
  tx(() => {
    const at = now()
    for (const p of people) {
      const emails = new Set(
        (p.emailAddresses || []).map((e) => (e.value || '').trim().toLowerCase()).filter((e) => e.includes('@') && !/\s/.test(e)),
      )
      if (!emails.size) continue
      const name = primary(p.names)?.displayName?.trim() || null
      const ph = primary(p.phoneNumbers)
      const phone = ph?.canonicalForm || ph?.value?.trim() || null
      const company = primary(p.organizations)?.name?.trim() || null
      for (const email of emails) {
        run(UPSERT, email, name, phone, company, p.resourceName ?? null, p.etag ?? null, at)
        n++
      }
    }
  })
  log('contacts', `Google contacts for ${acc.email}: ${n} address(es)`)
  if (n) bus.emitEvent({ type: 'contacts-changed' })
  return n
}

/** Sync every Google OAuth account; never throws (offline / revoked accounts are logged and skipped). */
export async function syncAllContacts(): Promise<number> {
  let total = 0
  let accounts
  try {
    accounts = listAccounts(false)
  } catch (e) {
    log('contacts', 'cannot list accounts:', (e as Error).message)
    return 0
  }
  for (const acc of accounts) {
    if (acc.auth !== 'oauth-google') continue
    try {
      total += await syncGoogleContacts(acc.id)
    } catch (e) {
      log('contacts', `Google contacts sync for ${acc.email} skipped:`, (e as Error).message)
    }
  }
  return total
}
