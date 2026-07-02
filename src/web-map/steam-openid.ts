/**
 * Steam OpenID 2.0 驗證模組（手刻、零外部依賴，全用原生 fetch）。
 *
 * Steam 只支援 OpenID 2.0 的 checkid_setup + check_authentication
 * （stateless / dumb mode）流程。本模組提供：
 *   - buildRedirectUrl(): 組出導向 Steam 登入頁的 URL
 *   - verifyAssertion(): 完整驗證 Steam 回跳的 assertion（含防重放）
 *   - isValidSteamId64(): SteamID64 格式 + 數值範圍檢查
 */

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

// SteamID64 個人帳號合法範圍（universe=1, type=1, instance=1）。
// 注意：不能只比對 7656119 前綴 —— accountId 持續增長，新帳號前綴
// 會變成 7656120（評審實證），故用 \d{17} + BigInt 數值範圍檢查。
const STEAM_ID64_MIN = 76561197960265728n;
const STEAM_ID64_MAX = 76561202255233023n;
const STEAM_ID64_RE = /^\d{17}$/;
// Steam 官方 claimed_id 歷史格式是 http://（passport-steam 也驗 https?）。
// scheme 只是識別字串、不是抓取 URL —— host/path 固定、id 由
// check_authentication 簽章背書，兩種 scheme 都收不弱化安全。
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// response_nonce 時戳容許偏差（雙向 5 分鐘）
const NONCE_WINDOW_MS = 5 * 60 * 1000;
// check_authentication 的 fetch timeout
const CHECK_AUTH_TIMEOUT_MS = 10_000;

// openid.signed 必須涵蓋的欄位（防止攻擊者拿部分簽章的 assertion 替換關鍵欄位）
const REQUIRED_SIGNED_FIELDS = ['claimed_id', 'identity', 'return_to', 'response_nonce', 'op_endpoint'];

// 程序內 nonce 單次使用記錄：nonce → 該 nonce 自帶的時戳（ms）。
// 每次驗證前先 prune 超窗 entry（超窗後重放會被時戳偏差檢查擋下，可安全移除），
// 避免只進不出無限增長。
// ponytail: in-process Map，多進程部署時需改共享儲存（目前 bot 單進程）
const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  for (const [nonce, ts] of seenNonces) {
    if (Math.abs(now - ts) > NONCE_WINDOW_MS) seenNonces.delete(nonce);
  }
}

/** SteamID64 格式（\d{17}）+ 數值範圍檢查，供 admin 手動綁定等處驗證輸入。 */
function isValidSteamId64(s: string): boolean {
  if (!STEAM_ID64_RE.test(s)) return false;
  const n = BigInt(s);
  return n >= STEAM_ID64_MIN && n <= STEAM_ID64_MAX;
}

/**
 * 組出導向 Steam OpenID 登入頁的 checkid_setup URL。
 * @param realmOrigin 信任範圍（origin，如 https://map.example.com）
 * @param returnTo    驗證完成後 Steam 回跳的完整 URL（須在 realm 之下）
 */
function buildRedirectUrl(realmOrigin: string, returnTo: string): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realmOrigin,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

type VerifyResult = { ok: true; steamId: string } | { ok: false; reason: string };

/**
 * 完整驗證 Steam OpenID 回跳的 assertion。
 * 呼叫端應先處理 mode=cancel（本函式收到 cancel 回 { ok:false, reason:'cancelled' }，
 * 呼叫端據此靜默 redirect 即可）。
 *
 * @param query            Express req.query（值可能被 HTTP parameter pollution 弄成陣列，本函式會拒絕）
 * @param expectedReturnTo 發起時使用的 return_to，必須完全一致
 */
