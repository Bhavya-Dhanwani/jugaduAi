# ChatGPT Puppeteer API

An Express API that controls ChatGPT through a headless Chrome browser using Puppeteer. It lets you create separate ChatGPT pages, send messages to each page, and run multiple chats with concurrency limits.

## What It Does

- Starts Chrome with remote debugging enabled.
- Connects Puppeteer to that Chrome instance.
- Loads cookies from `./cookies/chatgpt.json`.
- Opens one ChatGPT page per API session.
- Sends messages to a selected page.
- Limits how many pages and messages run at the same time.

## Requirements

- Node.js 18 or newer.
- Google Chrome installed.
- A valid ChatGPT cookie file at:

```txt
cookies/chatgpt.json
```

The cookie file must contain a JSON array of Puppeteer-compatible cookies.

## Install

```bash
npm install
```

## Start

```bash
npm start
```

The API starts at:

```txt
http://localhost:3000
```

## Environment Variables

You can tune the server with environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Express server port |
| `CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome executable path |
| `CHROME_DEBUG_PORT` | `9222` | Chrome remote debugging port |
| `CHROME_USER_DATA_DIR` | `C:\chrome-debug` | Chrome profile folder |
| `COOKIES_PATH` | `./cookies/chatgpt.json` | Cookie JSON file path |
| `MAX_SESSIONS` | `20` | Maximum open ChatGPT pages |
| `MAX_CONCURRENT_PAGE_CREATES` | `3` | Maximum pages loading at once |
| `MAX_CONCURRENT_MESSAGES` | `5` | Maximum messages generating at once |

PowerShell example:

```powershell
$env:MAX_SESSIONS="20"
$env:MAX_CONCURRENT_MESSAGES="5"
npm start
```

## API Flow

Typical usage:

1. Initialize browser.
2. Create a page.
3. Send messages to that page id.
4. Close the page when done.

## Endpoints

### `GET /`

Returns basic API information.

```bash
curl http://localhost:3000/
```

### `GET /health`

Returns server status, browser connection status, open session count, and queue activity.

```bash
curl http://localhost:3000/health
```

Example response:

```json
{
  "ok": true,
  "browserConnected": true,
  "sessions": 2,
  "limits": {
    "maxSessions": 20,
    "maxConcurrentPageCreates": 3,
    "maxConcurrentMessages": 5
  },
  "activity": {
    "activePageCreates": 0,
    "queuedPageCreates": 0,
    "activeMessages": 1,
    "queuedMessages": 0
  }
}
```

### `POST /init`

Starts Chrome if needed and connects Puppeteer.

```bash
curl -X POST http://localhost:3000/init
```

Example response:

```json
{
  "ok": true,
  "browserConnected": true
}
```

### `POST /pages`

Creates a new ChatGPT page/session.

```bash
curl -X POST http://localhost:3000/pages
```

Example response:

```json
{
  "id": "7e32f2e8-9a91-455f-9c15-7c7b8ff9af12",
  "createdAt": "2026-05-12T10:30:00.000Z",
  "lastMessageAt": null,
  "busy": false
}
```

Keep the returned `id`. You need it to send messages to that page.

### `GET /pages`

Lists all active pages.

```bash
curl http://localhost:3000/pages
```

### `POST /pages/:id/messages`

Sends a message to one ChatGPT page.

```bash
curl -X POST http://localhost:3000/pages/YOUR_PAGE_ID/messages ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"Hello, explain Node.js streams simply.\"}"
```

Example response:

```json
{
  "id": "7e32f2e8-9a91-455f-9c15-7c7b8ff9af12",
  "message": "Hello, explain Node.js streams simply.",
  "response": "Node.js streams are..."
}
```

### `DELETE /pages/:id`

Closes one page/session.

```bash
curl -X DELETE http://localhost:3000/pages/YOUR_PAGE_ID
```

Returns `204 No Content` when successful.

### `POST /shutdown`

Closes all pages and disconnects the browser.

```bash
curl -X POST http://localhost:3000/shutdown
```

## Multi-User Behavior

Each `POST /pages` call creates a separate ChatGPT page. For example:

```txt
User A -> page id A -> separate chat
User B -> page id B -> separate chat
User C -> page id C -> separate chat
```

By default, up to `20` pages can stay open. Only `5` messages generate at the same time. If more than `5` users send messages at once, extra requests wait in queue.

This is better than allowing every page to generate at once because Chrome and ChatGPT pages are heavy.

## Errors

Common errors:

### Missing Message

Status: `400`

```json
{
  "error": "Request body must include a non-empty string `message`"
}
```

### Page Not Found

Status: `404`

```json
{
  "error": "Session not found: YOUR_PAGE_ID"
}
```

### Page Busy

Status: `409`

```json
{
  "error": "This session is already processing a message"
}
```

### Too Many Pages

Status: `429`

```json
{
  "error": "Maximum sessions reached. Close an existing page or increase MAX_SESSIONS."
}
```

## Notes

- One page can process only one message at a time.
- Different pages can process messages in parallel up to `MAX_CONCURRENT_MESSAGES`.
- Leaving many pages open uses RAM. Close pages when users are done.
- There is no authentication yet. Add auth before exposing this API publicly.
- ChatGPT page selectors can change, so Puppeteer selectors may need updates over time.
