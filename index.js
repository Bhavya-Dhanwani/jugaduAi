import express from "express";
import puppeteer from "puppeteer";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const CHATGPT_URL = "https://chatgpt.com/";
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_DEBUG_PORT = process.env.CHROME_DEBUG_PORT || "9222";
const CHROME_USER_DATA_DIR =
  process.env.CHROME_USER_DATA_DIR || "C:\\chrome-debug";
const COOKIES_PATH = process.env.COOKIES_PATH || "./cookies/chatgpt.json";

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const MAX_SESSIONS = positiveInt(process.env.MAX_SESSIONS, 20);
const MAX_CONCURRENT_PAGE_CREATES = positiveInt(
  process.env.MAX_CONCURRENT_PAGE_CREATES,
  3
);
const MAX_CONCURRENT_MESSAGES = positiveInt(
  process.env.MAX_CONCURRENT_MESSAGES,
  5
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = new Map();

let chromeProcess = null;
let browser = null;
let initializing = null;

app.use(express.json({ limit: "1mb" }));

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  get queued() {
    return this.queue.length;
  }

  async run(task) {
    await this.acquire();

    try {
      return await task();
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    const next = this.queue.shift();

    if (next) {
      next();
      return;
    }

    this.active -= 1;
  }
}

const pageCreateLimiter = new Semaphore(MAX_CONCURRENT_PAGE_CREATES);
const messageLimiter = new Semaphore(MAX_CONCURRENT_MESSAGES);

function loadCookies() {
  if (!existsSync(COOKIES_PATH)) {
    throw new Error(`Cookies file not found at ${COOKIES_PATH}`);
  }

  return JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
}

function startChrome() {
  if (chromeProcess) return;

  chromeProcess = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );

  chromeProcess.unref();
}

async function initBrowser() {
  if (browser?.connected) return browser;
  if (initializing) return initializing;

  initializing = (async () => {
    startChrome();
    await sleep(5000);

    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CHROME_DEBUG_PORT}`,
      defaultViewport: null,
    });

    browser.on("disconnected", () => {
      browser = null;
      sessions.clear();
    });

    return browser;
  })();

  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

async function preparePage(page) {
  const cookies = loadCookies();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  );

  await page.goto(CHATGPT_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await page.setCookie(...cookies);

  await page.reload({
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await page.waitForSelector("#prompt-textarea", {
    visible: true,
    timeout: 60000,
  });
}

async function createSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const error = new Error(
      `Maximum sessions reached. Close an existing page or increase MAX_SESSIONS.`
    );
    error.status = 429;
    throw error;
  }

  return pageCreateLimiter.run(async () => {
    if (sessions.size >= MAX_SESSIONS) {
      const error = new Error(
        `Maximum sessions reached. Close an existing page or increase MAX_SESSIONS.`
      );
      error.status = 429;
      throw error;
    }

    const activeBrowser = await initBrowser();
    const page = await activeBrowser.newPage();
    await preparePage(page);

    const id = randomUUID();
    sessions.set(id, {
      id,
      page,
      busy: false,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    });

    page.on("close", () => sessions.delete(id));

    return sessions.get(id);
  });
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) {
    const error = new Error(`Session not found: ${id}`);
    error.status = 404;
    throw error;
  }

  return session;
}

async function waitForAssistantResponse(page, previousAssistantCount) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-message-author-role="assistant"]')
        .length > count,
    { timeout: 120000 },
    previousAssistantCount
  );

  await page.waitForFunction(
    () => {
      const stopButton =
        document.querySelector('[data-testid="stop-button"]') ||
        document.querySelector('button[aria-label*="Stop"]');
      return !stopButton;
    },
    { timeout: 180000 }
  );

  await sleep(1000);

  return page.evaluate(() => {
    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );

    return messages[messages.length - 1]?.innerText || "No response found";
  });
}

async function sendMessage(session, message) {
  if (session.busy) {
    const error = new Error("This session is already processing a message");
    error.status = 409;
    throw error;
  }

  session.busy = true;

  try {
    return await messageLimiter.run(async () => {
      const { page } = session;
      const previousAssistantCount = await page.evaluate(
        () =>
          document.querySelectorAll('[data-message-author-role="assistant"]')
            .length
      );

      await page.click("#prompt-textarea");

      await page.evaluate(() => {
        const element = document.querySelector("#prompt-textarea");
        if (element) element.innerText = "";
      });

      await page.keyboard.type(message, { delay: 20 });

      await page.waitForFunction(() => {
        const button = document.querySelector("#composer-submit-button");
        return button && !button.disabled;
      });

      await page.click("#composer-submit-button");

      const response = await waitForAssistantResponse(
        page,
        previousAssistantCount
      );

      session.lastMessageAt = new Date().toISOString();
      return response;
    });
  } finally {
    session.busy = false;
  }
}

app.get("/", (req, res) => {
  res.json({
    name: "ChatGPT Puppeteer API",
    limits: {
      maxSessions: MAX_SESSIONS,
      maxConcurrentPageCreates: MAX_CONCURRENT_PAGE_CREATES,
      maxConcurrentMessages: MAX_CONCURRENT_MESSAGES,
    },
    endpoints: {
      health: "GET /health",
      init: "POST /init",
      newPage: "POST /pages",
      sendMessage: "POST /pages/:id/messages",
      listPages: "GET /pages",
      closePage: "DELETE /pages/:id",
      shutdown: "POST /shutdown",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    browserConnected: Boolean(browser?.connected),
    sessions: sessions.size,
    limits: {
      maxSessions: MAX_SESSIONS,
      maxConcurrentPageCreates: MAX_CONCURRENT_PAGE_CREATES,
      maxConcurrentMessages: MAX_CONCURRENT_MESSAGES,
    },
    activity: {
      activePageCreates: pageCreateLimiter.active,
      queuedPageCreates: pageCreateLimiter.queued,
      activeMessages: messageLimiter.active,
      queuedMessages: messageLimiter.queued,
    },
  });
});

app.post("/init", async (req, res, next) => {
  try {
    await initBrowser();
    res.json({ ok: true, browserConnected: true });
  } catch (error) {
    next(error);
  }
});

app.post("/pages", async (req, res, next) => {
  try {
    const session = await createSession();
    res.status(201).json({
      id: session.id,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      busy: session.busy,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/pages", (req, res) => {
  res.json({
    pages: [...sessions.values()].map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      busy: session.busy,
    })),
  });
});

app.post("/pages/:id/messages", async (req, res, next) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Request body must include a non-empty string `message`",
      });
    }

    const session = getSession(req.params.id);
    const response = await sendMessage(session, message);

    res.json({
      id: session.id,
      message,
      response,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/pages/:id", async (req, res, next) => {
  try {
    const session = getSession(req.params.id);
    await session.page.close();
    sessions.delete(session.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/shutdown", async (req, res, next) => {
  try {
    for (const session of sessions.values()) {
      await session.page.close().catch(() => {});
    }

    sessions.clear();

    if (browser?.connected) {
      await browser.close();
    }

    browser = null;
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(error.status || 500).json({
    error: error.message || "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
