import 'dotenv/config';
import express from 'express';
import { authRouter, userTier } from './auth.js';
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.use(authRouter);
app.get('/healthz', (req, res) => res.send('ok'));

// ---- tiny in-memory cache (swap for Redis/Postgres later) ----
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
const getJSON = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`);
  return r.json();
};

// ---- Provider: postcodes.io (free geocoding for UK postcodes) ----
const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const extractPostcode = (q) => (q.match(PC_RE)?.[1] || '').toUpperCase().replace(/\s+/g, '').replace(/(\d[A-Z]{2})$/, ' $1');
async function geocode(postcode) {
  const { result } = await getJSON(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  return { postcode: result.postcode, lat: result.latitude, lng: result.longitude,
           district: result.admin_district, region: result.region || result.country, country: result.country };
}
async function nearbyPostcodes(lat, lng) {
  const { result } = await getJSON(`https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&radius=500&limit=25`);
  return (result || []).map((r) => r.postcode);
}

// ---- Provider: HM Land Registry Price Paid Data (SPARQL, England & Wales) ----
async function soldPrices(postcodes, sinceISO) {
  const values = postcodes.map((p) => `"${p}"^^xsd:string`).join(' ');
  const query = `
prefix xsd: <http://www.w3.org/2001/XMLSchema#>
prefix lrppi: <http://landregistry.data.gov.uk/def/ppi/>
prefix lrcommon: <http://landregistry.data.gov.uk/def/common/>
prefix skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?paon ?saon ?street ?town ?postcode ?amount ?date ?type WHERE {
  VALUES ?postcode { ${values} }
  ?addr lrcommon:postcode ?postcode .
  ?tx lrppi:propertyAddress ?addr ; lrppi:pricePaid ?amount ; lrppi:transactionDate ?date .
  OPTIONAL { ?tx lrppi:propertyType/skos:prefLabel ?type }
  OPTIONAL { ?addr lrcommon:paon ?paon } OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street } OPTIONAL { ?addr lrcommon:town ?town }
  FILTER (?date >= "${sinceISO}"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 60`;
  const data = await getJSON('https://landregistry.data.gov.uk/landregistry/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }),
  });
  const v = (b, k) => b[k]?.value || '';
  return data.results.bindings.map((b) => ({
    address: [v(b, 'saon'), v(b, 'paon'), v(b, 'street')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() + `, ${v(b, 'town')}`,
    postcode: v(b, 'postcode'), price: Number(v(b, 'amount')), date: v(b, 'date'), type: v(b, 'type'),
  }));
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

// ---- Provider: data.police.uk (street-level crime, ~1 mile radius) ----
async function crimeSummary(lat, lng) {
  const { date } = await getJSON('https://data.police.uk/api/crime-last-updated');
  const month = date.slice(0, 7);
  const crimes = await getJSON(`https://data.police.uk/api/crimes-street/all-crime?lat=${lat}&lng=${lng}&date=${month}`);
  const by = {};
  crimes.forEach((c) => (by[c.category] = (by[c.category] || 0) + 1));
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, count]) => ({ category, count }));
  return { month, total: crimes.length, top };
}

// ---- Provider: EPC (England & Wales) — "Get energy performance of buildings data" service ----
// Auth (bearer token from your GOV.UK One Login account page) is confirmed. The search path and response
// field names below are ASSUMED from the old API and must be checked against the service's API guidance;
// both are overridable via env. Keys are normalised so kebab/snake/camel variants all match.
const EPC_BASE = process.env.EPC_API_BASE || 'https://get-energy-performance-data.communities.gov.uk/api';
const EPC_SEARCH = process.env.EPC_SEARCH_PATH || '/domestic/search';
const norm = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]));
const pick = (r, ...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return null; };
const toks = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
async function epcForAddress(q, postcode) {
  if (!process.env.EPC_API_TOKEN) return { error: 'EPC token not configured' };
  const r = await fetch(`${EPC_BASE}${EPC_SEARCH}?postcode=${encodeURIComponent(postcode)}&size=100`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${process.env.EPC_API_TOKEN}` },
  });
  if (!r.ok) return { error: `EPC service responded ${r.status}` };
  const body = await r.json();
  const raw = Array.isArray(body) ? body : body.rows || body.data || body.results || [];
  if (process.env.EPC_DEBUG) console.log('EPC sample row:', JSON.stringify(raw[0]));
  const rows = raw.map(norm).map((x) => ({
    address: [pick(x, 'address', 'address1'), x.address2, x.address3].filter(Boolean).join(' '),
    floorAreaM2: Number(pick(x, 'totalfloorarea')) || null, rating: pick(x, 'currentenergyrating'),
    score: Number(pick(x, 'currentenergyefficiency')) || null, builtForm: pick(x, 'builtform'),
    propertyType: pick(x, 'propertytype'), ageBand: pick(x, 'constructionageband'),
    rooms: Number(pick(x, 'numberhabitablerooms')) || null, lodged: pick(x, 'lodgementdate', 'lodgementdatetime'),
  }));
  const want = toks(q.replace(PC_RE, ''));
  if (!want.length) return { candidates: rows.length };            // postcode only: no single property to match
  let best = null, bestScore = 0;
  for (const row of rows) {
    const have = new Set(toks(row.address));
    const score = want.filter((t) => have.has(t)).length / want.length;
    if (score > bestScore || (score === bestScore && best && String(row.lodged) > String(best.lodged))) { best = row; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : { candidates: rows.length };
}

// ---- API ----
app.get('/api/property', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const postcode = extractPostcode(q);
    if (!postcode) return res.status(400).json({ error: 'Enter a full UK postcode, e.g. "SW1A 1AA" or "10 Downing St, SW1A 2AA".' });
    const out = await cached(`prop:${postcode}`, 6 * 3600e3, async () => {
      const geo = await geocode(postcode);
      if (geo.country === 'Scotland' || geo.country === 'Northern Ireland')
        throw Object.assign(new Error('Version 1 covers England and Wales only.'), { status: 422 });
      const since = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
      const [pcs, crime] = await Promise.all([nearbyPostcodes(geo.lat, geo.lng), crimeSummary(geo.lat, geo.lng).catch(() => null)]);
      const sales = await soldPrices([...new Set([geo.postcode, ...pcs])], since);
      return { query: q, location: geo, sales, medianSold: median(sales.map((s) => s.price)), crime, epc: await epcForAddress(q, geo.postcode).catch((e) => ({ error: e.message })) };
    });
    res.json(userTier(req) === 'subscribed' ? out : { ...out, crime: null, crimeLocked: true });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`PropertyBuddy running on http://localhost:${PORT}`));
