'use strict';

// `litejira-mcp setup`：先驗證再保存、取消 / 失敗不動既有憑證、未知行原樣保留、
// token 不外洩到 stdout。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { mergeCredText, resolveTargetFile, runSetup } = require('../litejira-setup');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ltj-setup-'));
}

// 假 TTY：把要「打」的字元一次餵進 data 事件（含結尾 Enter 或 Ctrl+C）。
function fakeStdin(keystrokes) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = function (v) { stdin.isRaw = v; };
  stdin.resume = function () {};
  stdin.pause = function () {};
  stdin.setEncoding = function () {};
  stdin.removeListener = EventEmitter.prototype.removeListener.bind(stdin);
  const origOn = stdin.on.bind(stdin);
  stdin.on = function (event, handler) {
    origOn(event, handler);
    if (event === 'data') setImmediate(function () { stdin.emit('data', keystrokes); });
    return stdin;
  };
  return stdin;
}

function collector() {
  const chunks = [];
  return { write: function (s) { chunks.push(s); return true; }, text: function () { return chunks.join(''); } };
}

const TOKEN = 'ltj_pat_secret_value';

function okFetch(seen) {
  return async function (url, init) {
    seen.push({ url: String(url), auth: init && init.headers && (init.headers.Authorization || init.headers.authorization) });
    return { status: 200, text: async function () { return JSON.stringify({ data: { types: [], statuses: [] } }); } };
  };
}

test('token-only setup：驗證成功後寫入憑證檔，token 不出現在 stdout', async function () {
  const dir = tmpDir();
  const out = collector();
  const err = collector();
  const seen = [];
  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: out,
    stderr: err,
    fetch: okFetch(seen)
  });

  assert.equal(code, 0, err.text());
  const file = path.join(dir, 'credentials.env');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'LTJ_API_TOKEN=' + TOKEN);
  // 驗證打的是正式站的 meta，專案 MAIN
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /^https:\/\/litejira\.untaglab\.com\//);
  assert.match(seen[0].url, /project=MAIN/);
  // 畫面只該有遮罩字元與站台/專案資訊，不得有 token
  assert.equal(out.text().indexOf(TOKEN), -1, 'token 不得出現在 stdout');
  assert.equal(err.text().indexOf(TOKEN), -1, 'token 不得出現在 stderr');
  assert.match(out.text(), /MAIN/);
  assert.match(out.text(), /權限/, '要提醒實際可寫範圍仍看個人權限');
});

test('驗證失敗不覆寫既有憑證', async function () {
  const dir = tmpDir();
  const file = path.join(dir, 'credentials.env');
  fs.writeFileSync(file, 'LTJ_API_TOKEN=old_token\n');
  const err = collector();
  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin('bad_token\r'),
    stdout: collector(),
    stderr: err,
    fetch: async function () {
      return { status: 401, text: async function () { return JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }); } };
    }
  });

  assert.equal(code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'LTJ_API_TOKEN=old_token\n');
  assert.match(err.text(), /未變更任何憑證/);
  assert.equal(err.text().indexOf('bad_token'), -1);
});

test('Ctrl+C 取消：不寫檔、回非零', async function () {
  const dir = tmpDir();
  const err = collector();
  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin('abc'),
    stdout: collector(),
    stderr: err,
    fetch: async function () { throw new Error('取消後不該驗證'); }
  });
  assert.equal(code, 130);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.env')), false);
  assert.match(err.text(), /已取消/);
});

test('直接 Enter 沿用既有 token（仍會重新驗證）', async function () {
  const dir = tmpDir();
  const file = path.join(dir, 'credentials.env');
  fs.writeFileSync(file, '# 我的註解\nLTJ_API_TOKEN=existing_token\nLTJ_PROJECT=KEEP\nSOMETHING_ELSE=1\n');
  const seen = [];
  const out = collector();
  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin('\r'),
    stdout: out,
    stderr: collector(),
    fetch: okFetch(seen)
  });

  assert.equal(code, 0);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# 我的註解$/m, '未識別行必須原樣保留');
  assert.match(text, /^SOMETHING_ELSE=1$/m);
  assert.match(text, /^LTJ_PROJECT=KEEP$/m, '既有專案設定不得被覆蓋');
  assert.match(text, /^LTJ_API_TOKEN=existing_token$/m);
  assert.match(seen[0].url, /project=KEEP/, '驗證要用既有專案，不是 MAIN');
});

