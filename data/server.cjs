const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');

const host = '127.0.0.1';
const port = 17834;
const configFile = process.argv[2] || path.join(__dirname, 'channels.json');
let settings = { twitch: '', tiktok: '', key: '' };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; }
catch (error) { if (error.code !== 'ENOENT') throw error; }

let demo = false;
const history = [];
const people = new Map();
let viewerCount = null;
const status = {};
const clients = new Set();
const state = { twitch: {}, tiktok: {} };

function send(client, event, data) {
  if (!client.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n') &&
      client.writableLength > 1024 * 1024) client.destroy();
}
function publish(event, data) {
  for (const client of clients) send(client, event, data);
}
function setStatus(platform, message) {
  status[platform] = message;
  publish('status', status);
}
function add(platform, kind, user, text, extra = {}) {
  const entry = { platform, kind, user, text, time: Date.now(), ...extra };
  history.push(entry);
  if (history.length > 1000) history.shift();
  publish('entry', entry);
}
function mark(user, handle, event) {
  const id = handle.toLowerCase();
  people.delete(id);
  people.set(id, { user, handle, event, time: Date.now() });
  if (people.size > 500) people.delete(people.keys().next().value);
  publish('person', { id, ...people.get(id) });
}
function removeMessages(id, userId) {
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (item.platform === 'twitch' && (id ? item.id === id : !userId || item.userId === userId))
      history.splice(index, 1);
  }
  publish('remove', { id, userId });
}
function clear(platform) {
  for (let index = history.length - 1; index >= 0; index--) {
    if (!platform || history[index].platform === platform) history.splice(index, 1);
  }
  if (platform !== 'twitch') {
    people.clear();
    viewerCount = null;
  }
  publish('snapshot', snapshot());
}
function snapshot() {
  return { entries: history, people: [...people], viewerCount, status, demo,
    settings: { twitch: settings.twitch, tiktok: settings.tiktok, hasKey: Boolean(settings.key) } };
}

function start(platform, connect) {
  const previous = state[platform];
  state[platform] = {};
  clearTimeout(previous.timer);
  previous.close?.();
  if (demo) return setStatus(platform, 'Demo');
  if (!settings[platform]) return setStatus(platform, 'Kanal eintragen');
  const run = state[platform];
  let delay = 3000;
  const current = () => state[platform] === run;
  function attempt() {
    if (!current()) return;
    setStatus(platform, 'Verbindet …');
    connect(settings[platform], run, current, () => {
      if (!current()) return;
      delay = 3000;
      setStatus(platform, 'Verbunden');
    }, (message) => {
      if (!current()) return;
      setStatus(platform, message + ' · neuer Versuch in ' + delay / 1000 + ' s');
      clearTimeout(run.timer);
      run.timer = setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 60000);
    });
  }
  attempt();
}

