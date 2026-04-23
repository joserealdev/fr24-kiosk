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
      args: ["--no-sandbox"],
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

    const url = `https://es.flightaware.com/live/flight/${encodeURIComponent(callsign)}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    // Dismiss cookie consent banner
    await page.click("#onetrust-accept-btn-handler").catch(() => {});

    // Wait for the flight summary to appear
    await page
      .waitForSelector(".flightPageSummaryBlock", { timeout: 10000 })
      .catch(() => {});

    const info = await page.evaluate(() => {
      const text = (s) => document.querySelector(s)?.textContent?.trim() || "";
      const attr = (s, a) => document.querySelector(s)?.getAttribute(a) || "";

      const airline = text(
        'div[data-template="live/flight/airline"] .flightPageData a[target="blank"]',
      );
      const origin = text(
        ".flightPageSummaryOrigin .flightPageSummaryAirportCode",
      );
      const destination = text(
        ".flightPageSummaryDestination .flightPageSummaryAirportCode",
      );
      const model = attr('meta[name="aircrafttype"]', "content");

      return { airline, origin, destination, model };
    });

    const result = {
      callsign,
      airline: info.airline || callsign,
      registration: "",
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
