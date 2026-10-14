// Streams whisper.cpp's JFK sample in real time to spawn-voice and prints what comes back.
// Usage: node test/stream-sample.cjs wss://spawn.tail852587.ts.net:8443/spawn-voice/ws
const WebSocket = require('/var/www/scws/projects/spawn-voice/node_modules/ws');
const fs = require('fs');
const token = fs.readFileSync('/var/www/scws/daemon/.env','utf8').match(/^DASHBOARD_TOKEN=(.*)$/m)[1].trim();
const url = process.argv[2] + '?token=' + encodeURIComponent(token);
const pcm = fs.readFileSync('/var/www/scws/projects/spawn-voice/whisper.cpp/samples/jfk.wav').subarray(44);
const t0 = Date.now(); const T = () => ((Date.now()-t0)/1000).toFixed(2)+'s';
const ws = new WebSocket(url, { rejectUnauthorized: false });
ws.on('unexpected-response', (q, r) => { console.log('HTTP', r.statusCode); process.exit(0); });
ws.on('message', m => { const o = JSON.parse(m); console.log(T(), o.type, o.text ?? ''); if (o.type==='done') process.exit(0); });
ws.on('open', () => {
  ws.send(JSON.stringify({type:'start'}));
  const chunk = 16000*2/10; let off = 0;          // 100 ms chunks, real time
  const iv = setInterval(() => {
    if (off < pcm.length) { ws.send(pcm.subarray(off, off+chunk)); off += chunk; }
    else if (off < pcm.length + chunk*10) { ws.send(Buffer.alloc(chunk)); off += chunk; }  // 1 s silence
    else { clearInterval(iv); console.log(T(), 'audio end, stop'); ws.send(JSON.stringify({type:'stop'})); }
  }, 100);
});
