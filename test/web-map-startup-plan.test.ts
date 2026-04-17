import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planWebPanelStartup } from '../src/web-map/startup-plan.js';

describe('planWebPanelStartup', () => {
  it('returns disabled when WEB_MAP_PORT is missing', () => {
    const plan = planWebPanelStartup({}, { discordClientSecret: 'secret' });
    assert.deepEqual(plan, { action: 'disabled', reason: 'noPort' });
  });

  it('returns disabled when WEB_MAP_PORT is not a number', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: 'abc' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'disabled');
  });

  it('returns disabled when WEB_MAP_PORT is 0', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '0' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'disabled');
  });

  it('returns oauth mode when both secret and callback URL are set', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_MAP_CALLBACK_URL: 'http://localhost:3000/auth/callback' },
      { discordClientSecret: 'secret' },
    );
    assert.deepEqual(plan, { action: 'start', port: 3000, mode: 'oauth' });
  });

  it('returns dev mode when OAuth unset and WEB_PANEL_ALLOW_NO_AUTH=true', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_PANEL_ALLOW_NO_AUTH: 'true' },
      { discordClientSecret: '' },
    );
    assert.deepEqual(plan, { action: 'start', port: 3000, mode: 'devAutoLogin' });
  });

  it('returns noAuth mode when OAuth unset and no dev flag', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '3000' }, { discordClientSecret: '' });
    assert.deepEqual(plan, { action: 'start', port: 3000, mode: 'landingOnly' });
  });

  it('partial OAuth: only secret set → noAuth', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '3000' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });

  it('partial OAuth: only callback URL set → noAuth', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_MAP_CALLBACK_URL: 'http://localhost:3000/auth/callback' },
      { discordClientSecret: '' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });

  it('partial OAuth + dev flag: still routes to dev mode', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_PANEL_ALLOW_NO_AUTH: 'true' },
      { discordClientSecret: 'secret' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'devAutoLogin');
  });

  it('strict flag: WEB_PANEL_ALLOW_NO_AUTH=TRUE (uppercase) stays in noAuth', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_PANEL_ALLOW_NO_AUTH: 'TRUE' },
      { discordClientSecret: '' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });

  it('strict flag: WEB_PANEL_ALLOW_NO_AUTH=1 stays in noAuth', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_PANEL_ALLOW_NO_AUTH: '1' },
      { discordClientSecret: '' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });

  it('configured OAuth takes precedence over WEB_PANEL_ALLOW_NO_AUTH', () => {
    const plan = planWebPanelStartup(
      {
        WEB_MAP_PORT: '3000',
        WEB_MAP_CALLBACK_URL: 'http://localhost:3000/auth/callback',
        WEB_PANEL_ALLOW_NO_AUTH: 'true',
      },
      { discordClientSecret: 'secret' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'oauth');
  });
});