async function verifyAssertion(query: Record<string, unknown>, expectedReturnTo: string): Promise<VerifyResult> {
  // 1. HTTP parameter pollution 防護：任何 openid.* 參數非純字串（重複參數
  //    在 Express 會變陣列）一律拒絕。
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.') && typeof v !== 'string') {
      return { ok: false, reason: 'invalid_params' };
    }
  }
  const p = (name: string): string | undefined => {
    const v = query[`openid.${name}`];
    return typeof v === 'string' ? v : undefined;
  };

  // 2. 使用者在 Steam 頁面按取消
  const mode = p('mode');
  if (mode === 'cancel') return { ok: false, reason: 'cancelled' };

  // 3. mode 與 op_endpoint 固定值
  if (mode !== 'id_res') return { ok: false, reason: 'bad_mode' };
  if (p('op_endpoint') !== STEAM_OPENID_ENDPOINT) return { ok: false, reason: 'bad_op_endpoint' };

  // 4. claimed_id === identity，且格式 + 數值範圍合法
  const claimedId = p('claimed_id');
  if (!claimedId || claimedId !== p('identity')) {
    return { ok: false, reason: 'claimed_id_mismatch' };
  }
  const steamId = CLAIMED_ID_RE.exec(claimedId)?.[1];
  if (!steamId) return { ok: false, reason: 'bad_claimed_id' };
  if (!isValidSteamId64(steamId)) return { ok: false, reason: 'steamid_out_of_range' };

  // 5. return_to 必須與發起時完全一致
  if (p('return_to') !== expectedReturnTo) return { ok: false, reason: 'return_to_mismatch' };

  // 6. signed 必須涵蓋所有關鍵欄位
  const signedSet = new Set((p('signed') ?? '').split(','));
  for (const field of REQUIRED_SIGNED_FIELDS) {
    if (!signedSet.has(field)) return { ok: false, reason: 'signed_fields_missing' };
  }

  // 7. response_nonce：時戳偏差 ≤ 5 分鐘 + 程序內單次使用
  const nonce = p('response_nonce');
  if (!nonce) return { ok: false, reason: 'nonce_invalid' };
  // OpenID 2.0 nonce 開頭是無毫秒的 UTC 時戳（yyyy-MM-ddTHH:mm:ssZ），後接唯一字串
  const nonceTsStr = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(nonce)?.[1];
  if (!nonceTsStr) return { ok: false, reason: 'nonce_invalid' };
  const nonceTs = Date.parse(nonceTsStr);
  const now = Date.now();
  pruneNonces(now);
  if (!Number.isFinite(nonceTs) || Math.abs(now - nonceTs) > NONCE_WINDOW_MS) {
    return { ok: false, reason: 'nonce_expired' };
  }
  if (seenNonces.has(nonce)) return { ok: false, reason: 'nonce_replayed' };
  // 進入網路驗證前就標記為已用，避免並發重放同一 nonce
  seenNonces.set(nonce, nonceTs);

  // 8. 原樣 POST 全部 openid.* 參數（mode 改 check_authentication）回 Steam 驗簽
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.') && typeof v === 'string') body.set(k, v);
  }
  body.set('openid.mode', 'check_authentication');

  let text: string;
  try {
    const res = await fetch(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(CHECK_AUTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'check_auth_http_error' };
    text = await res.text();
  } catch {
    // 網路錯誤與 timeout（TimeoutError）都走這裡：請求根本沒送達 Steam，
    // assertion 未被消耗 —— 回收 nonce 讓合法使用者可重試。
    // 分界：一旦收到 Steam 的 HTTP 回應（含 5xx / is_valid:false）就維持
    // 燒毀（fail-closed）；Steam 端對 check_authentication 本身也有 nonce
    // 單次防線當後盾。
    seenNonces.delete(nonce);
    return { ok: false, reason: 'network_error' };
  }

  // 9. 逐行解析：必須存在完整一行 is_valid:true（不可用子字串 includes）
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (!lines.includes('is_valid:true')) return { ok: false, reason: 'not_valid' };

  return { ok: true, steamId };
}

export { buildRedirectUrl, verifyAssertion, isValidSteamId64 };

// 測試專用 export（照 auth.ts 慣例）
const _test = { seenNonces };
export { _test };
