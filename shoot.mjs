// Renders the ad page to ad.png the way a reader sees it: opens index.html in headless Chrome at a
// desktop width, waits for fonts, and captures the whole page. Standard library only, over the
// DevTools protocol.
//   node shoot.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const CHROME =
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  }) ?? 'chrome';

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const file = resolve(join(here, path === '/' ? 'index.html' : path));
  if (!file.startsWith(here + sep) && file !== join(here, 'index.html')) return response.writeHead(403).end();
  try {
    const body = readFileSync(file);
    response.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${join(process.env.TEMP ?? '.', `adshot-${Date.now()}`)}`,
  '--window-size=1200,900', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1',
  '--disable-lcd-text', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const debugPort = await new Promise((done, fail) => {
  let buf = '';
  chrome.stderr.on('data', (c) => {
    buf += c.toString();
    const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) done(Number(m[1]));
  });
  chrome.on('exit', (code) => fail(new Error(`chrome exited ${code}: ${buf.slice(0, 300)}`)));
});

const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener('open', done, { once: true });
  socket.addEventListener('error', fail, { once: true });
});

let id = 1;
const pending = new Map();
socket.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { done, fail } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? fail(new Error(JSON.stringify(m.error))) : done(m.result);
  }
});
const send = (method, params = {}, sessionId) => {
  const n = id++;
  socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((done, fail) => pending.set(n, { done, fail }));
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
await new Promise((r) => setTimeout(r, 1200));

const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
const height = Math.ceil(metrics.cssContentSize.height);
const width = Math.ceil(metrics.cssContentSize.width);
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height, deviceScaleFactor: 1, mobile: false }, sessionId);
await new Promise((r) => setTimeout(r, 400));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
const buffer = Buffer.from(shot.data, 'base64');
writeFileSync(join(here, 'ad.png'), buffer);
console.log(`ad.png: ${buffer.length} bytes, page ${width}x${height}`);

socket.close();
chrome.kill();
server.close();
