require("dotenv").config();
const express = require("express");
const Database = require("better-sqlite3");
const http = require("http");
const { FlightRadar24API } = require("flightradarapi");
const frApi = new FlightRadar24API();

const app = express();
const PORT = 7000;
const FR24_URL = "http://192.168.1.160:8754/flights.json";
const POLL_INTERVAL = 15_000;

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

    // Collect feeder flight keys (ICAO 24-bit hex codes)
    const feederKeys = new Set();
    for (const key of Object.keys(data)) {
      feederKeys.add(key.toUpperCase());
    }

    if (feederKeys.size === 0) {
      currentFlights = [];
      return;
    }

    // Fetch all flights in the area from FR24 API
    const bounds = await frApi.getBoundsByPoint(
      parseFloat(process.env.LAT),
      parseFloat(process.env.LNG),
      100_000,
    );
    const apiFlights = await frApi.getFlights(null, bounds);

    // Build lookup: icao24bit → flight data
    const apiMap = new Map();
    for (const f of apiFlights) {
      if (f.icao24bit) apiMap.set(f.icao24bit.toUpperCase(), f);
    }

    // Match feeder flights with API data
    const flights = [];
    for (const key of feederKeys) {
      const match = apiMap.get(key);
      if (match) {
        const flight = {
          callsign: match.callsign || key,
          airline:
            match.airlineIcao || match.airlineIata || match.callsign || key,
          registration: match.registration || "",
          model: match.aircraftCode || "",
          origin: match.originAirportIata || "???",
          destination: match.destinationAirportIata || "???",
        };
        flights.push(flight);
        upsertStmt.run(
          flight.callsign,
          flight.airline,
          flight.registration,
          flight.model,
          flight.origin,
          flight.destination,
          Date.now(),
        );
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
