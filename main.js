const express = require("express");
const Database = require("better-sqlite3");
const http = require("http");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 7000;
const FR24_URL = "http://localhost:8754/flights.json";
const POLL_INTERVAL = 15_000;
const CACHE_MAX_AGE = 3600_000; // 1 hour

// ── SQLite setup ────────────────────────────────────────────────────────────
const db = new Database("flights.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS callsign_cache (
    callsign    TEXT PRIMARY KEY,
    airline     TEXT,
    registration TEXT,
    model       TEXT,
    origin      TEXT,
    destination TEXT,
    fetched_at  INTEGER NOT NULL
  )
`);

const upsertStmt = db.prepare(`
  INSERT INTO callsign_cache (callsign, airline, registration, model, origin, destination, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(callsign) DO UPDATE SET
    airline      = excluded.airline,
    registration = excluded.registration,
    model        = excluded.model,
    origin       = excluded.origin,
    destination  = excluded.destination,
    fetched_at   = excluded.fetched_at
`);

const selectStmt = db.prepare(
  "SELECT * FROM callsign_cache WHERE callsign = ?",
);

// ── In-memory state: the latest enriched flight list ────────────────────────
let currentFlights = [];
let lastError = null;

// ── Puppeteer browser instance (single page, reused) ───────────────────────
let browser = null;
let sharedPage = null;

async function getPage() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--single-process",
        "--js-flags=--max-old-space-size=128",
      ],
      executablePath: "/usr/bin/chromium-browser",
    });
    sharedPage = null;
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browser.newPage();
    await sharedPage.setViewport({ width: 390, height: 844 });
    await sharedPage.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    );
    await sharedPage.setRequestInterception(true);
    sharedPage.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }
  return sharedPage;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : http;
    mod
      .get(url, { timeout: 5000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null))
      .on("timeout", function () {
        this.destroy();
        resolve(null);
      });
  });
}

function getCached(callsign) {
  const row = selectStmt.get(callsign);
  if (!row) return null;
  if (Date.now() - row.fetched_at > CACHE_MAX_AGE) return null;
  return row;
}

async function lookupCallsign(callsign) {
  try {
    const page = await getPage();

    const url = `https://www.flightradar24.com/${encodeURIComponent(callsign)}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    // Wait for the panel to appear
    await page
      .waitForSelector('[data-testid="aircraft-small-panel__airline-name"]', {
        timeout: 10000,
      })
      .catch(() => {});

    const selectors = {
      airline: '[data-testid="aircraft-small-panel__airline-name"]',
      origin: '[data-testid="aircraft-small-panel__departure-iata"]',
      destination: '[data-testid="aircraft-small-panel__arrival-iata"]',
      registration: '[data-testid="aircraft-small-panel__registration"]',
      model: '[data-testid="aircraft-small-panel__model"]',
    };

    const info = await page.evaluate((sel) => {
      const text = (s) => document.querySelector(s)?.textContent?.trim() || "";
      return {
        airline: text(sel.airline),
        origin: text(sel.origin),
        destination: text(sel.destination),
        registration: text(sel.registration),
        model: text(sel.model),
      };
    }, selectors);

    const result = {
      callsign,
      airline: info.airline || callsign,
      registration: info.registration || "",
      model: info.model || "",
      origin: info.origin || "???",
      destination: info.destination || "???",
    };

    upsertStmt.run(
      result.callsign,
      result.airline,
      result.registration,
      result.model,
      result.origin,
      result.destination,
      Date.now(),
    );
    return result;
  } catch (err) {
    console.error(`Puppeteer lookup failed for ${callsign}:`, err.message);
    return {
      callsign,
      airline: callsign,
      registration: "",
      model: "",
      origin: "???",
      destination: "???",
    };
  }
}

// ── Polling loop ────────────────────────────────────────────────────────────
async function poll() {
  try {
    const data = await httpGetJson(FR24_URL);
    if (!data) {
      lastError = "Wait for FR24...";
      currentFlights = [];
      return;
    }

    lastError = null;
    const flights = [];

    const pending = [];

    for (const [key, value] of Object.entries(data)) {
      if (key === "full_count" || key === "version") continue;
      if (!Array.isArray(value) || value.length === 0) continue;

      const callsign = value[value.length - 1];
      if (!callsign || typeof callsign !== "string") continue;

      const info = getCached(callsign);
      if (info) {
        flights.push({
          callsign,
          airline: info.airline,
          registration: info.registration,
          model: info.model,
          origin: info.origin,
          destination: info.destination,
        });
      } else {
        pending.push(callsign);
      }
    }

    // Look up uncached callsigns sequentially (single page, RPi-friendly)
    for (const cs of pending) {
      const resolved = await lookupCallsign(cs);
      flights.push({
        callsign: cs,
        airline: resolved.airline,
        registration: resolved.registration,
        model: resolved.model,
        origin: resolved.origin,
        destination: resolved.destination,
      });
    }

    currentFlights = flights;
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
app.get("/api/flights", (_req, res) => {
  if (lastError) {
    return res.json({ error: lastError, flights: [] });
  }
  res.json({ error: null, flights: currentFlights });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  poll();
  setInterval(poll, POLL_INTERVAL);
});