test('沒有輸入任何 token 且沒有既有 token：不寫檔', async function () {
  const dir = tmpDir();
  const err = collector();
  const code = await runSetup([], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin('\r'),
    stdout: collector(),
    stderr: err,
    fetch: async function () { throw new Error('不該驗證'); }
  });
  assert.equal(code, 2);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.env')), false);
  assert.match(err.text(), /沒有輸入 token/);
});

test('非 TTY 且沒有任何 token 來源：明確失敗並指向 --token-stdin，不寫檔', async function () {
  const dir = tmpDir();
  const err = collector();
  const stdin = new EventEmitter();
  stdin.isTTY = false;
  const code = await runSetup(['prod'], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: stdin,
    stdout: collector(),
    stderr: err,
    fetch: async function () { throw new Error('不該驗證'); }
  });
  assert.equal(code, 2);
  assert.match(err.text(), /--token-stdin/);
  assert.match(err.text(), /LTJ_API_TOKEN/);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('自訂站台沒有預設專案時，setup 要求先設定 LTJ_PROJECT', async function () {
  const dir = tmpDir();
  const err = collector();
  const code = await runSetup([], {
    env: { LTJ_API_URL: 'https://jira.internal.example' },
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: collector(),
    stderr: err,
    fetch: async function () { throw new Error('不該驗證'); }
  });
  assert.equal(code, 2);
  assert.match(err.text(), /LTJ_PROJECT/);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('prod / dev 走各自的憑證檔；既有 .txt 就地更新不另開新檔', async function () {
  const dir = tmpDir();
  assert.equal(resolveTargetFile('prod', dir).file, path.join(dir, 'credentials.prod.env'));
  assert.equal(resolveTargetFile('dev', dir).file, path.join(dir, 'credentials.dev.env'));

  fs.writeFileSync(path.join(dir, 'credentials.dev.txt'), 'LTJ_API_URL=https://litejira.untaglab.com\n');
  const resolved = resolveTargetFile('dev', dir);
  assert.equal(resolved.file, path.join(dir, 'credentials.dev.txt'));
  assert.equal(resolved.existed, true);

  const code = await runSetup(['dev'], {
    env: {},
    dir: dir,
    // 這一檔只測憑證那一段：註冊主機設定有自己的測試檔，這裡明確關掉，
    // 才不會在跑測試時去碰執行者真正的 ~/.codex、~/.claude.json、~/.gemini。
    register: false,
    home: dir,
    stdin: fakeStdin(TOKEN + '\r'),
    stdout: collector(),
    stderr: collector(),
    fetch: okFetch([])
  });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.dev.env')), false, '已有 .txt 就不該另開 .env');
  const text = fs.readFileSync(path.join(dir, 'credentials.dev.txt'), 'utf8');
  assert.match(text, /^LTJ_API_URL=https:\/\/litejira\.untaglab\.com$/m);
  assert.match(text, /^LTJ_API_TOKEN=/m);
});

test('無法辨識的參數被拒絕；--help 走說明', async function () {
  const dir = tmpDir();
  const err = collector();
  assert.equal(await runSetup(['staging'], { env: {}, dir: dir, stdin: fakeStdin(''), stdout: collector(), stderr: err }), 2);
  assert.match(err.text(), /無法辨識的參數「staging」/);

  const out = collector();
  assert.equal(await runSetup(['--help'], { env: {}, dir: dir, stdin: fakeStdin(''), stdout: out, stderr: collector() }), 0);
  assert.match(out.text(), /litejira-mcp setup/);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('mergeCredText：既有鍵就地改值、未知行保留、缺的鍵補在最後', function () {
  const merged = mergeCredText(
    ['# c', 'LTJ_API_TOKEN=old', 'NOISE', ''],
    { LTJ_API_TOKEN: 'new', LTJ_PROJECT: 'X' }
  );
  assert.equal(merged, '# c\nLTJ_API_TOKEN=new\nNOISE\nLTJ_PROJECT=X\n');
});
