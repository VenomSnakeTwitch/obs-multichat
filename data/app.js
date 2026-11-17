const byId = id => document.getElementById(id);
const feed = byId('feed');
const roster = byId('people');
const main = document.querySelector('main');
const form = byId('channels');
const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
let entries = [];
let people = new Map();
let view = 'all';
let demo = false;
let saved = {};
let viewerCount = null;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function label(platform) { return platform === 'twitch' ? 'Twitch' : 'TikTok'; }
function matches(item) { return view === 'all' || item.platform === view || item.kind === view; }
function drawEntry(item) {
  const row = node('li', undefined, item.kind);
  const meta = node('div', undefined, 'row-meta');
  const kind = { gift: ' · Geschenk', join: ' · Beitritt' }[item.kind] || '';
  meta.append(node('span', label(item.platform) + kind, item.platform), node('time', time.format(item.time)));
  if (item.platform === 'twitch' && item.id) {
    const action = node('button', 'Aktionen', 'twitch-message-action');
    action.type = 'button';
    action.dataset.messageId = item.id;
    action.setAttribute('aria-label', 'Twitch-Aktionen für ' + item.user);
    meta.append(action);
  }
  const message = node('div', undefined, 'message');
  const chars = Array.from(item.text);
  let cursor = 0;
  const emotes = [...(item.emotes || [])].sort((a, b) => a.start - b.start);
  for (const emote of emotes) {
    if (!Number.isInteger(emote.start) || !Number.isInteger(emote.end) || emote.start < cursor ||
        emote.end < emote.start || emote.end >= chars.length) continue;
    message.append(chars.slice(cursor, emote.start).join(''));
    const img = node('img');
    img.alt = chars.slice(emote.start, emote.end + 1).join('');
    img.src = 'https://static-cdn.jtvnw.net/emoticons/v2/' + encodeURIComponent(emote.id) + '/default/dark/2.0';
    img.addEventListener('error', () => img.replaceWith(img.alt));
    message.append(img);
    cursor = emote.end + 1;
  }
  message.append(chars.slice(cursor).join(''));
  row.append(meta, node('div', item.user, 'name'), message);
  feed.append(row);
}
function drawPeople() {
  roster.replaceChildren();
  for (const person of [...people.values()].reverse()) {
    const row = node('li');
    row.append(node('div', person.user, 'name'), node('div', '@' + person.handle + ' · ' +
      ({ join: 'Beitritt', chat: 'Kommentar', gift: 'Geschenk' })[person.event] + ' · ' + time.format(person.time), 'row-meta'));
    roster.append(row);
  }
  byId('viewers').textContent = viewerCount === null ? '' : viewerCount.toLocaleString('de-DE') + ' Zuschauer laut TikTok';
}
function bottom() { return main.scrollHeight - main.scrollTop - main.clientHeight < 35; }
function jump() { main.scrollTop = main.scrollHeight; byId('latest').hidden = true; }
function empty() {
  byId('empty').hidden = view === 'people' ? !!people.size : !!feed.childElementCount;
  byId('empty').textContent = view === 'people' ? 'Noch keine Nutzer erkannt.'
    : view === 'gift' ? 'Noch keine Geschenke empfangen.' : 'Warte auf Nachrichten.';
}
function render() {
  const twitchPeople = view === 'twitch-people';
  byId('twitch-people').hidden = !twitchPeople;
  if (twitchPeople) {
    feed.hidden = roster.hidden = byId('people-info').hidden = byId('empty').hidden = true;
    byId('latest').hidden = true;
    return;
  }
  const rosterView = view === 'people';
  feed.hidden = rosterView;
  roster.hidden = byId('people-info').hidden = !rosterView;
  feed.replaceChildren();
  if (rosterView) drawPeople();
  else entries.filter(matches).forEach(drawEntry);
  empty();
}
function drawStatus(status) {
  for (const platform of ['twitch', 'tiktok']) byId(platform).textContent = label(platform) + ' · ' + (status[platform] || 'Startet …');
}
function applySettings() {
  form.elements.twitch.value = saved.twitch;
  form.elements.tiktok.value = saved.tiktok;
  form.elements.key.placeholder = saved.hasKey ? 'Schlüssel gespeichert' : 'Optional, falls erforderlich';
  byId('remove-key').hidden = !saved.hasKey;
  byId('demo').textContent = demo ? 'Demo beenden' : 'Demo starten';
}
const events = new EventSource('/events');
function on(event, callback) { events.addEventListener(event, ({ data }) => callback(JSON.parse(data))); }
events.onopen = () => { byId('connection').textContent = ''; };
events.onerror = () => { byId('connection').textContent = 'Lokaler Dienst getrennt'; };
on('snapshot', data => {
  entries = data.entries;
  people = new Map(data.people);
  viewerCount = data.viewerCount;
  demo = data.demo;
  const changed = JSON.stringify(saved) !== JSON.stringify(data.settings);
  saved = data.settings;
  if (changed || !byId('settings').open) applySettings();
  byId('demo').textContent = demo ? 'Demo beenden' : 'Demo starten';
  if (!saved.twitch && !saved.tiktok && !demo) byId('settings').open = true;
  drawStatus(data.status);
  render();
  if (view !== 'people' && view !== 'twitch-people') jump();
});
on('status', drawStatus);
on('entry', item => {
  const follow = bottom();
  entries.push(item);
  if (entries.length > 1000 && matches(entries.shift()) && view !== 'people') feed.firstElementChild?.remove();
  if (view === 'people' || !matches(item)) return;
  drawEntry(item);
  empty();
  if (follow) jump();
  else byId('latest').hidden = false;
});
on('person', person => {
  people.delete(person.id);
  people.set(person.id, person);
  if (people.size > 500) people.delete(people.keys().next().value);
  if (view === 'people') { drawPeople(); empty(); }
});
on('count', count => {
  viewerCount = count;
  if (view === 'people') byId('viewers').textContent = count === null ? '' : count.toLocaleString('de-DE') + ' Zuschauer laut TikTok';
});
on('remove', ({ id, userId }) => {
  const follow = bottom();
  entries = entries.filter(item => item.platform !== 'twitch' ||
    (id ? item.id !== id : userId && item.userId !== userId));
  if (view !== 'people') { render(); if (follow) jump(); }
});
byId('tabs').addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  view = button.dataset.view;
  for (const tab of byId('tabs').querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab === button));
  render();
  if (view === 'people' || view === 'twitch-people') { main.scrollTop = 0; byId('latest').hidden = true; }
  else jump();
});
byId('latest').onclick = jump;
main.addEventListener('scroll', () => { if (bottom()) byId('latest').hidden = true; });
async function post(url, data) {
  byId('error').textContent = '';
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!response.ok) throw Error(await response.text() || 'Anfrage fehlgeschlagen.');
    return true;
  } catch (error) { byId('error').textContent = error.message; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(form));
  if (await post('/settings', input)) {
    form.elements.key.value = '';
    form.elements.removeKey.checked = false;
    byId('settings').open = false;
  }
});
byId('demo').onclick = async () => {
  if (await post('/demo', { enabled: !demo })) byId('settings').open = false;
};
const size = byId('size');
const caps = byId('caps');
const storedSize = localStorage.getItem('chat-size');
if ([...size.options].some(option => option.value === storedSize)) size.value = storedSize;
caps.checked = localStorage.getItem('chat-caps') === 'true';
function typography() {
  document.documentElement.style.setProperty('--chat-size', size.value + 'px');
  document.body.classList.toggle('caps', caps.checked);
  localStorage.setItem('chat-size', size.value);
  localStorage.setItem('chat-caps', String(caps.checked));
}
size.onchange = caps.onchange = typography;
typography();



