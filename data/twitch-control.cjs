const scopes = [
  'user:write:chat', 'moderator:manage:banned_users', 'moderator:manage:chat_messages',
  'moderator:manage:announcements', 'moderator:manage:chat_settings', 'moderator:manage:shoutouts',
  'moderator:read:chatters', 'moderation:read', 'channel:read:vips'
].join(' ');
const loginName = value => /^[a-z0-9_]{1,25}$/i.test(value);
const messageId = value => /^[a-f0-9-]{36}$/i.test(value);

function duration(value, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw Error('Dauer in Sekunden eingeben (' + min + '–' + max + ').');
  return Number(value);
}

module.exports = function twitchControl({ getChannel, isDemo, getEntry, getBadges, request = fetch }) {
  let account;
  let activation;
  let authError = '';
  let revision = 0;
  let refresh;
  const oauth = (route, params) => request('https://id.twitch.tv/oauth2/' + route, {
    method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(10000)
  });

  const validate = token => request('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + token }, signal: AbortSignal.timeout(10000)
  });

  async function acceptToken(clientId, response) {
    const token = await response.json();
    const validation = await validate(token.access_token);
    if (!validation.ok) throw Error('Twitch konnte die Anmeldung nicht bestätigen.');
    const identity = await validation.json();
    if (identity.client_id !== clientId || !identity.user_id ||
        scopes.split(' ').some(scope => !identity.scopes?.includes(scope)))
      throw Error('Die Twitch-Anmeldung hat nicht alle benötigten Berechtigungen.');
    return { clientId, id: identity.user_id, login: identity.login, token: token.access_token,
      refreshToken: token.refresh_token, validatedAt: Date.now(), expires: Date.now() + 1000 * token.expires_in };
  }

  async function begin(clientId) {
    if (!/^[a-z0-9]{20,64}$/i.test(clientId)) throw Error('Eine gültige Twitch-Client-ID eingeben.');
    const version = ++revision;
    account = undefined;
    activation = undefined;
    authError = '';
    const response = await oauth('device', { client_id: clientId, scopes });
    const result = await response.json();
    if (version !== revision) return status();
    if (!response.ok) throw Error('Twitch-Anmeldung konnte nicht gestartet werden. Client-ID und App-Typ „Public“ prüfen.');
    const url = new URL(result.verification_uri);
    if (url.origin !== 'https://www.twitch.tv' || url.pathname !== '/activate') throw Error('Unerwartete Twitch-Aktivierungsseite.');
    let wait = Math.max(Number(result.interval) || 5, 5) * 1000;
    const expires = Date.now() + result.expires_in * 1000;
    activation = { url: url.href, code: result.user_code };

    async function poll() {
      if (version !== revision) return;
      try {
        if (Date.now() >= expires) throw Error('Der Twitch-Code ist abgelaufen. Erneut anmelden.');
        const token = await oauth('token', { client_id: clientId, scopes, device_code: result.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (version !== revision) return;
        if (token.ok) {
          const identity = await acceptToken(clientId, token);
          if (version === revision) { account = identity; activation = undefined; }
          return;
        }
        const { message } = await token.json();
        if (message === 'slow_down') wait += 5000;
        else if (message !== 'authorization_pending') throw Error('Die Twitch-Anmeldung wurde nicht abgeschlossen. Erneut anmelden.');
        setTimeout(poll, wait).unref();
      } catch (error) {
        if (version === revision) { authError = error.message; activation = undefined; }
      }
    }
    setTimeout(poll, wait).unref();
    return status();
  }

  function status() {
    return { login: account?.login, activation, error: authError };
  }

  async function validAccount() {
    const current = account;
    if (!current) throw Error('Zuerst im Dock bei Twitch anmelden.');
    if (current.expires - Date.now() > 60000) return current;
    if (!refresh || refresh.account !== current) {
      const promise = (async () => {
        const response = await oauth('token', { client_id: current.clientId, grant_type: 'refresh_token',
          refresh_token: current.refreshToken });
        if (!response.ok) {
          if (account === current && response.status < 500 && response.status !== 429) account = undefined;
          throw Error('Twitch-Anmeldung konnte nicht erneuert werden.');
        }
        const renewed = await acceptToken(current.clientId, response);
        if (account === current) account = renewed;
        return renewed;
      })();
      refresh = { account: current, promise };
    }
    const pending = refresh;
    try { return await pending.promise; }
    finally { if (refresh === pending) refresh = undefined; }
  }

  async function channelContext() {
    if (isDemo()) throw Error('Zuerst die Demo beenden.');
    const channel = getChannel();
    if (!channel) throw Error('Zuerst einen Twitch-Kanal eintragen.');
    const version = revision;
    const actor = await validAccount();
    async function api(method, route, query = {}, body) {
      if (account !== actor || revision !== version || getChannel() !== channel || isDemo())
        throw Error('Twitch-Kanal oder Anmeldung wurde inzwischen geändert.');
      const url = new URL('https://api.twitch.tv/helix/' + route);
      url.search = new URLSearchParams(query);
      const response = await request(url, {
        method, headers: { 'Client-Id': actor.clientId, Authorization: 'Bearer ' + actor.token,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000)
      });
      if (response.status === 204) return {};
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 && account === actor) account = undefined;
        throw Error('Twitch (' + response.status + '): ' + (payload.message || 'Aktion fehlgeschlagen.'));
      }
      return payload;
    }
    const helix = async (...args) => (await api(...args)).data || [];
    async function lookup(login) {
      const name = String(login || '').replace(/^@/, '');
      if (!loginName(name)) throw Error('Einen gültigen Twitch-Nutzernamen angeben.');
      const [user] = await helix('GET', 'users', { login: name });
      if (!user) throw Error('Twitch-Nutzer @' + name + ' wurde nicht gefunden.');
      return user.id;
    }
    const broadcaster_id = channel === actor.login ? actor.id : await lookup(channel);
    return { actor, api, helix, lookup, moderator: { broadcaster_id, moderator_id: actor.id } };
  }

  let rosterRequest;
  async function chatters() {
    if (!account) throw Error('Für die Nutzerliste unter Twitch-Moderation anmelden.');
    const key = account.id + ':' + getChannel() + ':' + revision;
    if (rosterRequest?.key === key && Date.now() - rosterRequest.time < 20000 && !isDemo())
      return rosterRequest.promise;
    const pending = { key, time: Date.now(), promise: loadChatters() };
    rosterRequest = pending;
    try { return await pending.promise; }
    catch (error) {
      if (rosterRequest === pending) rosterRequest = undefined;
      throw error;
    }
  }

  async function loadChatters() {
    const { actor, api, moderator } = await channelContext();
    const { broadcaster_id } = moderator;
    const owner = actor.id === broadcaster_id;
    async function pages(route, params, first) {
      const users = new Map();
      let cursor;
      let previous;
      do {
        previous = cursor;
        const page = await api('GET', route, { ...params, first, ...(cursor ? { after: cursor } : {}) });
        for (const user of page.data || []) users.set(user.user_id, user);
        cursor = page.pagination?.cursor;
        if (cursor && cursor === previous) throw Error('Twitch hat dieselbe Seite mehrfach geliefert.');
      } while (cursor);
      return users;
    }
    const [chat, mods, vips] = await Promise.all([
      pages('chat/chatters', moderator, 1000),
      owner ? pages('moderation/moderators', { broadcaster_id }, 100) : new Map(),
      owner ? pages('channels/vips', { broadcaster_id }, 100) : new Map()
    ]);
    const badges = getBadges();
    return { owner, users: [...chat.values()].map(user => {
      const id = user.user_id;
      const observed = badges.get(id) || [];
      const roles = [];
      if (id === broadcaster_id) roles.push('Kanalinhaber');
      else {
        if (mods.has(id) || (!owner && (id === actor.id || observed.includes('moderator')))) roles.push('Moderator');
        if (vips.has(id) || (!owner && observed.includes('vip'))) roles.push('VIP');
      }
      if (observed.includes('bot-badge')) roles.push('Chatbot');
      if (observed.includes('subscriber') || observed.includes('founder')) roles.push('Abonnent');
      return { login: user.user_login, name: user.user_name, roles };
    }) };
  }

  async function command(input) {
    const { actor, helix, lookup, moderator } = await channelContext();
    const { broadcaster_id } = moderator;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const parsed = text.match(/^\/(\S+)(?:\s+(.*))?$/s);
    const action = input.action || (parsed ? parsed[1].toLowerCase() : 'send');
    const argument = parsed?.[2]?.trim() || '';
    const [target, seconds, ...reason] = argument.split(/\s+/);
    const row = input.id ? getEntry(input.id) : null;
    if (input.id && !row) throw Error('Diese Twitch-Nachricht ist nicht mehr im Verlauf.');
    const supported = ['send','timeout','ban','unban','untimeout','pin','unpin','delete','clear',
      'announce','slow','slowoff','followers','followersoff','subscribers','subscribersoff',
      'emoteonly','emoteonlyoff','uniquechat','uniquechatoff','shoutout'];
    if (!supported.includes(action)) throw Error('Dieser Twitch-Befehl wird im Dock nicht unterstützt.');
    if (action === 'send') {
      if (!text || Array.from(text).length > 500) throw Error('Die Nachricht muss 1–500 Zeichen enthalten.');
      const [sent] = await helix('POST', 'chat/messages', {}, { broadcaster_id, sender_id: actor.id, message: text });
      if (!sent?.is_sent) throw Error(sent?.drop_reason?.message || 'Twitch hat die Nachricht nicht gesendet.');
      return 'Nachricht gesendet.';
    }
    if (['timeout','ban','unban','untimeout'].includes(action)) {
      const user_id = row?.userId || await lookup(target);
      if (action === 'unban' || action === 'untimeout') {
        await helix('DELETE', 'moderation/bans', { ...moderator, user_id });
        return 'Sperre aufgehoben.';
      }
      const data = { user_id };
      const explanation = row ? String(input.reason || '').trim() : action === 'ban'
        ? argument.slice(target.length).trim() : reason.join(' ');
      if (explanation.length > 500) throw Error('Die Begründung darf höchstens 500 Zeichen lang sein.');
      if (explanation) data.reason = explanation;
      if (action === 'timeout') data.duration = duration(row ? String(input.duration) : seconds || '600', 1, 1209600);
      await helix('POST', 'moderation/bans', moderator, { data });
      return action === 'ban' ? 'Nutzer gebannt.' : 'Timeout gesetzt (' + data.duration + ' s).';
    }
    if (action === 'pin' || action === 'unpin') {
      let id = row?.id || target;
      if (!id && action === 'unpin') {
        const [pinned] = await helix('GET', 'chat/pins', moderator);
        if (!pinned) throw Error('Derzeit ist keine Twitch-Nachricht angepinnt.');
        id = pinned.message_id;
      }
      if (!messageId(id)) throw Error('Eine Twitch-Nachricht auswählen oder ihre Nachrichten-ID angeben.');
      const query = { ...moderator, message_id: id };
      const pinDuration = row ? String(input.duration || '') : seconds;
      if (action === 'pin' && pinDuration) query.duration_seconds = duration(pinDuration, 30, 1800);
      await helix(action === 'pin' ? 'PUT' : 'DELETE', 'chat/pins', query);
      return action === 'pin' ? 'Nachricht auf Twitch angepinnt.' : 'Twitch-Pin entfernt.';
    }
    if (action === 'delete' || action === 'clear') {
      const id = row?.id || target;
      if (action === 'delete' && !messageId(id)) throw Error('Eine Twitch-Nachricht auswählen oder ihre Nachrichten-ID angeben.');
      await helix('DELETE', 'moderation/chat', action === 'delete' ? { ...moderator, message_id: id } : moderator);
      return action === 'delete' ? 'Nachricht gelöscht.' : 'Twitch-Chat geleert.';
    }
    if (action === 'announce') {
      if (!argument || Array.from(argument).length > 500) throw Error('Eine Ankündigung mit 1–500 Zeichen eingeben.');
      await helix('POST', 'chat/announcements', moderator, { message: argument });
      return 'Ankündigung gesendet.';
    }
    if (action === 'shoutout') {
      const to_broadcaster_id = await lookup(target);
      await helix('POST', 'chat/shoutouts', { from_broadcaster_id: broadcaster_id, to_broadcaster_id, moderator_id: actor.id });
      return 'Shoutout gesendet.';
    }
    const roomModes = { slow: 'slow_mode', followers: 'follower_mode', subscribers: 'subscriber_mode',
      emoteonly: 'emote_mode', uniquechat: 'unique_chat_mode' };
    const key = action.replace(/off$/, '');
    const enabled = key === action;
    const body = { [roomModes[key]]: enabled };
    if (enabled && key === 'slow') body.slow_mode_wait_time = duration(target || '30', 3, 120);
    if (enabled && key === 'followers') body.follower_mode_duration = duration(target || '0', 0, 129600);
    await helix('PATCH', 'chat/settings', moderator, body);
    return 'Twitch-Chatmodus aktualisiert.';
  }

  setInterval(async () => {
    const current = account;
    if (!current || Date.now() - current.validatedAt < 59 * 60000) return;
    try {
      if (current.expires - Date.now() <= 60000) {
        await validAccount();
        return;
      }
      const response = await validate(current.token);
      if (account !== current) return;
      if (response.status === 401) {
        account = undefined;
        authError = 'Twitch-Anmeldung abgelaufen. Erneut anmelden.';
      } else if (response.ok) {
        current.validatedAt = Date.now();
      }
      await response.body?.cancel();
    } catch {
      // Try again on the next interval if Twitch is temporarily unreachable.
    }
  }, 60000).unref();

  return { begin, status, command, chatters, logout() { ++revision; account = activation = undefined; authError = ''; return status(); } };
};




