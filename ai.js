import puppeteer from "puppeteer";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { fileURLToPath } from "url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    const candidatesByPlatform = {
        win32: [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ],
        darwin: [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ],
        linux: [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ],
    };

    const candidates =
        candidatesByPlatform[process.platform] || candidatesByPlatform.linux;

    return (
        candidates.find((candidate) => existsSync(candidate)) || candidates[0]
    );
}

const CHROME_PATH = resolveChromePath();
const CHROME_USER_DATA_DIR =
    process.env.CHROME_USER_DATA_DIR || path.join(__dirname, ".chrome-debug");
const COOKIES_PATH =
    process.env.COOKIES_PATH || path.join(__dirname, "cookies", "chatgpt.json");

if (!existsSync(COOKIES_PATH)) {
    throw new Error(`Cookies file not found at ${COOKIES_PATH}`);
}

const cookies = JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));

spawn(
    CHROME_PATH,
    [
        "--remote-debugging-port=9222",
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
    },
);

await sleep(5000);

const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
});

let page = (await browser.pages())[0] || (await browser.newPage());

await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
);

await page.goto("https://chatgpt.com/", {
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

const rl = readline.createInterface({ input, output });

while (true) {
    const userPrompt = await rl.question("\nYou: ");

    if (userPrompt.trim().toLowerCase() === "exit") {
        break;
    }

    await page.click("#prompt-textarea");

    await page.evaluate(() => {
        const el = document.querySelector("#prompt-textarea");
        if (el) el.innerText = "";
    });

    await page.keyboard.type(userPrompt, { delay: 20 });

    await page.waitForFunction(() => {
        const btn = document.querySelector("#composer-submit-button");
        return btn && !btn.disabled;
    });

    await page.click("#composer-submit-button");

    await page.waitForSelector('[data-message-author-role="assistant"]', {
        timeout: 60000,
    });

    await sleep(15000);

    const response = await page.evaluate(() => {
        const msgs = document.querySelectorAll(
            '[data-message-author-role="assistant"]',
        );

        return msgs[msgs.length - 1]?.innerText || "No response found";
    });

    console.log("\nChatGPT:", response);
}

rl.close();
await browser.close();

console.log("Exited.");