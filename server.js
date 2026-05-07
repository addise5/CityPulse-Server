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

function findInCache(cities, cityName, state, parentCity = '') {
  const name = cityName.toLowerCase();
  const abbr = normalizeState(state).toUpperCase();
  const parent = parentCity.toLowerCase();

  if (parent) {
    // Prefer a district-specific cached entry
    const districtHit = cities.find(c =>
      c.name.toLowerCase() === name &&
      (c.parentCity ?? '').toLowerCase() === parent
    );
    if (districtHit) return districtHit;
  }

  // Fall back to a generic city entry (no parentCity stored)
  return (
    cities.find(c => c.name.toLowerCase() === name && c.state.toUpperCase() === abbr && !c.parentCity) ??
    cities.find(c => c.name.toLowerCase() === name && !c.parentCity)
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

function buildCityPrompt(cityName, state, parentCity, country) {
  const isDistrict = parentCity && parentCity.trim() !== '' && parentCity.toLowerCase() !== cityName.toLowerCase();
  const location = state ? `${cityName}, ${state}` : cityName;
  const parentLocation = country ? `${parentCity}, ${country}` : parentCity;

  const jsonSchema = `Respond with a single valid JSON object using exactly these fields:
- "name": string — official name of the place, properly capitalized
- "state": string — 2-letter US state abbreviation (e.g. "CA", "TX"), or region/country code for international places
- "history": string — 2-3 engaging sentences
- "famousPeople": array of 5-7 strings, each formatted as "Full Name — role/description (birth_year–death_year or b. birth_year)"
- "attractions": array of 5-7 strings, each formatted as "Attraction Name — one sentence description"
- "funFact": string — one surprising, memorable fact

Return ONLY the raw JSON object. No markdown fences, no explanation, no preamble.`;

  if (isDistrict) {
    return `You are a knowledgeable city guide specializing in neighborhoods, districts, and sub-city areas worldwide.

The user is in ${cityName}, which is a specific district or sub-city within ${parentLocation}.

Provide information SPECIFIC to the ${cityName} district — not generic ${parentCity} content. Focus on:

1. HISTORY: How ${cityName} developed as a district, its specific role within ${parentCity}, and events that happened specifically in this area — not just general ${parentCity} history.

2. FAMOUS PEOPLE: People with a documented specific connection to ${cityName} as a district — born here, raised here, or strongly associated with this area. Do NOT include people who are only associated with ${parentCity} generally unless they have a clear tie to ${cityName} specifically.

3. NOTABLE ATTRACTIONS: Landmarks and places physically located within ${cityName} — not general ${parentCity} attractions unless they sit inside ${cityName}'s boundaries.

4. FUN FACT: Something surprising or little-known specifically about ${cityName} as a district.

This logic applies worldwide: London boroughs, New York boroughs, Paris arrondissements, Tokyo wards, Addis Ababa sub-cities, etc.

${jsonSchema}`;
  }

  return `You are a knowledgeable and engaging city guide. Provide accurate, interesting information about any city worldwide.

${jsonSchema}`;
}

async function generateCityData(cityName, state, parentCity = '', country = '') {
  const location = state ? `${cityName}, ${state}` : cityName;
  const systemPrompt = buildCityPrompt(cityName, state, parentCity, country);

  const userContent = parentCity
    ? `Generate information for: ${location} (district/sub-city within ${parentCity}${country ? ', ' + country : ''})`
    : `Generate city information for: ${location}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userContent,
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
  const { cityName, state = '', parentCity = '', country = '', countryCode = '' } = req.body ?? {};

  if (!cityName?.trim()) {
    return res.status(400).json({ error: 'cityName is required' });
  }

  const name = cityName.trim();
  const abbr = normalizeState(state);
  const parent = parentCity.trim();
  const isDistrict = parent !== '' && parent.toLowerCase() !== name.toLowerCase();

  try {
    const cities = loadCache();
    const cached = findInCache(cities, name, state, parent);

    if (cached) {
      const label = isDistrict ? `${name} (district of ${parent})` : `${name}, ${abbr}`;
      console.log(`[cache hit]  ${label}`);
      return res.json(cached);
    }

    const label = isDistrict ? `${name} (district of ${parent}, ${country || abbr})` : `${name}, ${abbr}`;
    console.log(`[generating] ${label} — calling Claude API...`);
    const cityData = await generateCityData(name, abbr, parent, country);

    // Tag district entries so the cache can distinguish them from same-named cities
    if (isDistrict) {
      cityData.parentCity = parent;
    }

    cities.push(cityData);
    saveCache(cities);
    console.log(`[saved]      ${cityData.name}${isDistrict ? ` (${parent})` : `, ${cityData.state}`} → cities.json (${cities.length} total)`);

    res.json(cityData);
  } catch (err) {
    console.error(`[error]      ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── On This Day ──────────────────────────────────────────────────────────────

const ONTHISDAY_CACHE_FILE  = join(__dirname, 'onthisday.json');
const ITINERARY_CACHE_FILE  = join(__dirname, 'itineraries.json');

function loadOnThisDayCache() {
  if (!existsSync(ONTHISDAY_CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(ONTHISDAY_CACHE_FILE, 'utf-8')); } catch { return {}; }
}
function saveOnThisDayCache(obj) {
  writeFileSync(ONTHISDAY_CACHE_FILE, JSON.stringify(obj, null, 2));
}
function loadItineraryCache() {
  if (!existsSync(ITINERARY_CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(ITINERARY_CACHE_FILE, 'utf-8')); } catch { return {}; }
}
function saveItineraryCache(obj) {
  writeFileSync(ITINERARY_CACHE_FILE, JSON.stringify(obj, null, 2));
}

app.get('/onthisday', async (req, res) => {
  const { month, day } = req.query;
  if (!month || !day) return res.status(400).json({ error: 'month and day are required' });

  const key = `${month}-${day}`;
  const cache = loadOnThisDayCache();

  if (cache[key]) {
    console.log(`[cache hit]  On This Day ${key}`);
    return res.json(cache[key]);
  }

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName  = monthNames[parseInt(month) - 1] ?? month;

  console.log(`[generating] On This Day ${key} — calling Claude API...`);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `List exactly 5 significant historical events that occurred on ${monthName} ${day} throughout world history. Include a diverse mix across different centuries, countries, and categories (discoveries, battles, births, achievements, political milestones, scientific breakthroughs). Avoid repeating the same country or era.

Respond with a single raw JSON array of exactly 5 objects — no markdown fences, no preamble:
[
  {
    "year": number (negative for BCE),
    "event": "one vivid, engaging sentence describing what happened",
    "city": "city or region (empty string if widespread or unclear)",
    "country": "country or empire name",
    "emoji": "one relevant emoji"
  }
]`,
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content');
    console.log(`[claude]     onthisday raw (first 300): ${textBlock.text.substring(0, 300)}`);
    const clean = textBlock.text.replace(/```json/g, '').replace(/```/g, '').trim();
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error(`No JSON array found. Claude said: ${clean.substring(0, 200)}`);
    const events = JSON.parse(arrMatch[0]);

    cache[key] = events;
    saveOnThisDayCache(cache);
    console.log(`[saved]      On This Day ${key}`);

    res.json(events);
  } catch (err) {
    console.error(`[error]      onthisday: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Itinerary ─────────────────────────────────────────────────────────────────

app.post('/itinerary', async (req, res) => {
  const { cityName, state = '', country = '' } = req.body ?? {};
  if (!cityName?.trim()) return res.status(400).json({ error: 'cityName is required' });

  const name  = cityName.trim();
  const abbr  = normalizeState(state);
  const key   = `${name.toLowerCase()}-${abbr.toLowerCase()}`;
  const cache = loadItineraryCache();

  if (cache[key]) {
    console.log(`[cache hit]  itinerary: ${name}, ${abbr}`);
    return res.json(cache[key]);
  }

  const location = abbr ? `${name}, ${abbr}` : name;
  console.log(`[generating] itinerary: ${location} — calling Claude API...`);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `Create a curated 48-hour itinerary for a first-time visitor to ${location}${country ? ', ' + country : ''}. Plan exactly 2 days with 4-5 activities per day. Use real, specific place names in ${name}. Mix culture, food, local experiences, history, and atmosphere. Make it vivid and distinctive — not generic tourist boilerplate.

Respond with a single raw JSON object (no markdown fences):
{
  "city": "${name}",
  "days": [
    {
      "day": 1,
      "theme": "evocative 3-5 word theme (e.g. 'Old Town & Harbor Walk')",
      "activities": [
        {
          "time": "time string (e.g. '8:30 AM')",
          "title": "specific place or activity name",
          "description": "1-2 specific vivid sentences — what to do, see, eat, or experience here",
          "type": "one of: food | attraction | culture | nature | experience"
        }
      ],
      "tip": "one practical insider tip for the day"
    },
    {
      "day": 2,
      "theme": "different theme from day 1",
      "activities": [ ... ],
      "tip": "..."
    }
  ]
}`,
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content');
    console.log(`[claude]     itinerary raw (first 300): ${textBlock.text.substring(0, 300)}`);
    const itinerary = extractJSON(textBlock.text);

    cache[key] = itinerary;
    saveItineraryCache(cache);
    console.log(`[saved]      itinerary: ${name}`);

    res.json(itinerary);
  } catch (err) {
    console.error(`[error]      itinerary: ${err.message}`);
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
