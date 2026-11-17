# OBS Multi-Chat

A native Windows dock for OBS Studio 33.0.1 (x64). Read Twitch and TikTok LIVE chat in one dock, increase the text size, and switch to uppercase. TikTok joins and gifts have separate views. Twitch supports chat messages, moderation, pinned messages, and a searchable chat-participant list after authorization.

## Install

1. Download the Windows x64 ZIP from [GitHub Releases](https://github.com/VenomSnakeTwitch/obs-multichat/releases/latest).
2. Close OBS. Extract the entire `multichat` folder into an OBS plugin directory. For portable OBS, use the `plugins` directory alongside `bin`. For a standard Windows installation, use `C:\ProgramData\obs-studio\plugins`.
3. Open OBS and select **Docks → Twitch + TikTok Chat (Multi-Chat)**.
4. Open **Einstellungen** and enter your Twitch and TikTok channel names. The dock interface is in German.

The plugin starts its bundled Node.js worker automatically and stops it when OBS exits. It uses the browser component already shipped with OBS and listens on loopback port 17834.

## Twitch

Public Twitch chat can be read without signing in. For chat, moderation and the participant list, create a [Twitch developer application](https://dev.twitch.tv/console/apps) with client type **Public**. If the registration form requires a redirect URL, enter `http://localhost:3000`. In the dock, open **Twitch-Moderation**, enter your app's Client ID and authorize your Twitch account. A moderator or broadcaster account is required for moderation. Roles are most complete when signed in as the broadcaster.

The participant list shows accounts connected to the chat, with the delay imposed by Twitch. Chatbots and subscribers are identified from badges observed in incoming messages. The list covers chat participants only. Tokens are held in memory for the OBS session.

### Get a Twitch Client ID / Twitch-Client-ID erstellen

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and sign in with your Twitch account. Twitch requires two-factor authentication for app registration.
2. Choose **Register Your Application**. Give the app a unique name, select **Chat Bot** as the category and **Public** as the client type. Enter `http://localhost:3000` under **OAuth Redirect URLs**, select **Add**, then **Create**.
3. Select **Manage** next to your app and copy the **Client ID**.
4. In OBS, open **Twitch-Moderation**, paste the ID, select **Bei Twitch anmelden**, and follow the Twitch activation link.

**Kurz auf Deutsch:** Entwicklerkonsole öffnen → **Register Your Application** → **Chat Bot**, **Public**, Weiterleitungsadresse `http://localhost:3000` hinzufügen → **Create** → **Manage** → **Client ID** kopieren. Anschließend im OBS-Dock unter **Twitch-Moderation** einfügen und die Twitch-Freigabe bestätigen.

[Twitch registration guide](https://dev.twitch.tv/docs/authentication/register-app/)


## TikTok

The TikTok channel must be publicly live. TikTok support uses the community [TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector). Availability depends on TikTok and the connector's signing service. If prompted by the dock, enter your own EulerStream API key. The key is stored locally in the OBS plugin configuration. TikTok users are identified from events such as joins, messages and gifts.

## Build

Use an x64 Visual Studio Developer Command Prompt with the MSVC C++ toolset and a Windows SDK. Run `build.cmd` at the repository root to create `build\multichat\multichat.dll`. The module targets the OBS Studio 33.0.1 and OBS Browser v3 Windows ABI.

Install the dependency tree with `npm ci --omit=dev` in `data`, then copy `data` to `build\multichat\data` and place an official Windows x64 Node.js 24 executable and its license in that directory. Distribute the full `multichat` folder. The release includes the required runtime and dependencies.

## License

This project's source is licensed under GPL-2.0-or-later. Node.js and npm dependencies retain their respective licenses.


