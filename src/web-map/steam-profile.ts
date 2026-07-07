/**
 * Steam Web API 個人資料抓取（GetPlayerSummaries v2）。
 *
 * 只在 ENABLE_STEAM_PROFILE_SYNC + STEAM_WEB_API_KEY 都就緒時被呼叫；
 * 任何失敗一律回 null（呼叫端 touchSteamProfile 防 retry 風暴），
 * 絕不讓選配功能的網路故障影響綁定 / 登入主流程。
 */

const STEAM_API = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const FETCH_TIMEOUT_MS = 10_000;

// avatar URL 會被前端當 <img src> 渲染 —— 只收 Steam 官方頭像 CDN 的 https URL
// （defense-in-depth；CSP img-src 是第二道閘）。此清單必須與 server.ts 的 CSP
// img-src 完全一致，否則 regex 放行的 host 會被瀏覽器 CSP 擋成破圖。
// Steam 歷來在這幾個 avatars.* CDN 間輪替（GetPlayerSummaries 的 avatarfull）。
const AVATAR_HOST_RE =
  /^https:\/\/avatars\.(steamstatic|akamai\.steamstatic|cloudflare\.steamstatic|fastly\.steamstatic)\.com\//i;

export interface SteamProfile {
  persona: string | null;
  avatar: string | null;
}

interface PlayerSummary {
  steamid?: string;
  personaname?: string;
  avatarfull?: string;
}

/** 抓取單一 SteamID64 的暱稱與頭像。失敗（HTTP 錯誤 / timeout / 查無人）回 null。 */
export async function fetchSteamProfile(steamId: string, apiKey: string): Promise<SteamProfile | null> {
  if (!apiKey) return null;
  try {
    const url = `${STEAM_API}?${new URLSearchParams({ key: apiKey, steamids: steamId }).toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[STEAM PROFILE] GetPlayerSummaries HTTP ${String(res.status)}`);
      return null;
    }
    const body = (await res.json()) as { response?: { players?: PlayerSummary[] } };
    const player = body.response?.players?.find((p) => p.steamid === steamId);
    if (!player) return null;
    const persona = typeof player.personaname === 'string' && player.personaname ? player.personaname : null;
    const rawAvatar = typeof player.avatarfull === 'string' ? player.avatarfull : '';
    const avatar = AVATAR_HOST_RE.test(rawAvatar) ? rawAvatar : null;
    return { persona, avatar };
  } catch (err: unknown) {
    console.warn('[STEAM PROFILE] fetch failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
