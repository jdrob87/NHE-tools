# NHE Team Command Center

A small phone web app for a team lead. Open it from a home-screen shortcut, read the items waiting on you, dictate or type a reply, and send it to Tony. The server forwards each reply to a webhook. The browser never sees the webhook address or key.

This repository is public. Do not commit passcodes, webhook URLs, keys, or real item lists. Those live only in environment variables on the host.

## Run locally

```bash
cd command-center-app
export PORT=3000
export PASSCODE='choose-a-long-passcode'
export SESSION_SECRET='choose-at-least-16-characters'
export ITEMS_JSON="$(node -e "process.stdout.write(JSON.stringify(require('./items.example.json')))")"
export WEBHOOK_URL='https://example.com/hooks/command-center'
export WEBHOOK_KEY='replace-with-the-webhook-key'
node server.js
```

`items.example.json` is fake sample data. Replace `ITEMS_JSON` with the real list in the host environment.

`npm install` succeeds and installs nothing. There is no build step.

```bash
npm test
```

## Render

Create a Node web service from this repo with the root directory left at the repository root.

- Build command: `cd command-center-app && npm install`
- Start command: `cd command-center-app && node server.js`

The process listens on `process.env.PORT` and binds `0.0.0.0`. Render sets `PORT`. A health check can use `/`.

Set the variables below in the Render dashboard. Do not put them in the repo. `PORT` does not need to be set by hand on Render.

Done flags held in server memory reset when the service restarts or spins down. The phone also stores done ids in `localStorage`, so items stay in Done on that device.

Each item may include optional `lead` (short badge text), `meta` (a gray line such as "Since Nov 16"), and `status` (`{ "label", "tone" }` where tone is `warning`, `done`, or `neutral`). Missing fields are omitted. `items.example.json` shows the shape with fictional rows.

The Done switch posts immediately with an empty `response` and `done` true or false. A reply from the Respond sheet still requires text. Mic dictation uses the browser Web Speech API when `SpeechRecognition` or `webkitSpeechRecognition` exists. Otherwise the mic is hidden and the sheet says to use the keyboard microphone key. iOS Safari needs HTTPS and a tap, and it often ends a session after one phrase. Firefox and most in-app browsers do not expose the API.

## Home screen

In Safari on the iPhone: Share, Add to Home Screen. The icon is labeled NHE, the document title is NHE Team Command Center, and `apple-mobile-web-app-capable` opens it full screen. Sign in once. The cookie lasts 90 days.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | yes on the host | TCP port. Render injects this. |
| `PASSCODE` | yes | Exact passcode for the login page. Matched in constant time. |
| `SESSION_SECRET` | yes | HMAC key for the session cookie. At least 16 characters. |
| `ITEMS_JSON` | no | JSON array of `{id, title, detail, lead?, meta?, status?}`. Missing or empty means an empty list. Invalid JSON stops startup. |
| `WEBHOOK_URL` | to send | Where replies are POSTed. `http:` or `https:`. |
| `WEBHOOK_KEY` | to send | Secret sent with each webhook request. Never sent to the browser. |
| `WEBHOOK_AUTH_HEADER` | no | Header name for the key. Default `Authorization`. When the name is `Authorization` (any case), the value is `Bearer <key>`. Any other name sends the raw key. |

Each webhook body is JSON:

```json
{
  "source": "command-center-phone",
  "itemId": "fake-1",
  "itemTitle": "Call the example seller",
  "response": "Left a voicemail.",
  "done": true,
  "sentAt": "2026-01-01T00:00:00.000Z"
}
```

`itemTitle` and `sentAt` come from the server. If the webhook is missing or returns a non-2xx status, the page shows an error and the item is not marked done.

## Login limits

Failed passcode attempts are limited to 5 per 10 minutes per client. The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and lasts 90 days. On a phone home-screen app opened over HTTPS, that keeps the lead signed in. Local browser checks work on `http://localhost` and `http://127.0.0.1`, which still accept a Secure cookie.
