// Drives the real dashboard (headless snap Chromium, fake mic) through every Ctrl gesture.
// Usage: python3 test/make-fake-mic.py && node test/browser-gestures.cjs ~/voice-fakemic.wav
const puppeteer = require('/usr/lib/node_modules/puppeteer-core');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = fs.readFileSync('/var/www/scws/daemon/.env','utf8').match(/^DASHBOARD_TOKEN=(.*)$/m)[1].trim();
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: 'new', acceptInsecureCerts: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--use-file-for-fake-audio-capture=' + process.argv[2], '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.evaluateOnNewDocument(t => localStorage.setItem('spawn_token', t), TOKEN);
  await page.goto('https://spawn.tail852587.ts.net:8443/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.className = 'claude-term-wrapper active';
    div.style.cssText = 'width:600px;height:300px;position:relative';
    document.body.appendChild(div);
    window.__sent = [];
    claudeTerminals['t1'] = { container: div, ws: { readyState: 1, send: s => window.__sent.push(JSON.parse(s).data) } };
    activeClaudeSessionId = 't1';
  });
  const st = () => page.evaluate(() => ({ mode: _voice.mode, fin: _voice.finishing, mic: !!_voice.mic, sent: __sent.slice(),
    overlay: (document.getElementById('voice-overlay') || { style: {} }).style.display }));
  const ok = (name, cond, s) => console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(s)));
  const kb = page.keyboard; let s;
  const dbl = async () => { await kb.down('Control'); await sleep(60); await kb.up('Control'); await sleep(120); await kb.down('Control'); await sleep(60); await kb.up('Control'); await sleep(100); };

  // hold through the first phrase (clip: 1 s silence, then "And so my fellow Americans" ~1-3.5 s)
  await kb.down('Control'); await sleep(800);
  s = await st(); ok('hold starts mic + overlay', s.mode === 'hold' && s.mic && s.overlay === 'block', s);
  await sleep(3200); await kb.up('Control'); await sleep(100);
  s = await st(); ok('release stops mic, finishing', s.mode === null && !s.mic && s.fin, s);
  await sleep(4000);
  s = await st(); ok('phrase typed after release, overlay hidden', /fellow Americans/i.test(s.sent.join('')) && !s.fin && s.overlay === 'none', s);

  await page.evaluate(() => { __sent.length = 0; });
  await kb.down('Control'); await sleep(80); await kb.press('c'); await sleep(500); await kb.up('Control'); await sleep(100);
  s = await st(); ok('quick Ctrl+C ignored', s.mode === null && !s.mic && s.overlay === 'none', s);
  await kb.down('Control'); await sleep(600); await kb.press('c'); await sleep(100);
  s = await st(); ok('slow Ctrl+C cancels hold', s.mode === null && !s.mic && !s.fin && s.overlay === 'none', s);
  await kb.up('Control'); await sleep(600);

  await dbl();
  s = await st(); ok('double-tap locks', s.mode === 'lock', s);
  await sleep(500);
  s = await st(); ok('lock has mic', s.mic, s);
  await kb.type('xyz'); await page.mouse.click(10, 10); await kb.down('Control'); await kb.press('v'); await kb.up('Control');
  await sleep(100); s = await st(); ok('typing, click, Ctrl+V keep lock', s.mode === 'lock' && s.mic, s);
  await sleep(600); await kb.down('Control'); await sleep(60); await kb.up('Control'); await sleep(700);
  s = await st(); ok('single tap keeps lock', s.mode === 'lock', s);
  await dbl();
  s = await st(); ok('double-tap unlocks, mic released', s.mode === null && !s.mic, s);
  await sleep(4000);
  s = await st(); ok('finishes', !s.fin && s.overlay === 'none', s);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
