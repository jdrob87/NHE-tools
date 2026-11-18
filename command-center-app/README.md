# NHE Team Command Center

A small phone web app for a team lead. Open it from a home-screen shortcut, read the command center, dictate or type a reply on anything waiting on you, and send it to Tony. The server forwards each reply to a webhook. The browser never sees the webhook address or key.

The board behind the passcode shows Waiting on you, In progress, Recently done, Deals, the next two weeks, what each bot is doing, Inbox, quick links, top counts, and a latest team activity feed.

This repository is public. Do not commit passcodes, webhook URLs, keys, or real client, deal, family, or bot data. Those live only in environment variables on the host. `items.example.json` and `dashboard.example.json` are fictional.

## Run locally

```bash
cd command-center-app
export PORT=3000
export PASSCODE='choose-a-long-passcode'
export SESSION_SECRET='choose-at-least-16-characters'
export ITEMS_JSON="$(node -e "process.stdout.write(JSON.stringify(require('./items.example.json')))")"
export DASHBOARD_JSON="$(node -e "process.stdout.write(JSON.stringify(require('./dashboard.example.json')))")"
export WEBHOOK_URL='https://example.com/hooks/command-center'
export WEBHOOK_KEY='replace-with-the-webhook-key'
node server.js
```

`items.example.json` and `dashboard.example.json` are fake sample data. Replace `ITEMS_JSON` and `DASHBOARD_JSON` with the real board in the host environment. Do not commit that board.

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
| `DASHBOARD_JSON` | no | JSON object for the rest of the board. See below. Invalid JSON stops startup. |
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

## DASHBOARD_JSON

Set this on the existing Render service when the full board should replace the sample. It is one JSON object. Unknown keys are ignored. A value that does not match the schema stops startup with a message that names `DASHBOARD_JSON` and does not print the value.

Waiting on you is resolved in this order:

1. If `DASHBOARD_JSON.waiting` is a non-empty array, that array is the list. Each item uses the same shape as `ITEMS_JSON`.
2. Otherwise the server uses `ITEMS_JSON`.
3. If both are missing or empty, the waiting list is empty.

An empty `waiting` array falls back to `ITEMS_JSON`. A missing `DASHBOARD_JSON`, or one that is only whitespace, does too. `GET /api/items` stays the waiting list, including the `done` flag. `GET /api/dashboard` is the other sections and requires the same session. Calendar and family rows are not in the login HTML and are not returned until sign-in.

```ts
type StatusTone = "warning" | "done" | "neutral";
type WaitingItem = {
  id: string;          // required, unique, <=80
  title: string;       // required, <=200
  detail?: string;     // <=2000
  lead?: string;       // short badge, kept up to 8 characters
  meta?: string;       // <=120
  status?: { label: string; tone?: StatusTone };
};

type Dashboard = {
  updatedAt?: string;           // ISO-8601. Shown as "Updated …" on the header and every section.
  summary?: string;             // one-line header caption, <=300
  waiting?: WaitingItem[];      // optional; else ITEMS_JSON
  inProgress?: Array<{ who: string; what: string; last?: string }>;
  done?: Array<{ text: string; meta?: string; done?: boolean }>; // done defaults true
  deals?: Array<{ deal: string; stage?: string; stands?: string; next?: string }>;
  events?: Array<{ date: string; title: string; lane: "work" | "family" }>; // date YYYY-MM-DD
  calendarMonth?: string;       // YYYY-MM. Default: calendarToday's month, else the first event's month, else today.
  calendarToday?: string;       // YYYY-MM-DD highlight. Default: today's UTC date.
  bots?: Array<{
    bot: string;
    focus: string;
    last?: string;
    state: "you" | "active" | "hold";
  }>;
  inbox?: Array<{ label: string; value: string }>;
  links?: Array<{ title: string; href: string; site?: string }>; // href must be http or https
  activity?: Array<{ at: string; who: string; text: string }>;   // ISO-8601 at. Newest first.
};
```

`status.tone` of `success` is stored as `done`, matching `ITEMS_JSON`. There is one `updatedAt` for the whole board. The phone repeats it on each section.

The signed-in `GET /api/dashboard` body is that object without `waiting`, plus:

```json
{
  "counts": {
    "waiting": 0,
    "inProgress": 0,
    "deals": 0,
    "botsWaiting": 0
  }
}
```

`counts.waiting` is the resolved waiting list length. `counts.botsWaiting` counts bots whose `state` is `you`. The number in the Waiting card on the phone is the items not marked done on that phone, so it drops when the Done switch is used. Activity is sorted newest first even if the JSON is not.

On the phone:

- Counts sit in a sticky row: Waiting, In progress, Deals, Bots on you.
- Latest team activity is the `activity` feed.
- Waiting on you keeps Respond and the Done switch. The webhook body is unchanged. Rows marked done on the phone stay in the Done section.
- Recently done is `done` from the dashboard. It is separate from the phone's Done section.
- Next two weeks lists events in the 14 days starting on `calendarToday`. Chips are All, Work, and Family. The month grid shows `calendarMonth` and the next month when those 14 days cross a boundary. Dots follow the selected chip.
- What each bot is doing has chips All, Waiting on you, and Active. Pills are Waiting on you (`you`), Active (`active`), and On hold (`hold`). Hold stays visible on All.
- Inbox is label plus value. Quick links open `http` or `https` URLs in a new tab.

Copy `dashboard.example.json` as the shape. Put the real object in the Render environment for the existing service. Saving the variable restarts that service. No new service is required. `ITEMS_JSON` can stay in place as the waiting fallback.

## Login limits

Failed passcode attempts are limited to 5 per 10 minutes per client. The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and lasts 90 days. On a phone home-screen app opened over HTTPS, that keeps the lead signed in. Local browser checks work on `http://localhost` and `http://127.0.0.1`, which still accept a Secure cookie.