function twitch(channel, run, current, ready, retry) {
  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  run.close = () => socket.close();
  let reason = 'Verbindung getrennt';
  socket.addEventListener('open', () => {
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('PASS SCHMOOPIIE');
    socket.send('NICK justinfan' +
      Math.floor(100000 + Math.random() * 900000));
    socket.send('JOIN #' + channel);
  });
  socket.addEventListener('message', ({ data }) => {
    if (!current()) return;
    for (const line of data.split(/\r?\n/)) {
      if (line.startsWith('PING')) {
        socket.send('PONG' + line.slice(4));
        continue;
      }
      const match = line.match(/^(?:@([^ ]+) )?(?::([^ ]+) )?(\S+)(?: (.*))?$/);
      if (!match) continue;
      const [, rawTags, prefix, command, rest = ''] = match;
      const tags = Object.fromEntries((rawTags || '').split(';').filter(Boolean).map(tag => {
        const index = tag.indexOf('=');
        return [tag.slice(0, index), tag.slice(index + 1)];
      }));
      const param = rest.indexOf(' :');
      const message = param < 0 ? '' : rest.slice(param + 2);
      if (command === '366' || command === 'ROOMSTATE') ready();
      if (command === 'PRIVMSG') {
        const action = message.startsWith('\x01ACTION ') && message.endsWith('\x01');
        const body = action ? message.slice(8, -1) : message;
        const emotes = (tags.emotes || '').split('/').flatMap(group => {
          const [id, ranges] = group.split(':');
          if (!id || !ranges || !/^[\w-]+$/.test(id)) return [];
          return ranges.split(',').map(range => {
            const [start, end] = range.split('-').map(Number);
            return { id, start: start - (action ? 8 : 0), end: end - (action ? 8 : 0) };
          });
        });
        add('twitch', 'chat', tags['display-name'] || prefix?.split('!')[0] || 'Twitch', body,
          { id: tags.id, userId: tags['user-id'], badges: (tags.badges || '').split(',').filter(Boolean).map(badge => badge.split('/')[0]), emotes });
      }
      if (command === 'CLEARMSG' && tags['target-msg-id']) removeMessages(tags['target-msg-id']);
      if (command === 'CLEARCHAT') removeMessages(null, tags['target-user-id']);
      if (command === 'RECONNECT') socket.close();
      if (command === 'NOTICE') {
        reason = message || reason;
        setStatus('twitch', reason);
      }
    }
  });
  const timeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) socket.close();
  }, 15000);
  socket.addEventListener('close', () => { clearTimeout(timeout); retry(reason); });
}

function tiktok(channel, run, current, ready, retry) {
  SignConfig.apiKey = settings.key || undefined;
  const connection = new TikTokLiveConnection(channel, {
    processInitialData: false,
    enableExtendedGiftInfo: true
  });
  let active = true;
  function disconnect() {
    try { connection.disconnect(); } catch {}
  }
  run.close = () => { active = false; disconnect(); };
  function finish(message) {
    if (!active || !current()) return;
    active = false;
    disconnect();
    viewerCount = null;
    publish('count', null);
    retry(message);
  }
  const users = new Set();
  const seen = new Set();
  function receive(kind, data) {
    if (!active || !current()) return;
    const handle = data.user?.uniqueId || data.uniqueId || data.user?.userId || data.userId;
    const user = data.user?.nickname || data.nickname || handle || 'TikTok';
    const gift = data.giftDetails || data.gift || {};
    if (kind === 'gift' && Number(gift.giftType ?? data.giftType) === 1 && !data.repeatEnd) return;
    const id = data.common?.msgId ?? data.msgId;
    if (id && String(id) !== '0') {
      if (seen.has(String(id))) return;
      seen.add(String(id));
      if (seen.size > 2000) seen.delete(seen.values().next().value);
    }
    if (handle) mark(user, String(handle), kind);
    if (kind === 'join' && handle) {
      if (users.has(handle)) return;
      users.add(handle);
      if (users.size > 2000) users.delete(users.values().next().value);
      add('tiktok', kind, user, 'ist dem LIVE beigetreten');
    }
    if (kind === 'chat') add('tiktok', kind, user, data.comment || '');
    if (kind === 'gift') {
      const name = gift.giftName || gift.name || data.extendedGiftInfo?.name || data.giftName || 'Geschenk ' + (data.giftId ?? '');
      add('tiktok', kind, user, (Number(data.repeatCount) || 1) + ' × ' + name);
    }
  }
  connection.on('chat', data => receive('chat', data));
  connection.on('member', data => receive('join', data));
  connection.on('gift', data => receive('gift', data));
  connection.on('roomUser', data => {
    if (!active || !current()) return;
    const count = Number(data.viewerCount ?? data.totalUser);
    if (!Number.isFinite(count)) return;
    viewerCount = count;
    publish('count', count);
  });
  connection.on('streamEnd', () => finish('LIVE beendet'));
  connection.on('disconnected', () => finish('Verbindung getrennt'));
  connection.on('error', error => {
    if (active && current()) console.warn('TikTok:', error?.name || 'Verbindungsfehler');
  });
  const timeout = setTimeout(() => finish('Zeitüberschreitung'), 25000);
  connection.connect().then(() => {
    if (active && current()) ready();
    else disconnect();
  }).catch(error => {
    const message = String(error?.message || '');
    const type = /offline|not live|isn't online/i.test(message) ? 'Kanal ist offline'
      : /sign|euler|api key|401|403|429/i.test(message) ? 'Signierdienst oder API-Schlüssel prüfen'
      : 'LIVE-Verbindung fehlgeschlagen';
    finish(type);
  }).finally(() => clearTimeout(timeout));
}

