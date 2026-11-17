const moderationLogin = byId('twitch-login');
const moderationForm = byId('twitch-action');
const twitchComposer = byId('twitch-composer');
const activationLink = byId('twitch-activate');
const moderationResult = byId('twitch-result');
let selectedMessage;
let lastModerationStatus;

async function twitchRequest(route, body) {
  const response = await fetch('/twitch/' + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!response.ok) throw Error(await response.text() || 'Twitch-Anfrage fehlgeschlagen.');
  return response.json();
}

function showTwitchStatus(status) {
  const loggedIn = Boolean(status.login);
  lastModerationStatus = status;
  document.body.classList.toggle('twitch-moderating', loggedIn && !demo && Boolean(saved.twitch));
  moderationLogin.hidden = loggedIn;
  byId('twitch-logout').hidden = !loggedIn;
  twitchComposer.hidden = !loggedIn || demo || !saved.twitch;
  if (twitchComposer.hidden) moderationForm.hidden = true;
  activationLink.hidden = !status.activation;
  byId('twitch-auth-status').textContent = status.login ? 'Angemeldet als @' + status.login
    : status.error || (status.activation ? 'Auf Twitch bestätigen. Code: ' + status.activation.code : '');
  if (status.activation) activationLink.href = status.activation.url;
  else activationLink.removeAttribute('href');
  updateTwitchRoster();
}

const clientInput = moderationLogin.elements.clientId;
clientInput.value = localStorage.getItem('twitch-client-id') || '';
moderationLogin.addEventListener('submit', async event => {
  event.preventDefault();
  const button = moderationLogin.querySelector('button');
  button.disabled = true;
  try {
    const clientId = clientInput.value.trim();
    showTwitchStatus(await twitchRequest('login', { clientId }));
    localStorage.setItem('twitch-client-id', clientId);
  } catch (error) { byId('twitch-auth-status').textContent = error.message; }
  finally { button.disabled = false; }
});

byId('twitch-logout').onclick = async () => {
  try { showTwitchStatus(await twitchRequest('logout', {})); }
  catch (error) { byId('twitch-auth-status').textContent = error.message; }
};

async function syncTwitchStatus() {
  try {
    const status = await twitchRequest('status');
    if (JSON.stringify(lastModerationStatus) !== JSON.stringify(status)) showTwitchStatus(status);
  } catch {
    if (lastModerationStatus?.login) showTwitchStatus({ error: 'Lokaler Chat-Dienst getrennt.' });
  } finally { setTimeout(syncTwitchStatus, 3000); }
}
on('snapshot', () => {
  if (lastModerationStatus) showTwitchStatus(lastModerationStatus);
  moderationForm.hidden = true;
});
syncTwitchStatus();

function showActionFields() {
  const action = moderationForm.elements.action.value;
  const seconds = moderationForm.elements.duration;
  const reason = moderationForm.elements.reason;
  seconds.disabled = !['pin','timeout'].includes(action);
  seconds.closest('label').hidden = seconds.disabled;
  seconds.required = action === 'timeout';
  seconds.min = action === 'pin' ? '30' : '1';
  seconds.max = action === 'pin' ? '1800' : '1209600';
  seconds.value = action === 'timeout' ? '600' : '';
  reason.disabled = !['timeout','ban'].includes(action);
  reason.closest('label').hidden = reason.disabled;
}
moderationForm.elements.action.onchange = showActionFields;
byId('twitch-cancel-action').onclick = () => { moderationForm.hidden = true; };

feed.addEventListener('click', event => {
  const button = event.target.closest('button[data-message-id]');
  if (!button) return;
  selectedMessage = button.dataset.messageId;
  byId('twitch-action-target').textContent = button.closest('li').querySelector('.name').textContent;
  moderationForm.reset();
  showActionFields();
  moderationForm.hidden = false;
  moderationForm.elements.action.focus();
});

