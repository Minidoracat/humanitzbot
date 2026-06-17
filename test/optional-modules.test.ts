import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsentOptionalModule } from '../src/bootstrap/optional-modules.js';

// Guards the URL-suffix heuristic that distinguishes a genuinely-absent optional
// module from a present-but-broken one (both throw ERR_MODULE_NOT_FOUND). If a
// future Node version changes the shape of ERR_MODULE_NOT_FOUND (err.code /
// err.url), these assertions catch the regression.
describe('isAbsentOptionalModule', () => {
  const errModuleNotFound = (url?: string) => ({ code: 'ERR_MODULE_NOT_FOUND', url });

  it('treats a genuinely-absent optional module (own path) as absent → true', () => {
    assert.equal(
      isAbsentOptionalModule(
        errModuleNotFound('file:///app/src/modules/anticheat-integration.js'),
        'anticheat-integration.js',
      ),
      true,
    );
    assert.equal(
      isAbsentOptionalModule(errModuleNotFound('file:///app/src/modules/howyagarn/web-plugin.js'), 'web-plugin.js'),
      true,
    );
  });

  it('treats a present module with a broken transitive dependency as NOT absent → false', () => {
    // The module exists; the unresolved URL is the nested dependency, not the module itself.
    assert.equal(
      isAbsentOptionalModule(errModuleNotFound('file:///app/src/modules/howyagarn/missing-dep.js'), 'web-plugin.js'),
      false,
    );
  });

  it('does not match a different file whose name merely ends with moduleFile → false', () => {
    // Full-segment match ('/' + moduleFile) — `x-anticheat-integration.js` is a
    // different file, so it must NOT be classified as the absent module.
    assert.equal(
      isAbsentOptionalModule(
        errModuleNotFound('file:///app/src/x-anticheat-integration.js'),
        'anticheat-integration.js',
      ),
      false,
    );
  });

  it('ignores non-ERR_MODULE_NOT_FOUND errors (e.g. a parse/syntax error) → false', () => {
    assert.equal(
      isAbsentOptionalModule(
        { code: 'ERR_PARSE', url: 'file:///app/src/modules/anticheat-integration.js' },
        'anticheat-integration.js',
      ),
      false,
    );
  });

  it('fails toward logging when err.url is absent → false', () => {
    assert.equal(isAbsentOptionalModule(errModuleNotFound(undefined), 'anticheat-integration.js'), false);
  });

  it('fails toward logging for null / non-object errors → false', () => {
    assert.equal(isAbsentOptionalModule(null, 'anticheat-integration.js'), false);
    assert.equal(isAbsentOptionalModule(undefined, 'anticheat-integration.js'), false);
    assert.equal(isAbsentOptionalModule('ERR_MODULE_NOT_FOUND', 'anticheat-integration.js'), false);
  });
});
