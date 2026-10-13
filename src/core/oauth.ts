// OAuth 2.0 (installed-app loopback flow with PKCE) for Google and Microsoft accounts.
// Client IDs are supplied by the user in Settings → Accounts → OAuth, because
// Google/Microsoft tie them to a developer project that Octopus Mail does not own.
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { t } from '../shared/i18n'
import { getKV } from './settings'
import { getSecret, oauthSecretKey, setSecret } from './secrets'

export type OAuthProvider = 'google' | 'microsoft'

export interface OAuthClient {
  clientId: string
  clientSecret?: string
}

export interface OAuthTokens {
  provider: OAuthProvider
  access_token: string
  refresh_token?: string
  expires_at: number
  email?: string
  scope?: string
}

const ENDPOINTS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/contacts.readonly',
      'openid',
      'email',
      'profile',
    ],
  },
  microsoft: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
      'openid',
      'email',
    ],
  },
} as const

export function getOAuthClient(provider: OAuthProvider): OAuthClient | null {
  const cfg = getKV<OAuthClient | null>(`oauth.${provider}`, null)
  if (cfg?.clientId) return cfg
  const envId = provider === 'google' ? process.env.OCTO_GOOGLE_CLIENT_ID : process.env.OCTO_MS_CLIENT_ID
  if (envId) {
    return {
      clientId: envId,
      clientSecret: provider === 'google' ? process.env.OCTO_GOOGLE_CLIENT_SECRET : undefined,
    }
  }
  return null
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function decodeJwtEmail(idToken?: string): string | undefined {
  if (!idToken) return undefined
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'))
    return payload.email || payload.preferred_username
  } catch {
    return undefined
  }
}

/**
 * Starts the loopback flow. Returns the URL to open in the browser and a promise
 * that resolves with tokens once the user approves access.
 */
export async function startOAuth(
  provider: OAuthProvider,
  loginHint?: string,
  clientOverride?: OAuthClient | null,
): Promise<{ url: string; done: Promise<OAuthTokens> }> {
  // the desktop app connected to a home server runs the browser flow locally with the server's client ID
  const client = clientOverride?.clientId ? clientOverride : getOAuthClient(provider)
  if (!client) {
    throw new Error(
      provider === 'google'
        ? t('No Google OAuth Client ID. Settings → Accounts → OAuth: paste the Client ID and Secret from Google Cloud Console (type: Desktop app).')
        : t('No Microsoft OAuth Client ID. Settings → Accounts → OAuth: paste the Application (client) ID from Azure Portal.'),
    )
  }
  const ep = ENDPOINTS[provider]
  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))

  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/`

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ep.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (provider === 'google') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
  }
  if (loginHint) params.set('login_hint', loginHint)
  const url = `${ep.auth}?${params.toString()}`

  const done = new Promise<OAuthTokens>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error(t('OAuth sign-in timed out (10 min).')))
    }, 10 * 60_000)

    server.on('request', async (req, res) => {
      const u = new URL(req.url || '/', redirectUri)
      if (u.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const finish = (ok: boolean, msg: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<html><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? '✅' : '❌'} Octopus Mail</h2><p>${msg}</p><p>${t('You can close this window.')}</p></body></html>`,
        )
        clearTimeout(timer)
        server.close()
      }
      if (u.searchParams.get('state') !== state) {
        finish(false, t('Invalid state parameter.'))
        reject(new Error('OAuth state mismatch'))
        return
      }
      const err = u.searchParams.get('error')
      if (err) {
        finish(false, t('Access denied: {error}', { error: err }))
        reject(new Error(`OAuth: ${err}`))
        return
      }
      const code = u.searchParams.get('code')
      if (!code) {
        finish(false, t('No authorization code.'))
        reject(new Error('OAuth: no code'))
        return
      }
      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: client.clientId,
          code_verifier: verifier,
        })
        if (client.clientSecret) body.set('client_secret', client.clientSecret)
        const r = await fetch(ep.token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        })
        const j = (await r.json()) as Record<string, any>
        if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`)
        const tokens: OAuthTokens = {
          provider,
          access_token: j.access_token,
          refresh_token: j.refresh_token,
          expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
          email: decodeJwtEmail(j.id_token),
          scope: j.scope,
        }
        finish(true, tokens.email ? t('Signed in as {email}.', { email: tokens.email }) : t('Signed in.'))
        resolve(tokens)
      } catch (e) {
        finish(false, (e as Error).message)
        reject(e)
      }
    })
  })

  return { url, done }
}

export function saveTokens(accountId: number, tokens: OAuthTokens): void {
  setSecret(oauthSecretKey(accountId), JSON.stringify(tokens))
}

export function loadTokens(accountId: number): OAuthTokens | null {
  const raw = getSecret(oauthSecretKey(accountId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthTokens
  } catch {
    return null
  }
}

const refreshing = new Map<number, Promise<OAuthTokens>>()

/** Returns a valid access token, refreshing it when it is about to expire. */
export async function getAccessToken(accountId: number): Promise<string> {
  const tok = loadTokens(accountId)
  if (!tok) throw new Error(t('No OAuth token — sign in again in the account settings.'))
  if (tok.expires_at - Date.now() > 120_000) return tok.access_token
  if (!tok.refresh_token) throw new Error(t('The OAuth token has expired — sign in again.'))
  let p = refreshing.get(accountId)
  if (!p) {
    p = (async () => {
      const client = getOAuthClient(tok.provider)
      if (!client) throw new Error(t('OAuth Client ID is not configured.'))
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token!,
        client_id: client.clientId,
      })
      if (client.clientSecret) body.set('client_secret', client.clientSecret)
      const r = await fetch(ENDPOINTS[tok.provider].token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const j = (await r.json()) as Record<string, any>
      if (!r.ok) throw new Error(t('Refreshing the OAuth token failed: {error}', { error: j.error_description || j.error }))
      const next: OAuthTokens = {
        ...tok,
        access_token: j.access_token,
        refresh_token: j.refresh_token || tok.refresh_token,
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      }
      saveTokens(accountId, next)
      return next
    })().finally(() => refreshing.delete(accountId))
    refreshing.set(accountId, p)
  }
  return (await p).access_token
}
