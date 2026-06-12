import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { Pool } from 'pg';
import { getEmbedding } from './embedding.js';
import type {
  GeocodedLocation,
  NominatimResult,
  SearchRequest,
  SearchResponse,
} from './types.js';

const PG_URI = process.env.DATABASE_URL ?? 'postgresql://kiagent@localhost/dsrp';
const PORT   = process.env.PORT ?? 3000;

const pg  = new Pool({ connectionString: PG_URI });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));   // works for both src/ and dist/

const PLACE_TYPES = new Set([
  'city', 'town', 'village', 'municipality', 'hamlet', 'suburb', 'quarter',
  'neighbourhood', 'administrative', 'county', 'state', 'district', 'borough',
  'city_district',
]);

async function geocodePlace(candidate: string): Promise<GeocodedLocation | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search`
      + `?q=${encodeURIComponent(candidate + ', Österreich')}`
      + `&format=json&limit=1&countrycodes=at&addressdetails=0`;

    const res  = await fetch(url, { headers: { 'User-Agent': 'dsrp-search/1.0' } });
    if (!res.ok) return null;
    const data = await res.json() as NominatimResult[];

    if (!data.length) return null;
    const hit = data[0];
    if (!PLACE_TYPES.has(hit.type) && !PLACE_TYPES.has(hit.addresstype)) return null;

    return {
      lat:        parseFloat(hit.lat),
      lng:        parseFloat(hit.lon),
      name:       hit.display_name.split(',')[0],
      cleanQuery: '',
    };
  } catch {
    return null;
  }
}

async function extractLocation(query: string): Promise<GeocodedLocation | null> {
  const words     = query.trim().split(/\s+/);
  const maxNgram  = Math.min(3, words.length);

  for (let len = maxNgram; len >= 1; len--) {
    for (let start = words.length - len; start >= 0; start--) {
      const candidate = words.slice(start, start + len).join(' ');
      const geo       = await geocodePlace(candidate);
      if (geo) {
        const cleanQuery = [...words.slice(0, start), ...words.slice(start + len)]
          .join(' ')
          .trim();
        return { ...geo, cleanQuery: cleanQuery || query };
      }
    }
  }
  return null;
}

// GET /health — lightweight healthcheck (no DB)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

const ALL_PROVINCES = ['tirol','wien','salzburg','steiermark','vorarlberg','kaernten','niederoesterreich','oberoesterreich'];

async function fetchSrpProvince(q: string, province: string): Promise<Record<string, unknown>[]> {
  const url = `https://www.sozialroutenplan.at/api/de/${encodeURIComponent(province)}/searchOffersWithFilter/alle/alle/alle/alle/${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'dsrp-search/1.0' } });
  if (!res.ok) return [];
  return res.json() as Promise<Record<string, unknown>[]>;
}

function mapSrpOffer(o: Record<string, unknown>) {
  return {
    id:               o['_id'],
    title:            o['title'],
    slug:             o['slug'],
    institution_name: o['institutionName'],
    description:      o['descriptionPrint'] || o['description'],
    website:          o['website'],
    costs:            o['costs'],
    location_provinces: o['locationProvinces'],
    categories:       (o['categories'] as { label: string }[] ?? []).map(c => ({ label: c.label, slug: '' })),
    locations:        (o['locations'] as Record<string, unknown>[] ?? [])
                        .map(l => ({ city: l['city'], street: l['street'], formatted_address: l['formatedAddress'] })),
    score:            o['score'],
  };
}

