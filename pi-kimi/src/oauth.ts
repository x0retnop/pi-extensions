import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai"
import {
  API_BASE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_REFRESH_GRANT,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
} from "./constants.ts"
import { kimiHeaders } from "./headers.ts"

const REQUEST_TIMEOUT_MS = 120_000

type JsonRecord = Record<string, unknown>

export type DeviceAuth = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

export type KimiModelInfo = {
  id: string
  display_name?: string
  context_length?: number
}

export type KimiOAuthCredentials = OAuthCredentials & {
  wireModelId?: string
  modelDisplay?: string
  contextLength?: number
}

function formBody(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...kimiHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody(params),
      signal: controller.signal,
    })

    const text = await response.text()
    let json: JsonRecord = {}
    try {
      json = text ? (JSON.parse(text) as JsonRecord) : {}
    } catch {
      throw new Error(`kimi oauth: non-JSON response from ${url} (status ${response.status})`)
    }

    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error : response.status
      const description = typeof json.error_description === "string" ? json.error_description : text
      const error = new Error(`kimi oauth ${code}: ${description}`) as Error & { code?: string; status?: number }
      error.code = typeof json.error === "string" ? json.error : undefined
      error.status = response.status
      throw error
    }

    return json as T
  } finally {
    clearTimeout(timeout)
  }
}

export async function startDeviceAuth(): Promise<DeviceAuth> {
  return postForm<DeviceAuth>(OAUTH_DEVICE_AUTH_URL, {
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  })
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"))
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new Error("Login cancelled"))
      },
      { once: true },
    )
  })
}

export async function pollDeviceToken(device: DeviceAuth, signal?: AbortSignal): Promise<TokenResponse> {
  let intervalMs = Math.max(1, device.interval ?? 5) * 1000
  const deadline = Date.now() + device.expires_in * 1000

  while (Date.now() < deadline) {
    await sleep(intervalMs, signal)

    try {
      return await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code,
        grant_type: OAUTH_DEVICE_GRANT,
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        intervalMs += 5_000
        continue
      }
      if (code === "expired_token") throw new Error("kimi oauth: device code expired — run login again")
      throw error
    }
  }

  throw new Error("kimi oauth: device code expired before approval completed")
}

export async function refreshToken(refresh: string): Promise<TokenResponse> {
  return postForm<TokenResponse>(OAUTH_TOKEN_URL, {
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refresh,
    grant_type: OAUTH_REFRESH_GRANT,
  })
}

export async function listModels(accessToken: string): Promise<KimiModelInfo[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${API_BASE_URL}/models`, {
      headers: {
        ...kimiHeaders(),
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`kimi list-models ${response.status}: ${text.slice(0, 200)}`)
    }

    const json = JSON.parse(text) as { data?: unknown[] }
    const data = Array.isArray(json.data) ? json.data : []
    return data.filter((entry): entry is KimiModelInfo =>
      typeof entry === "object" && entry !== null && typeof (entry as KimiModelInfo).id === "string",
    )
  } finally {
    clearTimeout(timeout)
  }
}

export async function discoverModel(accessToken: string) {
  const models = await listModels(accessToken)
  const preferred = models.find((model) => model.id === "kimi-for-coding") ?? models[0]

  return {
    wireModelId: preferred?.id,
    modelDisplay: preferred?.display_name,
    contextLength: preferred?.context_length,
  }
}

export async function loginWithDeviceFlow(callbacks: OAuthLoginCallbacks): Promise<KimiOAuthCredentials> {
  const device = await startDeviceAuth()
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri
  const instructions = device.verification_uri_complete
    ? undefined
    : `Enter code: ${device.user_code}`

  callbacks.onAuth({
    url: verificationUrl,
    instructions,
  })

  const tokens = await pollDeviceToken(device, callbacks.signal)
  const discovery = await discoverModel(tokens.access_token).catch(() => ({}))

  return {
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
    ...discovery,
  }
}

export async function refreshKimiCredentials(credentials: OAuthCredentials): Promise<KimiOAuthCredentials> {
  const tokens = await refreshToken(credentials.refresh)
  const discovery = await discoverModel(tokens.access_token).catch(() => ({}))

  return {
    refresh: tokens.refresh_token || credentials.refresh,
    access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
    ...discovery,
  }
}
