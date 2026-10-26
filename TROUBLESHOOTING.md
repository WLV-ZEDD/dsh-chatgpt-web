# Troubleshooting dsh-chatgpt-web

This guide covers common issues and resolutions when running `dsh-chatgpt-web` in DeepSeek Harness.

## Quick Diagnostics

Before modifying configuration, run the built-in diagnostic doctor:

```bash
dsh-chatgpt-web doctor
```

This inspects:
- Chrome / Chromium executable availability
- ChatGPT web session authentication status
- Local sidecar background daemon health (`http://127.0.0.1:17841/healthz`)

---

## Common Issues & Solutions

### 1. `ChatGPT login state is missing or unverified`
**Cause:** No active ChatGPT session is saved in the local storage profile.
**Solution:**
Run the interactive browser login:
```bash
dsh-chatgpt-web login
```
A browser window will open. Log into your OpenAI / ChatGPT account (Free or Plus/Team). Once the ChatGPT composer loads, the session cookies are safely saved to `~/.dsh/storages/chatgpt-web/`.

---

### 2. `Port 17841 is already in use`
**Cause:** An existing instance of the daemon or another background task is occupying port 17841.
**Solution:**
Identify and terminate any lingering instance, or run `doctor` to see if the running service is already healthy. If you need a custom port, configure it via:
```bash
dsh-chatgpt-web serve --port 17842
```
or configure the plugin port in your profile's Cordis configuration.

---

### 3. `Chrome executable is missing`
**Cause:** Google Chrome or Chromium could not be automatically located on the default system path.
**Solution:**
Specify your browser executable path explicitly. Login uses Chromium/Chrome driven by Playwright, and the executable can be pointed at explicitly:
```bash
dsh-chatgpt-web setup --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

---

### 4. Temporary Rate Limits or Cloudflare Verification
**Cause:** High frequency of requests in a short time frame or ChatGPT anti-bot challenge.
**Solution:**
- Wait a couple of minutes for Cloudflare challenges to settle.
- Run `dsh-chatgpt-web login` to solve any visual verification prompt directly in the visible browser if required.

### 5. Stream Disconnected or Browser Response Interrupted
**Cause:** ChatGPT web page refreshed, network connection dropped, or the Chrome browser process was closed.
**Solution:**
- Check that your internet connection is active and `chatgpt.com` is accessible.
- Verify that Chrome is open and logged in.
- Run `dsh-chatgpt-web doctor` to check proxy and session status.
- Restart the daemon if needed: `dsh-chatgpt-web serve`.

### 6. ChatGPT Rate Limits (HTTP 429)
**Cause:** Hourly prompt limit reached on the ChatGPT Free tier.
**Solution:**
- OpenAI Free accounts have hourly message limits for GPT 5.6 Luna.
- Wait for the rate-limit window to reset (typically 1–2 hours).
- Avoid spawning parallel multi-subagent requests against a single ChatGPT browser tab.

### 7. Send Button Stage Timeout in Temporary Chat
**Cause:** In `?temporary-chat=true`, ChatGPT DOM occasionally renders the prompt composer in a container element without a standard `<form>` ancestor, or localized Chinese UI uses `aria-label="发送消息"`.
**Solution:**
- Upgrade to `dsh-chatgpt-web` `>=1.0.5`, which includes multi-strategy send button resolution and localized aria-label fallbacks.

## Update and Uninstall

To update `dsh-chatgpt-web`, pull the latest changes and rebuild:
```bash
bun install
bun run build
```

To remove or disable `dsh-chatgpt-web` in DeepSeek Harness:
1. Remove the `dsh-chatgpt-web` plugin entry from your profile's `cordis.patch.yml` or `cordis.yml`.
2. Delete saved browser session data if desired:
   - On Windows: `%USERPROFILE%\.dsh\storages\chatgpt-web\`
   - On macOS/Linux: `~/.dsh/storages/chatgpt-web/`

## Submitting Bug Reports

When opening an issue or bug report on GitHub:
- Specify your OS and architecture (e.g., Windows 11 x64, macOS arm64, Linux x64).
- ChatGPT account tier (Free Tier Luna or Plus/Team).
- Node.js and Bun versions.
- Output from `dsh-chatgpt-web doctor`.
- Clear reproduction steps and console error traces.

Before sharing logs or screenshots, ensure all personal session cookies, authentication tokens, and private prompts are redacted.

