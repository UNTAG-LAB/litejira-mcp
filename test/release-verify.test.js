'use strict';

// 發版管線的判斷邏輯單測：只打純函式，不連網、不跑 npm、不碰 registry。
// 守的是「發錯版 / 覆寫別人的版本 / 半成品也放行」這一類錯誤。

const test = require('node:test');
const assert = require('node:assert');

const rv = require('../scripts/release-verify.cjs');

test('parseReleaseTag 只收正式版 vX.Y.Z', function () {
  assert.equal(rv.parseReleaseTag('v3.1.0'), '3.1.0');
  assert.equal(rv.parseReleaseTag(' v10.0.12 '), '10.0.12');
  for (const bad of ['3.1.0', 'v3.1', 'v3.1.0-rc.1', 'v3.1.0+build', 'v03.1.0', 'vlatest', '', undefined]) {
    assert.throws(() => rv.parseReleaseTag(bad), /正式版 vX\.Y\.Z/, `應擋下 ${String(bad)}`);
  }
});

test('assertTagMatchesPackage 要求 tag 與 package.json 對得上', function () {
  assert.equal(rv.assertTagMatchesPackage('v3.1.0', { name: 'litejira-mcp', version: '3.1.0' }), '3.1.0');
  assert.throws(() => rv.assertTagMatchesPackage('v3.1.1', { name: 'litejira-mcp', version: '3.1.0' }), /不一致/);
  assert.throws(() => rv.assertTagMatchesPackage('v3.1.0', { name: 'other', version: '3.1.0' }), /name/);
});

test('integrity / shasum 由 tgz 位元組決定', function () {
  const a = rv.integrityOf(Buffer.from('litejira'));
  assert.match(a, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(a, rv.integrityOf(Buffer.from('litejira')));
  assert.notEqual(a, rv.integrityOf(Buffer.from('litejirb')));
  assert.equal(rv.shasumOf(Buffer.from('litejira')).length, 40);
});

test('compareDist：有 integrity 比 integrity，只有 shasum 才退回比 shasum', function () {
  const local = { integrity: 'sha512-AAA', shasum: 'abc' };
  assert.equal(rv.compareDist({ integrity: 'sha512-AAA', shasum: 'zzz' }, local).same, true);
  assert.equal(rv.compareDist({ integrity: 'sha512-BBB', shasum: 'abc' }, local).same, false);
  assert.equal(rv.compareDist({ shasum: 'abc' }, local).same, true);
  assert.equal(rv.compareDist({ shasum: 'zzz' }, local).same, false);
  assert.equal(rv.compareDist({}, local).same, false);
  assert.equal(rv.compareDist(null, local).same, false);
});

test('decidePublish：沒發過就發、發過且一致就跳過、不一致就明確失敗', function () {
  const local = { integrity: 'sha512-AAA', shasum: 'abc' };
  const fresh = rv.decidePublish({ version: '3.2.0', packument: { versions: { '3.1.0': {} } }, local });
  assert.equal(fresh.publish, true);

  const same = rv.decidePublish({
    version: '3.2.0',
    packument: { versions: { '3.2.0': { dist: { integrity: 'sha512-AAA' } } } },
    local
  });
  assert.equal(same.publish, false);
  assert.match(same.reason, /跳過發布/);

  assert.throws(() => rv.decidePublish({
    version: '3.2.0',
    packument: { versions: { '3.2.0': { dist: { integrity: 'sha512-BBB' } } } },
    local
  }), /不覆寫已發布版本/);
});

test('compareSemver 足以判斷 npm 是否達到最低版本', function () {
  assert.equal(rv.compareSemver('11.5.1', rv.MIN_NPM), 0);
  assert.equal(rv.compareSemver('11.6.0', rv.MIN_NPM) > 0, true);
  assert.equal(rv.compareSemver('11.5.0', rv.MIN_NPM) < 0, true);
  assert.equal(rv.compareSemver('9.9.9', rv.MIN_NPM) < 0, true);
  assert.equal(rv.compareSemver('12.0.0', rv.MIN_NPM) > 0, true);
});

test('較舊的新版本不能倒退 latest，既有同版重跑仍可跳過發布', function () {
  const local = { integrity: 'sha512-SAME' };
  assert.throws(() => rv.decidePublish({version: '3.1.1', local,
    packument: {versions: {}, 'dist-tags': {latest: '3.2.0'}}}), /倒退/);
  assert.equal(rv.decidePublish({version: '3.1.1', local,
    packument: {versions: {'3.1.1': {dist: local}}, 'dist-tags': {latest: '3.2.0'}}}).publish, false);
});

// 發版前那支「裝起來真的啟得動」的 smoke，本身也得是對的：
// 這裡拿工作目錄當「已安裝的 package」跑一次（打本機 stub，不需要真權杖、不連外）。
test('smokeInstalledPackage 能對一份 package 目錄跑完唯讀 stdio smoke', async function () {
  const pkg = require('../package.json');
  await rv.smokeInstalledPackage(require('node:path').join(__dirname, '..'), pkg.version);
  await assert.rejects(
    () => rv.smokeInstalledPackage(require('node:path').join(__dirname, '..'), '0.0.0-not-this'),
    /安裝到的版本/
  );
});

test('backoffDelays 是有限的、會遞增、有上限', function () {
  const delays = rv.backoffDelays(8);
  assert.equal(delays.length, 7);
  assert.equal(delays[0], 2000);
  assert.equal(delays.every((d, i) => i === 0 || d >= delays[i - 1]), true);
  assert.equal(Math.max(...delays), 30000);
  assert.equal(delays.reduce((a, b) => a + b, 0) < 180000, true);
});
