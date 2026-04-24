const express = require("express");
const Database = require("better-sqlite3");
const http = require("http");
const { FlightRadar24API } = require("flightradarapi");
const frApi = new FlightRadar24API();

const app = express();
const PORT = 7000;
const FR24_URL = "http://localhost:8754/flights.json";
const POLL_INTERVAL = 15_000;
const CACHE_MAX_AGE = 3600_000; // 1 hour
const LOOKUP_CONCURRENCY = 3;

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

async function lookupFlight(flightId, callsign) {
  try {
    const flight = await frApi.getFlightDetails({ id: flightId });

    const airline = flight?.airline?.name || callsign;
    const registration = flight?.aircraft?.registration || "";
    const model = flight?.aircraft?.model?.code || "";
    const origin = flight?.airport?.origin?.code?.iata || "???";
    const destination = flight?.airport?.destination?.code?.iata || "???";

    const result = {
      callsign,
      airline,
      registration,
      model,
      origin,
      destination,
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
    console.error(
      `FR24 API lookup failed for ${callsign} (${flightId}):`,
      err.message,
    );
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
        pending.push({ flightId: key, callsign });
      }
    }

    // Look up uncached flights in small batches
    for (let i = 0; i < pending.length; i += LOOKUP_CONCURRENCY) {
      const batch = pending.slice(i, i + LOOKUP_CONCURRENCY);
      const results = await Promise.all(
        batch.map(({ flightId, callsign: cs }) => lookupFlight(flightId, cs)),
      );
      for (const resolved of results) {
        flights.push(resolved);
      }
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
