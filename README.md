# CityPulse Server

Node.js backend that powers CityPulse. Checks a local JSON cache of 40+ pre-loaded cities first, then calls Claude AI to generate rich data for any city in the world on demand — and saves it for future requests.

---

## Prerequisites

- **Node.js 18+** — check with `node -v`
- **An Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com)

---

## Setup (one-time)

```bash
# 1. Navigate to the Server folder
cd ~/Desktop/CityPulse/Server

# 2. Install dependencies
npm install

# 3. Create your .env file from the template
cp .env.template .env

# 4. Open .env and paste your Anthropic API key
open .env
```

Your `.env` should look like:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3000
```

---

## Run the server

```bash
npm start
```

You should see:

```
CityPulse server  →  http://localhost:3000
Cache loaded      →  40 cities pre-loaded
Endpoints         →  POST /city   GET /health
```

---

## Endpoints

### `POST /city`
Returns history, famous people, attractions, and a fun fact for any city.

**Request body:**
```json
{ "cityName": "Bozeman", "state": "MT" }
```

**Response:**
```json
{
  "name": "Bozeman",
  "state": "MT",
  "history": "...",
  "famousPeople": ["..."],
  "attractions": ["..."],
  "funFact": "..."
}
```

**Cache behaviour:**
- Cache hit → instant response (no API call)
- Cache miss → calls Claude `claude-opus-4-7`, saves result to `cities.json`, returns data

**Test with curl:**
```bash
curl -X POST http://localhost:3000/city \
  -H "Content-Type: application/json" \
  -d '{"cityName":"Portland","state":"OR"}'
```

### `GET /health`
```bash
curl http://localhost:3000/health
# {"status":"ok","cachedCities":40}
```

---

## How it works

```
iOS App  →  POST /city  →  Check cities.json cache
                                  │
                         ┌────────┴────────┐
                     Cache hit         Cache miss
                         │                 │
                    Return data      Call Claude API
                                          │
                                   Save to cache
                                          │
                                     Return data
```

1. The iOS app sends the GPS-resolved city name and state abbreviation
2. Server checks `cities.json` for an exact match (or city-name-only fallback)
3. On cache miss: calls `claude-opus-4-7` with adaptive thinking to generate data
4. New city is appended to `cities.json` so the next request is instant
5. The 90-second iOS timeout is generous — Claude typically responds in 5-15 seconds

---

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server + Claude API integration |
| `cities.json` | Cache — 40+ pre-loaded US cities, grows as new cities are requested |
| `package.json` | Dependencies and npm scripts |
| `.env` | Your API key (not committed to git) |
| `.env.template` | Template for setting up `.env` |

---

## Running alongside Xcode

Keep the terminal with `npm start` open while testing the app in the iOS Simulator. The simulator and the server both run on your Mac, so `http://localhost:3000` connects correctly without any extra configuration.
