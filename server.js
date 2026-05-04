import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'cities.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Full state name → 2-letter abbreviation map
const STATE_ABBREVIATIONS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR',
  California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
  Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};

function normalizeState(state) {
  return STATE_ABBREVIATIONS[state] ?? state.toUpperCase();
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    console.error('Failed to read cache — starting fresh');
    return [];
  }
}

function saveCache(cities) {
  writeFileSync(CACHE_FILE, JSON.stringify(cities, null, 2));
}

function findInCache(cities, cityName, state) {
  const name = cityName.toLowerCase();
  const abbr = normalizeState(state).toUpperCase();

  return (
    cities.find(c => c.name.toLowerCase() === name && c.state.toUpperCase() === abbr) ??
    cities.find(c => c.name.toLowerCase() === name)
  );
}

function extractJSON(text) {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;

  // Find the outermost JSON object
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON object found in Claude response');

  return JSON.parse(objMatch[0]);
}

async function generateCityData(cityName, state) {
  const location = state ? `${cityName}, ${state}` : cityName;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: `You are a knowledgeable and engaging city guide. Provide accurate, interesting information about any city worldwide.

Respond with a single valid JSON object using exactly these fields:
- "name": string — official city name, properly capitalized
- "state": string — 2-letter US state abbreviation (e.g. "CA", "TX"), or region code for international cities
- "history": string — 2-3 engaging sentences about the city's founding and historical significance
- "famousPeople": array of 5-7 strings, each formatted as "Full Name — role/description (birth_year–death_year or b. birth_year)"
- "attractions": array of 5-7 strings, each formatted as "Attraction Name — one sentence description"
- "funFact": string — one surprising, memorable fact about the city

Return ONLY the raw JSON object. No markdown fences, no explanation, no preamble.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Generate city information for: ${location}`,
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');

  const cityData = extractJSON(textBlock.text);

  // Log token usage for visibility
  const usage = response.usage;
  console.log(
    `  tokens: ${usage.input_tokens} in / ${usage.output_tokens} out` +
    (usage.cache_read_input_tokens ? ` / ${usage.cache_read_input_tokens} cached` : '')
  );

  return cityData;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', cachedCities: loadCache().length });
});

app.get('/weather', async (req, res) => {
  const { city, state, lat, lon } = req.query;
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Weather service not configured' });

  let url;
  if (lat && lon) {
    // Coordinate-based lookup — most accurate, used for GPS-detected cities
    url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&appid=${apiKey}&units=imperial`;
  } else if (city?.trim()) {
    // City-name fallback — used for history loads
    const q = state ? `${city.trim()},${state.trim()},US` : city.trim();
    url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${apiKey}&units=imperial`;
  } else {
    return res.status(400).json({ error: 'lat/lon or city is required' });
  }

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      console.warn(`[weather]    OpenWeather error for "${q}": ${data.message}`);
      return res.status(response.status).json({ error: data.message ?? 'Weather fetch failed' });
    }

    console.log(`[weather]    ${data.name} — ${data.weather[0].description}, ${Math.round(data.main.temp)}°F`);
    res.json({
      temperature: Math.round(data.main.temp),
      feelsLike:   Math.round(data.main.feels_like),
      description: data.weather[0].description,
      icon:        data.weather[0].icon,
      humidity:    data.main.humidity,
      windSpeed:   Math.round(data.wind?.speed ?? 0),
    });
  } catch (err) {
    console.error(`[weather]    fetch error: ${err.message}`);
    res.status(500).json({ error: 'Weather service error' });
  }
});

app.get('/nearby', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon are required' });

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service not configured' });

  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);

  try {
    // Step 1: get candidate cities near the point
    const findUrl =
      `https://api.openweathermap.org/data/2.5/find` +
      `?lat=${parsedLat}&lon=${parsedLon}&cnt=15&appid=${apiKey}`;
    const findResp = await fetch(findUrl);
    const findData = await findResp.json();

    if (!findResp.ok || !Array.isArray(findData.list)) {
      console.warn(`[nearby]     OpenWeather find failed: ${findData.message ?? 'unknown'}`);
      return res.json([]);
    }

    // Step 2: calculate distances, keep within 30 miles (exclude < 1 mi = current city)
    const candidates = findData.list
      .map(c => ({
        name: c.name,
        lat:  c.coord.lat,
        lon:  c.coord.lon,
        distanceMiles: haversineDistance(parsedLat, parsedLon, c.coord.lat, c.coord.lon),
      }))
      .filter(c => c.distanceMiles > 1 && c.distanceMiles <= 30)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, 5);

    // Step 3: reverse-geocode each candidate in parallel to get US state
    const withState = await Promise.all(
      candidates.map(async (city) => {
        try {
          const geoUrl =
            `https://api.openweathermap.org/geo/1.0/reverse` +
            `?lat=${city.lat}&lon=${city.lon}&limit=1&appid=${apiKey}`;
          const geoResp = await fetch(geoUrl);
          const geoData = await geoResp.json();
          const rawState = geoData[0]?.state ?? '';
          return {
            name:          geoData[0]?.name ?? city.name,
            state:         normalizeState(rawState),
            distanceMiles: Math.round(city.distanceMiles),
            lat:           city.lat,
            lon:           city.lon,
          };
        } catch {
          return { name: city.name, state: '', distanceMiles: Math.round(city.distanceMiles), lat: city.lat, lon: city.lon };
        }
      })
    );

    console.log(`[nearby]     ${withState.length} cities within 30mi of (${parsedLat.toFixed(3)},${parsedLon.toFixed(3)}): ${withState.map(c => c.name).join(', ')}`);
    res.json(withState);
  } catch (err) {
    console.error(`[nearby]     error: ${err.message}`);
    res.json([]); // degrade gracefully — nearby is non-critical
  }
});

app.post('/city', async (req, res) => {
  const { cityName, state = '' } = req.body ?? {};

  if (!cityName?.trim()) {
    return res.status(400).json({ error: 'cityName is required' });
  }

  const name = cityName.trim();
  const abbr = normalizeState(state);

  try {
    const cities = loadCache();
    const cached = findInCache(cities, name, state);

    if (cached) {
      console.log(`[cache hit]  ${name}, ${abbr}`);
      return res.json(cached);
    }

    console.log(`[generating] ${name}, ${abbr} — calling Claude API...`);
    const cityData = await generateCityData(name, abbr);

    cities.push(cityData);
    saveCache(cities);
    console.log(`[saved]      ${cityData.name}, ${cityData.state} → cities.json (${cities.length} total)`);

    res.json(cityData);
  } catch (err) {
    console.error(`[error]      ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const count = loadCache().length;
  console.log(`\nCityPulse server  →  http://localhost:${PORT}`);
  console.log(`Cache loaded      →  ${count} cities pre-loaded`);
  console.log(`Endpoints         →  POST /city   GET /weather   GET /nearby   GET /health\n`);
});