// GET /api/srp?q=pflegegeld&provinces=tirol,wien  (leer = alle)
app.get('/api/srp', async (req: Request, res: Response) => {
  const q         = String(req.query['q'] ?? '').trim();
  const provinces = String(req.query['provinces'] ?? '')
    .split(',').map(p => p.trim()).filter(Boolean);

  if (!q) { res.status(400).json({ error: 'q is required' }); return; }

  const targets = provinces.length ? provinces : ALL_PROVINCES;

  try {
    const batches = await Promise.all(targets.map(p => fetchSrpProvince(q, p)));
    // Deduplicate by _id, keep highest score
    const seen = new Map<string, Record<string, unknown>>();
    for (const batch of batches) {
      for (const o of batch) {
        const id = String(o['_id']);
        const existing = seen.get(id);
        if (!existing || (Number(o['score']) > Number(existing['score']))) {
          seen.set(id, o);
        }
      }
    }
    const results = [...seen.values()]
      .sort((a, b) => Number(b['score']) - Number(a['score']))
      .slice(0, 50)
      .map(mapSrpOffer);

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/search-terms
app.get('/api/search-terms', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pg.query<{ term: string }>(
      'SELECT term FROM search_terms ORDER BY term',
    );
    res.json(rows.map(r => r.term));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/provinces
app.get('/api/provinces', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pg.query<{ province: string }>(
      'SELECT DISTINCT unnest(location_provinces) AS province FROM offers ORDER BY province',
    );
    res.json(rows.map((r: { province: string }) => r.province));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/search
app.post('/api/search', async (req: Request<object, SearchResponse, SearchRequest>, res: Response) => {
  const { query, provinces = [], limit = 10 } = req.body;

  if (!query?.trim()) {
    res.status(400).json({ error: 'query is required' } as unknown as SearchResponse);
    return;
  }

  try {
    const [location, embedding] = await Promise.all([
      extractLocation(query.trim()),
      getEmbedding(query.trim()),
    ]);

    const hasLocation = location !== null;
    const vector      = `[${embedding.join(',')}]`;
    // Clean query for text matching (strip extracted location)
    const cleanQuery = location?.cleanQuery ?? query.trim();
    const params: unknown[] = [vector, Math.min(limit, 50), cleanQuery];
    let paramIndex = 4;

    const provinceFilter = provinces.length > 0
      ? `AND o.location_provinces && $${paramIndex++}::text[]`
      : '';
    if (provinces.length > 0)
      params.push(`{${provinces.map(p => `"${p}"`).join(',')}}`);

    const distanceExpr = hasLocation
      ? `(
           SELECT ROUND(MIN(
             6371 * 2 * ASIN(SQRT(
               POWER(SIN(RADIANS((l.lat - $${paramIndex}) / 2)), 2) +
               COS(RADIANS($${paramIndex})) * COS(RADIANS(l.lat)) *
               POWER(SIN(RADIANS((l.lng - $${paramIndex + 1}) / 2)), 2)
             ))
           )::numeric, 1)
           FROM offer_locations ol
           JOIN locations l ON l.id = ol.location_id
           WHERE ol.offer_id = o.id AND l.lat IS NOT NULL AND l.lng IS NOT NULL
         )`
      : 'NULL';

    if (hasLocation) {
      params.push(location.lat, location.lng);
      paramIndex += 2;
    }

    const { rows } = await pg.query(
      `SELECT
         o.id, o.title, o.slug, o.institution_name,
         o.description, o.description_print, o.website, o.costs,
         o.modes_of_contact, o.location_provinces, o.location_post_codes,
         o.keywords, o.target_groups,
         ROUND((
           (1 - (o.embedding <=> $1::vector))
           + CASE WHEN o.title          ILIKE '%' || $3 || '%' THEN 0.15 ELSE 0 END
           + CASE WHEN o.institution_name ILIKE '%' || $3 || '%' THEN 0.10 ELSE 0 END
         )::numeric, 4) AS score,
         ${distanceExpr} AS distance_km,
         (
           SELECT json_agg(json_build_object('label', c.label, 'slug', c.slug))
           FROM offer_categories oc
           JOIN categories c ON c.id = oc.category_id
           WHERE oc.offer_id = o.id
         ) AS categories,
         (
           SELECT json_agg(json_build_object(
             'name', l.name, 'street', l.street, 'city', l.city,
             'postcode', l.postcode, 'province', l.province,
             'lat', l.lat, 'lng', l.lng, 'formatted_address', l.formatted_address
           ))
           FROM offer_locations ol
           JOIN locations l ON l.id = ol.location_id
           WHERE ol.offer_id = o.id
         ) AS locations
       FROM offers o
       WHERE o.embedding IS NOT NULL
       AND (1 - (o.embedding <=> $1::vector)) >= 0.35
       ${provinceFilter}
       ORDER BY o.embedding <=> $1::vector
       LIMIT $2`,
      params,
    );

    const response: SearchResponse = {
      query,
      location: location
        ? { name: location.name, lat: location.lat, lng: location.lng }
        : null,
      results: rows,
    };
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message } as unknown as SearchResponse);
  }
});

const SYSTEM_PROMPT = `Du bist ein einfühlsamer Sozialberater für das Bundesland Tirol. Du hilfst Menschen dabei, das passendste Sozialangebot in Tirol zu finden.

WICHTIGE REGELN:
1. Nutze "search_offers" sofort bei jeder Nachricht – auch mit unvollständigen Informationen.
2. Nenne die gefundenen Angebote NIEMALS im Chat-Text. Die Top-4 Angebote werden automatisch rechts angezeigt.
3. Wenn der Durchschnittliche Match unter 65% liegt: Die Ergebnisse sind ungenau. Stelle eine gezielte Nachfrage zur Eingrenzung (nach Ort, Alter, konkretem Anliegen). Erwähne kurz dass du Angebote gefunden hast aber noch präziser suchen kannst.
4. Wenn der Durchschnittliche Match 65% oder höher: Bestätige kurz dass du passende Angebote gefunden hast und erkläre in 1-2 Sätzen warum diese passen.
5. Wenn 0 Angebote gefunden wurden: Erkläre das und stelle eine Frage für eine neue Suche.
6. Einfache Sprache, kurze Wörter, kein Fachjargon. Schreib wie im Gespräch.
7. Maximal 1 Satz + 1 Frage. Nie mehr. Keine Einleitung wie "Ich habe gefunden..." – komm direkt zum Punkt.
8. Beispiel gute Antwort: "Passende Angebote sind rechts zu sehen. In welchem Bezirk bist du?"`;

interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }

async function searchOffersForChat(
  query: string, province: string, lat: number | null, lng: number | null
): Promise<object[]> {
  const embedding = await getEmbedding(query);
  const vector    = `[${embedding.join(',')}]`;
  const params: unknown[] = [vector, 20, query];
  let paramIndex = 4;

  const provinceFilter = province
    ? `AND o.location_provinces && $${paramIndex++}::text[]`
    : '';
  if (province) params.push(`{"${province}"}`);

  // Haversine distance to nearest location
  const hasGeo = lat !== null && lng !== null;
  const distExpr = hasGeo
    ? `(SELECT MIN(6371 * 2 * ASIN(SQRT(
         POWER(SIN(RADIANS((l.lat - $${paramIndex}) / 2)), 2) +
         COS(RADIANS($${paramIndex})) * COS(RADIANS(l.lat)) *
         POWER(SIN(RADIANS((l.lng - $${paramIndex + 1}) / 2)), 2)
       )))
       FROM offer_locations ol JOIN locations l ON l.id = ol.location_id
       WHERE ol.offer_id = o.id AND l.lat IS NOT NULL)`
    : 'NULL';

  if (hasGeo) { params.push(lat, lng); paramIndex += 2; }

  const { rows } = await pg.query(
    `SELECT o.id, o.title, o.slug, o.institution_name, o.description_print, o.description,
            o.website, o.costs, o.location_provinces,
            ${distExpr} AS distance_km,
            ROUND((
              -- 60% semantischer Score
              (1 - (o.embedding <=> $1::vector)) * 0.6
              -- 15% Titel-Boost
              + CASE WHEN o.title            ILIKE '%' || $3 || '%' THEN 0.15 ELSE 0 END
              -- 10% Institutions-Boost
              + CASE WHEN o.institution_name  ILIKE '%' || $3 || '%' THEN 0.10 ELSE 0 END
              -- 30% Nähe-Boost (max bei 0 km, 0 bei ≥ 50 km) — nur wenn Geo bekannt
              ${hasGeo ? `+ GREATEST(0, (50 - COALESCE(${distExpr}, 50)) / 50.0) * 0.30` : ''}
            )::numeric, 4) AS score,
            (SELECT json_agg(json_build_object('label', c.label))
             FROM offer_categories oc JOIN categories c ON c.id = oc.category_id
             WHERE oc.offer_id = o.id) AS categories,
            (SELECT json_agg(json_build_object('city', l.city, 'street', l.street))
             FROM offer_locations ol JOIN locations l ON l.id = ol.location_id
             WHERE ol.offer_id = o.id) AS locations
     FROM offers o
     WHERE o.embedding IS NOT NULL
       AND (1 - (o.embedding <=> $1::vector)) >= 0.45
       ${provinceFilter}
     ORDER BY score DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

// POST /api/chat
app.post('/api/chat', async (req: Request, res: Response) => {
  const { messages }: { messages: ChatMessage[] } = req.body;
  if (!messages?.length) { res.status(400).json({ error: 'messages required' }); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'OPENAI_API_KEY not set' }); return; }

  try {
    const tools = [{
      type: 'function',
      function: {
        name: 'search_offers',
        description: 'Sucht passende Sozialangebote. Nahegelegene Angebote werden höher gereiht wenn ein Ort angegeben wird.',
        parameters: {
          type: 'object',
          properties: {
            query:    { type: 'string', description: 'Suchbegriff z.B. "Pflegeberatung ältere Menschen"' },
            province: { type: 'string', enum: ['Tirol'], description: 'Immer "Tirol"' },
            location: { type: 'string', description: 'Ort für Distanzberechnung, z.B. "Innsbruck", "Bregenz", "6020" – leer wenn unbekannt' },
          },
          required: ['query', 'province', 'location'],
        },
      },
    }];

    const openaiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    // First call
    const firstRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: openaiMessages, tools, tool_choice: 'auto' }),
    });
    const firstData = await firstRes.json() as { choices: { message: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const assistantMsg = firstData.choices[0].message;

    // If tool call needed
    if (assistantMsg.tool_calls?.length) {
      const toolCall  = assistantMsg.tool_calls[0];
      const args      = JSON.parse(toolCall.function.arguments) as { query: string; province: string; location?: string };
      args.province = 'Tirol'; // hardcoded

      // Geocode location if provided
      let lat: number | null = null;
      let lng: number | null = null;
      if (args.location?.trim()) {
        const geo = await geocodePlace(args.location.trim());
        if (geo) { lat = geo.lat; lng = geo.lng; }
      }

      const offers = await searchOffersForChat(args.query, args.province, lat, lng);

      // Compact offer list for GPT context
      const offerList = (offers as Record<string, unknown>[]).slice(0, 8);
      const topScores = offerList.map(o => Number(o['score']));
      const avgScore  = topScores.reduce((a, b) => a + b, 0) / (topScores.length || 1);
      const offerSummary = `Gefundene Angebote: ${offers.length} (Durchschnittlicher Match: ${(avgScore * 100).toFixed(0)}%)\n\n` +
        offerList.map((o, i) => {
          const dist = o['distance_km'] != null ? ` | ${Number(o['distance_km']).toFixed(1)} km entfernt` : '';
          return `${i + 1}. "${o['title']}" (${o['institution_name']}) Score: ${(Number(o['score']) * 100).toFixed(0)}%${dist} – ${String(o['description_print'] || o['description'] || '').slice(0, 120)}`;
        }).join('\n');

      const secondRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            ...openaiMessages,
            assistantMsg,
            { role: 'tool', tool_call_id: toolCall.id, content: offerSummary || 'Keine Angebote gefunden.' },
          ],
        }),
      });
      const secondData = await secondRes.json() as { choices: { message: { content: string } }[] };

      // Top 4 anzeigen — Bot fragt per System-Prompt nach wenn Score-Qualität niedrig
      const topOffers = (offers as Record<string, unknown>[])
        .sort((a, b) => Number(b['score']) - Number(a['score']))
        .slice(0, 4);
      res.json({ reply: secondData.choices[0].message.content, offers: topOffers, offerCount: offers.length });
    } else {
      res.json({ reply: assistantMsg.content, offers: [] });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Search API running at http://localhost:${PORT}`);
  const provider = process.env.OPENAI_API_KEY ? 'OpenAI' : 'Ollama';
  console.log(`Embedding: ${provider} (nomic-embed-text)`);
});
