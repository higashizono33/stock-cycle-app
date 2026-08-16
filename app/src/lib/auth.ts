// Cognito Hosted UI login via the LINE OIDC identity provider, using the
// Authorization Code + PKCE flow (no client secret — this is a public SPA
// client). requirements.md §6「認証方式: LINEログイン連携」。

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI;

const STORAGE_KEY = 'stockcycle:auth:v1';
const VERIFIER_STORAGE_KEY = 'stockcycle:auth:pkce-verifier';

interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function loadTokens(): TokenSet | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenSet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function signOut(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** ログイン開始: Cognito Hosted UIへリダイレクトする。identity_providerを指定して
 * Cognito自前のIdP選択画面を飛ばし、直接LINEログインへ遷移させる。 */
export async function redirectToLogin(): Promise<void> {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
  const challenge = await generateCodeChallenge(verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid profile',
    redirect_uri: REDIRECT_URI,
    identity_provider: 'LINE',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`https://${COGNITO_DOMAIN}/oauth2/authorize?${params.toString()}`);
}

async function exchangeCodeForTokens(code: string): Promise<TokenSet> {
  const verifier = sessionStorage.getItem(VERIFIER_STORAGE_KEY) ?? '';
  sessionStorage.removeItem(VERIFIER_STORAGE_KEY);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id_token: string; access_token: string; refresh_token: string; expires_in: number };
  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken });
  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id_token: string; access_token: string; expires_in: number };
  return { idToken: json.id_token, accessToken: json.access_token, refreshToken, expiresAt: Date.now() + json.expires_in * 1000 };
}

// Authorization codes are single-use. React's StrictMode intentionally
// double-invokes effects in development, which would otherwise fire two
// concurrent exchanges for the same code — the second always fails with
// `invalid_grant`. This guard makes a second concurrent call join the
// first in-flight exchange instead of starting a new one.
let inFlightExchange: Promise<void> | null = null;

/** アプリ起動時にHosted UIからのリダイレクト(`?code=...`)を処理する。
 * 成功時はURLからcode/stateを取り除く。失敗時も呼び出し元がやり直せるよう
 * URLからcodeを取り除いてから例外を投げる(壊れたcodeで無限ループしないように)。*/
export async function handleRedirectCallback(): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return;

  if (inFlightExchange) {
    await inFlightExchange;
    return;
  }

  inFlightExchange = (async () => {
    try {
      const tokens = await exchangeCodeForTokens(code);
      saveTokens(tokens);
    } finally {
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      window.history.replaceState({}, '', url.toString());
    }
  })();

  try {
    await inFlightExchange;
  } finally {
    inFlightExchange = null;
  }
}

/**
 * API Gateway(HttpJwtAuthorizer)は `jwtAudience` を検証する。CognitoのAccess
 * TokenにはOIDC標準の`aud`クレームが無い(`client_id`のみ)ため、`aud`を持つ
 * ID Tokenの方をBearerトークンとして使う。
 */
export async function getValidIdToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  if (Date.now() < tokens.expiresAt - 30_000) return tokens.idToken;

  try {
    const refreshed = await refreshTokens(tokens.refreshToken);
    saveTokens(refreshed);
    return refreshed.idToken;
  } catch {
    signOut();
    return null;
  }
}

export function isSignedIn(): boolean {
  return loadTokens() !== null;
}