async function runTwitchCommand(form, data) {
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  moderationResult.textContent = '';
  try {
    const response = await twitchRequest('command', data);
    moderationResult.textContent = response.message;
    return true;
  } catch (error) { moderationResult.textContent = error.message; }
  finally { submit.disabled = false; }
}
moderationForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(moderationForm));
  if (await runTwitchCommand(moderationForm, { ...input, id: selectedMessage })) moderationForm.hidden = true;
});
twitchComposer.addEventListener('submit', async event => {
  event.preventDefault();
  const input = twitchComposer.elements.message;
  const text = input.value;
  if (await runTwitchCommand(twitchComposer, { text }) && input.value === text) input.value = '';
});

const twitchPeopleSummary = byId('twitch-people-summary');
const twitchPeopleList = byId('twitch-people-list');
const twitchPeopleSearch = byId('twitch-people-search');
const twitchPeopleRefresh = byId('twitch-people-refresh');
const twitchRoleOrder = ['Kanalinhaber', 'Moderator', 'VIP', 'Chatbot', 'Abonnent'];
let twitchRosterContext = '';
let twitchRoster;
let rosterGeneration = 0;
let rosterLoading = false;

function drawTwitchRoster() {
  const fragment = document.createDocumentFragment();
  const query = twitchPeopleSearch.value.trim().toLowerCase();
  const roleRank = user => twitchRoleOrder.findIndex(role => user.roles.includes(role));
  const rank = user => user.roles.length ? roleRank(user) : twitchRoleOrder.length;
  const matches = (twitchRoster?.users || []).filter(user => [user.name, '@' + user.login, ...user.roles]
    .some(value => value.toLowerCase().includes(query)));
  matches.sort((a, b) => rank(a) - rank(b) || a.login.localeCompare(b.login));
  for (const user of matches) {
    const row = node('li');
    row.append(node('div', user.name, 'name'),
      node('div', '@' + user.login + ' · ' + (user.roles.join(', ') || 'Chat-Teilnehmer'), 'row-meta'));
    fragment.append(row);
  }
  if (query && twitchRoster && !matches.length) fragment.append(node('li', 'Keine passenden Nutzer.'));
  twitchPeopleList.replaceChildren(fragment);
}

async function updateTwitchRoster() {
  if (view !== 'twitch-people') return;
  const account = lastModerationStatus?.login;
  const channel = saved.twitch;
  const context = JSON.stringify([account, channel, demo]);
  if (context !== twitchRosterContext) {
    twitchRosterContext = context;
    rosterGeneration++;
    twitchRoster = undefined;
    rosterLoading = false;
    drawTwitchRoster();
  }
  twitchPeopleRefresh.disabled = !account || !channel || demo || rosterLoading;
  if (!account || !channel || demo) {
    twitchPeopleSummary.textContent = demo ? 'Beende die Demo, um Twitch-Nutzer zu laden.'
      : !channel ? 'Trage zuerst einen Twitch-Kanal ein.'
      : 'Melde dich unter Twitch-Moderation an, um die Nutzerliste zu laden.';
    return;
  }
  if (rosterLoading) return;
  const generation = rosterGeneration;
  rosterLoading = true;
  twitchPeopleRefresh.disabled = true;
  if (!twitchRoster) twitchPeopleSummary.textContent = 'Twitch-Nutzer werden geladen …';
  try {
    const result = await twitchRequest('chatters', {});
    if (generation !== rosterGeneration) return;
    twitchRoster = result;
    twitchPeopleSummary.textContent = result.users.length + ' im Twitch-Chat · ' +
      (result.owner ? 'Kanalrollen von Twitch' : 'Rollen aus Chat-Abzeichen') + ' · ' + time.format(Date.now());
    drawTwitchRoster();
  } catch (error) {
    if (generation === rosterGeneration) twitchPeopleSummary.textContent =
      (twitchRoster ? 'Letzter Stand · ' : '') + error.message;
  } finally {
    if (generation === rosterGeneration) {
      rosterLoading = false;
      twitchPeopleRefresh.disabled = false;
    }
  }
}
twitchPeopleSearch.oninput = drawTwitchRoster;
twitchPeopleRefresh.onclick = updateTwitchRoster;
byId('tabs').addEventListener('click', event => {
  if (event.target.closest('[data-view="twitch-people"]')) updateTwitchRoster();
});
on('snapshot', updateTwitchRoster);
setInterval(updateTwitchRoster, 30000);
