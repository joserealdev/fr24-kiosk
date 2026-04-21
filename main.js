const express = require("express");
const Database = require("better-sqlite3");
const http = require("http");

const app = express();
const PORT = 7000;
const FR24_URL = "http://localhost:8754/flights.json";
const ADSBDB_BASE = "https://api.adsbdb.com/v0/callsign";
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
    origin      TEXT,
    destination TEXT,
    fetched_at  INTEGER NOT NULL
  )
`);

const upsertStmt = db.prepare(`
  INSERT INTO callsign_cache (callsign, airline, registration, origin, destination, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(callsign) DO UPDATE SET
    airline      = excluded.airline,
    registration = excluded.registration,
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
  const data = await httpGetJson(
    `${ADSBDB_BASE}/${encodeURIComponent(callsign)}`,
  );
  const route = data?.response?.flightroute;
  const info = {
    callsign,
    airline: route?.airline?.name ?? callsign,
    registration: route?.callsign_icao ?? "",
    origin: route?.origin?.iata_code ?? "???",
    destination: route?.destination?.iata_code ?? "???",
  };
  upsertStmt.run(
    info.callsign,
    info.airline,
    info.registration,
    info.origin,
    info.destination,
    Date.now(),
  );
  return info;
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

    const lookups = [];

    for (const [key, value] of Object.entries(data)) {
      if (key === "full_count" || key === "version") continue;
      if (!Array.isArray(value) || value.length === 0) continue;

      const callsign = value[value.length - 1];
      if (!callsign || typeof callsign !== "string") continue;

      let info = getCached(callsign);
      if (info) {
        flights.push({
          callsign,
          airline: info.airline,
          registration: info.registration,
          origin: info.origin,
          destination: info.destination,
        });
      } else {
        lookups.push(
          lookupCallsign(callsign).then((resolved) => {
            flights.push({
              callsign,
              airline: resolved.airline,
              registration: resolved.registration,
              origin: resolved.origin,
              destination: resolved.destination,
            });
          }),
        );
      }
    }

    await Promise.allSettled(lookups);
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