function launch() {
  start('twitch', twitch);
  start('tiktok', tiktok);
}
function sample() {
  add('twitch', 'chat', 'SnakeFan', 'Guten Abend! Der Stream sieht super aus.');
  mark('PixelFox', 'pixelfox', 'join');
  add('tiktok', 'join', 'PixelFox', 'ist dem LIVE beigetreten');
  mark('PixelFox', 'pixelfox', 'chat');
  add('tiktok', 'chat', 'PixelFox', 'Hallo zusammen! 👋');
  mark('NightOwl', 'nightowl', 'gift');
  add('tiktok', 'gift', 'NightOwl', '5 × Rose');
  viewerCount = 42;
  publish('count', viewerCount);
}

const twitchControl = require('./twitch-control.cjs')({
  getChannel: () => settings.twitch,
  isDemo: () => demo,
  getBadges: () => new Map(history.filter(entry => entry.platform === 'twitch' && entry.userId).map(entry => [entry.userId, entry.badges])),
  getEntry: id => history.find(entry => entry.platform === 'twitch' && entry.id === id)
});
const twitchRoutes = {
  '/twitch/login': input => twitchControl.begin(String(input.clientId || '').trim()),
  '/twitch/chatters': () => twitchControl.chatters(),
  '/twitch/logout': () => twitchControl.logout(),
  '/twitch/command': async input => ({ message: await twitchControl.command(input) })
};
function sendJson(res, data) {
  return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

const origin = 'http://' + host + ':' + port;
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/twitch-dock.js': ['twitch-dock.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://static-cdn.jtvnw.net; frame-ancestors 'none'; base-uri 'none'");
  if (req.headers.host !== host + ':' + port) return res.writeHead(403).end();
  if (req.method === 'GET' && req.url === '/ready-' + process.pid) return res.writeHead(204).end();
  if (req.method === 'GET' && assets[req.url]) {
    const [file, type] = assets[req.url];
    return res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(fs.readFileSync(path.join(__dirname, file)));
  }
  if (req.method === 'GET' && req.url === '/twitch/status') return sendJson(res, twitchControl.status());
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    clients.add(res);
    send(res, 'snapshot', snapshot());
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
    res.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
    return;
  }
  if (req.method === 'POST' && (['/settings', '/demo'].includes(req.url) || Object.hasOwn(twitchRoutes, req.url))) {
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return res.writeHead(403).end();
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) throw Error('Eingabe zu lang.');
      }
      const input = JSON.parse(body);
      if (Object.hasOwn(twitchRoutes, req.url)) return sendJson(res, await twitchRoutes[req.url](input));
      if (req.url === '/demo') {
        demo = Boolean(input.enabled);
      } else {
        const next = { twitch: String(input.twitch || '').trim().replace(/^[@#]/, '').toLowerCase(),
          tiktok: String(input.tiktok || '').trim().replace(/^@/, ''), key: input.removeKey ? '' : String(input.key || '').trim() || settings.key };
        if (!/^[a-z\d_]{0,25}$/.test(next.twitch) || !/^[a-z\d_.]{0,32}$/i.test(next.tiktok))
          throw Error('Bitte nur Kanalnamen eingeben, ohne URL.');
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile + '.tmp', JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(configFile + '.tmp', configFile);
        settings = next;
        demo = false;
      }
      clear();
      launch();
      if (demo) sample();
      return res.writeHead(204).end();
    } catch (error) {
      const message = error.code ? 'Einstellungen konnten nicht gespeichert werden.' : error.message;
      return res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
    }
  }
  res.writeHead(404).end();
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port 17834 ist bereits belegt.' : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => { console.log('OBS Multi-Chat: ' + origin); launch(); });










