import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildRedirectUrl, verifyAssertion, isValidSteamId64, _test } from '../src/web-map/steam-openid.js';

const ENDPOINT = 'https://steamcommunity.com/openid/login';
const RETURN_TO = 'https://map.example.com/auth/steam/return';
const REALM = 'https://map.example.com';
const VALID_STEAM_ID = '76561197960287930';

/** 產生 OpenID 2.0 格式（無毫秒 UTC 時戳 + 唯一字尾）的 nonce */
function makeNonce(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19) + 'Z' + crypto.randomUUID();
}

/** 一份完整合法的 Steam 回跳 query，可用 overrides 蓋掉個別欄位 */
function validQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': ENDPOINT,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${VALID_STEAM_ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${VALID_STEAM_ID}`,
    'openid.return_to': RETURN_TO,
    'openid.response_nonce': makeNonce(),
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'dGVzdHNpZw==',
    ...overrides,
  };
}

function stubFetchResponse(bodyText: string, status = 200): void {
  (global as unknown as Record<string, unknown>).fetch = async () => new Response(bodyText, { status });
}

const IS_VALID_TRUE_BODY = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n';

describe('steam-openid', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // 每個測試前清空 nonce 記錄，避免跨測試互相干擾
    _test.seenNonces.clear();
    // 預設 stub：任何未預期的網路呼叫直接爆錯，逼測試明確宣告 fetch 行為
    (global as unknown as Record<string, unknown>).fetch = async () => {
      throw new Error('unexpected fetch call in test');
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('buildRedirectUrl', () => {
    it('組出正確的 checkid_setup URL', () => {
      const url = new URL(buildRedirectUrl(REALM, RETURN_TO));
      assert.equal(url.origin + url.pathname, ENDPOINT);
      assert.equal(url.searchParams.get('openid.ns'), 'http://specs.openid.net/auth/2.0');
      assert.equal(url.searchParams.get('openid.mode'), 'checkid_setup');
      assert.equal(url.searchParams.get('openid.return_to'), RETURN_TO);
      assert.equal(url.searchParams.get('openid.realm'), REALM);
      assert.equal(url.searchParams.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select');
      assert.equal(url.searchParams.get('openid.claimed_id'), 'http://specs.openid.net/auth/2.0/identifier_select');
    });
  });

  describe('isValidSteamId64', () => {
    it('接受範圍內的 17 位數字（含邊界值）', () => {
      assert.equal(isValidSteamId64(VALID_STEAM_ID), true);
      assert.equal(isValidSteamId64('76561197960265728'), true); // min
      assert.equal(isValidSteamId64('76561202255233023'), true); // max
    });

    it('拒絕格式錯誤與範圍外的值', () => {
      assert.equal(isValidSteamId64(''), false);
      assert.equal(isValidSteamId64('7656119796028793'), false); // 16 位
      assert.equal(isValidSteamId64('765611979602879301'), false); // 18 位
      assert.equal(isValidSteamId64('7656119796028793a'), false); // 非數字
      assert.equal(isValidSteamId64('76561197960265727'), false); // min - 1
      assert.equal(isValidSteamId64('76561202255233024'), false); // max + 1
      assert.equal(isValidSteamId64('10000000000000000'), false); // 17 位但遠低於範圍
    });
  });

  describe('verifyAssertion 負向案例', () => {
    it('陣列參數（HTTP parameter pollution）被拒絕', async () => {
      const res = await verifyAssertion(
        validQuery({ 'openid.claimed_id': [`https://steamcommunity.com/openid/id/${VALID_STEAM_ID}`, 'evil'] }),
        RETURN_TO,
      );
      assert.deepEqual(res, { ok: false, reason: 'invalid_params' });
    });

    it('mode=cancel 回 cancelled', async () => {
      const res = await verifyAssertion(
        { 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'cancel' },
        RETURN_TO,
      );
      assert.deepEqual(res, { ok: false, reason: 'cancelled' });
    });

    it('mode 非 id_res 被拒絕', async () => {
      const res = await verifyAssertion(validQuery({ 'openid.mode': 'checkid_setup' }), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'bad_mode' });
    });

    it('錯誤的 op_endpoint 被拒絕', async () => {
      const res = await verifyAssertion(
        validQuery({ 'openid.op_endpoint': 'https://evil.example.com/openid/login' }),
        RETURN_TO,
      );
      assert.deepEqual(res, { ok: false, reason: 'bad_op_endpoint' });
    });

    it('claimed_id 與 identity 不一致被拒絕', async () => {
      const res = await verifyAssertion(
        validQuery({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561197960287931' }),
        RETURN_TO,
      );
      assert.deepEqual(res, { ok: false, reason: 'claimed_id_mismatch' });
    });

    it('claimed_id 不符合正規表達式被拒絕（多餘路徑、位數不足、錯 host）', async () => {
      for (const bad of [
        `https://steamcommunity.com/openid/id/${VALID_STEAM_ID}/extra`,
        'https://steamcommunity.com/openid/id/7656119796028793',
        `https://evil.example.com/openid/id/${VALID_STEAM_ID}`,
        `http://evil.example.com/openid/id/${VALID_STEAM_ID}`,
      ]) {
        const res = await verifyAssertion(validQuery({ 'openid.claimed_id': bad, 'openid.identity': bad }), RETURN_TO);
        assert.deepEqual(res, { ok: false, reason: 'bad_claimed_id' }, `should reject: ${bad}`);
      }
    });

    it('17 位但數值範圍外的 SteamID 被拒絕', async () => {
      const id = 'https://steamcommunity.com/openid/id/76561202255233024'; // max + 1
      const res = await verifyAssertion(validQuery({ 'openid.claimed_id': id, 'openid.identity': id }), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'steamid_out_of_range' });
    });

    it('return_to 與預期不一致被拒絕', async () => {
      const res = await verifyAssertion(
        validQuery({ 'openid.return_to': 'https://map.example.com/auth/steam/return?extra=1' }),
        RETURN_TO,
      );
      assert.deepEqual(res, { ok: false, reason: 'return_to_mismatch' });
    });

    it('signed 未涵蓋關鍵欄位被拒絕（逐一缺失每個必要欄位）', async () => {
      const required = ['claimed_id', 'identity', 'return_to', 'response_nonce', 'op_endpoint'];
      for (const missing of required) {
        const signed = ['signed', ...required.filter((f) => f !== missing), 'assoc_handle'].join(',');
        const res = await verifyAssertion(validQuery({ 'openid.signed': signed }), RETURN_TO);
        assert.deepEqual(
          res,
          { ok: false, reason: 'signed_fields_missing' },
          `should reject when '${missing}' unsigned`,
        );
      }
    });

    it('nonce 時戳超窗（過期）被拒絕', async () => {
      const res = await verifyAssertion(validQuery({ 'openid.response_nonce': makeNonce(-6 * 60 * 1000) }), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'nonce_expired' });
    });

    it('nonce 時戳在未來超窗也被拒絕', async () => {
      const res = await verifyAssertion(validQuery({ 'openid.response_nonce': makeNonce(6 * 60 * 1000) }), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'nonce_expired' });
    });

    it('nonce 格式錯誤被拒絕', async () => {
      const res = await verifyAssertion(validQuery({ 'openid.response_nonce': 'not-a-timestamp' }), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'nonce_invalid' });
    });

    it('nonce 重放被拒絕（第一次成功、第二次拒絕）', async () => {
      stubFetchResponse(IS_VALID_TRUE_BODY);
      const query = validQuery();
      const first = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(first, { ok: true, steamId: VALID_STEAM_ID });
      const second = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(second, { ok: false, reason: 'nonce_replayed' });
    });

    it('check_authentication 回 is_valid:false 被拒絕', async () => {
      stubFetchResponse('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n');
      const res = await verifyAssertion(validQuery(), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'not_valid' });
    });

    it('is_valid:true 只能是完整行，子字串不算', async () => {
      // 若實作誤用子字串 includes，這兩種 body 會被誤判為通過
      for (const body of ['foo:is_valid:true\n', 'is_valid:truely\n', 'note:contains is_valid:true somewhere\n']) {
        stubFetchResponse(body);
        const res = await verifyAssertion(validQuery(), RETURN_TO);
        assert.deepEqual(res, { ok: false, reason: 'not_valid' }, `should reject body: ${JSON.stringify(body)}`);
      }
    });

    it('check_authentication 回非 2xx 被拒絕', async () => {
      stubFetchResponse(IS_VALID_TRUE_BODY, 500);
      const res = await verifyAssertion(validQuery(), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'check_auth_http_error' });
    });

    it('網路錯誤回 network_error', async () => {
      (global as unknown as Record<string, unknown>).fetch = async () => {
        throw new TypeError('fetch failed');
      };
      const res = await verifyAssertion(validQuery(), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'network_error' });
    });

    it('network_error（請求未達 Steam）後同 nonce 可重試，不被 replay 擋', async () => {
      const query = validQuery();
      (global as unknown as Record<string, unknown>).fetch = async () => {
        throw new TypeError('fetch failed');
      };
      const first = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(first, { ok: false, reason: 'network_error' });
      // 網路恢復後重試同一 assertion → nonce 已回收，應成功
      stubFetchResponse(IS_VALID_TRUE_BODY);
      const retry = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(retry, { ok: true, steamId: VALID_STEAM_ID });
    });

    it('is_valid:false（已收到 Steam 回應）後同 nonce 維持燒毀 → nonce_replayed', async () => {
      const query = validQuery();
      stubFetchResponse('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n');
      const first = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(first, { ok: false, reason: 'not_valid' });
      // fail-closed 迴歸：即使之後 Steam 願意說 true，同 nonce 也不得再用
      stubFetchResponse(IS_VALID_TRUE_BODY);
      const replay = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(replay, { ok: false, reason: 'nonce_replayed' });
    });

    it('check_auth HTTP 5xx（已收到回應）後同 nonce 亦維持燒毀', async () => {
      const query = validQuery();
      stubFetchResponse(IS_VALID_TRUE_BODY, 500);
      const first = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(first, { ok: false, reason: 'check_auth_http_error' });
      stubFetchResponse(IS_VALID_TRUE_BODY);
      const replay = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(replay, { ok: false, reason: 'nonce_replayed' });
    });

    it('timeout（TimeoutError）回 network_error，且 fetch 有帶 AbortSignal', async () => {
      let receivedSignal: unknown;
      (global as unknown as Record<string, unknown>).fetch = async (_url: string, opts: { signal?: unknown }) => {
        receivedSignal = opts.signal;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      const res = await verifyAssertion(validQuery(), RETURN_TO);
      assert.deepEqual(res, { ok: false, reason: 'network_error' });
      assert.ok(receivedSignal instanceof AbortSignal, 'fetch must be called with an AbortSignal');
    });
  });

  describe('verifyAssertion happy path', () => {
    it('合法 assertion 通過並回傳 steamId，POST 原樣轉發參數且 mode 改 check_authentication', async () => {
      let capturedUrl = '';
      let capturedBody = '';
      let capturedContentType: string | undefined;
      (global as unknown as Record<string, unknown>).fetch = async (
        url: string,
        opts: { method: string; body: string; headers: Record<string, string> },
      ) => {
        capturedUrl = url;
        capturedBody = opts.body;
        capturedContentType = opts.headers['Content-Type'];
        assert.equal(opts.method, 'POST');
        // \r\n 行尾也要能解析
        return new Response('ns:http://specs.openid.net/auth/2.0\r\nis_valid:true\r\n');
      };

      const query = validQuery();
      const res = await verifyAssertion(query, RETURN_TO);
      assert.deepEqual(res, { ok: true, steamId: VALID_STEAM_ID });

      assert.equal(capturedUrl, ENDPOINT);
      assert.equal(capturedContentType, 'application/x-www-form-urlencoded');
      const posted = new URLSearchParams(capturedBody);
      assert.equal(posted.get('openid.mode'), 'check_authentication');
      assert.equal(posted.get('openid.sig'), query['openid.sig']);
      assert.equal(posted.get('openid.signed'), query['openid.signed']);
      assert.equal(posted.get('openid.response_nonce'), query['openid.response_nonce']);
      assert.equal(posted.get('openid.claimed_id'), query['openid.claimed_id']);
      assert.equal(posted.get('openid.assoc_handle'), query['openid.assoc_handle']);
    });

    it('http:// 形式的 claimed_id 也接受（Steam 歷史格式，scheme 非安全邊界）', async () => {
      stubFetchResponse(IS_VALID_TRUE_BODY);
      const id = `http://steamcommunity.com/openid/id/${VALID_STEAM_ID}`;
      const res = await verifyAssertion(validQuery({ 'openid.claimed_id': id, 'openid.identity': id }), RETURN_TO);
      assert.deepEqual(res, { ok: true, steamId: VALID_STEAM_ID });
    });
  });
});
