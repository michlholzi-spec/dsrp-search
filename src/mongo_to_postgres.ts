import 'dotenv/config';
import { MongoClient, ObjectId, Db } from 'mongodb';
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';
import type { MongoOffer, MongoLocation, MongoOfficeHour, LabelValue } from './types.js';

const MONGO_URI  = process.argv[2] ?? 'mongodb://localhost:27017';
const PG_URI     = process.argv[3] ?? 'postgresql://kiagent@localhost/dsrp';
const BATCH_SIZE = 50;

const pg = new Pool({ connectionString: PG_URI });

async function applySchema(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pg.query(sql);
  console.log('Schema applied.');
}

function buildSearchText(offer: MongoOffer, categoryLabels: string[]): string {
  const parts = [
    offer.title,
    offer.description,
    offer.descriptionPrint,
    offer.description2,
    offer.description3,
    offer.description4,
    offer.institutionName,
    ...(offer.keyWords?.map(k => k.label) ?? []),
    ...(offer.targetGroups?.map(t => t.label) ?? []),
    ...categoryLabels,
    ...(offer.locationProvinces ?? []),
  ];
  return parts.filter(Boolean).join(' ');
}

async function upsertCategories(client: PoolClient, categories: LabelValue[]): Promise<void> {
  for (const cat of categories) {
    await client.query(
      `INSERT INTO categories(id, label) VALUES($1, $2) ON CONFLICT(id) DO NOTHING`,
      [cat.value, cat.label],
    );
  }
}

async function upsertLocation(client: PoolClient, loc: MongoLocation): Promise<void> {
  const coords = loc.location?.coordinates;
  await client.query(
    `INSERT INTO locations(
       id, institution_id, name, street, city, postcode, province, district,
       lat, lng, formatted_address, accessibility, accessibility_comment,
       email, phone, land_wide_valid
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT(id) DO UPDATE SET
       name=EXCLUDED.name, street=EXCLUDED.street, city=EXCLUDED.city,
       lat=EXCLUDED.lat, lng=EXCLUDED.lng, formatted_address=EXCLUDED.formatted_address`,
    [
      String(loc._id),
      loc.institutionId ?? null,
      loc.name ?? null,
      loc.street ?? null,
      loc.city ?? null,
      loc.postcode ?? null,
      loc.province ?? null,
      loc.district ?? null,
      coords ? coords[1] : null,
      coords ? coords[0] : null,
      loc.formatedAddress ?? null,
      loc.accessibility ?? null,
      loc.accessibilityComment ?? null,
      loc.email ?? null,
      loc.phone ?? null,
      loc.landWideValid ?? false,
    ],
  );
}

async function upsertOfficeHours(
  client: PoolClient,
  locationId: string,
  officeHourDocs: MongoOfficeHour[],
): Promise<void> {
  for (const oh of officeHourDocs) {
    const ohId = String(oh._id);
    await client.query(
      `INSERT INTO office_hours(id, location_id, label) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
      [ohId, locationId, oh.label ?? null],
    );
    for (const day of oh.days ?? []) {
      await client.query(
        `INSERT INTO office_hour_days(
           office_hour_id, day_id, day_label,
           hours_from, hours_to, additional_hours_from, additional_hours_to
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          ohId,
          day.id,
          day.label,
          day.officeHoursFrom || null,
          day.officeHoursTo || null,
          day.additionalOfficeHoursFrom || null,
          day.additionalOfficeHoursTo || null,
        ],
      );
    }
  }
}

function toObjectIds(ids: string[]): ObjectId[] {
  return ids.flatMap(id => { try { return [new ObjectId(id)]; } catch { return []; } });
}

async function processBatch(db: Db, offers: MongoOffer[]): Promise<void> {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    const allLocationIds = [...new Set(
      offers.flatMap(o => (o.locationsIds ?? []).map(l => l.value)),
    )];

    const locationDocs = allLocationIds.length
      ? await db.collection('locations')
          .find({ _id: { $in: toObjectIds(allLocationIds) } })
          .toArray() as MongoLocation[]
      : [];

    const locationMap = Object.fromEntries(locationDocs.map(l => [String(l._id), l]));

    const allOhIds = [...new Set(
      locationDocs.flatMap(l => (l.officeHours ?? []).map(oh => oh.value)),
    )];

    const ohDocs = allOhIds.length
      ? await db.collection('officehours')
          .find({ _id: { $in: toObjectIds(allOhIds) } })
          .toArray() as MongoOfficeHour[]
      : [];

    const ohByLocation: Record<string, MongoOfficeHour[]> = {};
    for (const loc of locationDocs) {
      const locId = String(loc._id);
      const ids   = (loc.officeHours ?? []).map(oh => oh.value);
      ohByLocation[locId] = ohDocs.filter(oh => ids.includes(String(oh._id)));
    }

    for (const offer of offers) {
      const offerId      = String(offer._id);
      const categories   = offer.categories ?? [];
      const categoryLabels = categories.map(c => c.label);

      await upsertCategories(client, categories);

      for (const locRef of offer.locationsIds ?? []) {
        const loc = locationMap[locRef.value];
        if (!loc) continue;
        const locId = String(loc._id);
        await upsertLocation(client, loc);
        if (ohByLocation[locId]?.length) {
          await upsertOfficeHours(client, locId, ohByLocation[locId]);
        }
      }

      await client.query(
        `INSERT INTO offers(
           id, title, slug, description, description_print,
           description2, description3, description4,
           website, costs, costs_comment, modes_of_contact,
           anonymous_counseling, appointment_arrangement,
           institution_id, institution_name,
           status, valid_from, valid_to, released_from, released_time,
           location_provinces, location_post_codes,
           keywords, target_groups, search_text,
           created_at, updated_at
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
         )
         ON CONFLICT(id) DO UPDATE SET
           title=EXCLUDED.title, description=EXCLUDED.description,
           status=EXCLUDED.status, search_text=EXCLUDED.search_text,
           updated_at=EXCLUDED.updated_at`,
        [
          offerId,
          offer.title || '',
          offer.slug ?? null,
          offer.description ?? null,
          offer.descriptionPrint ?? null,
          offer.description2 ?? null,
          offer.description3 ?? null,
          offer.description4 ?? null,
          offer.website ?? null,
          offer.costs ?? null,
          offer.costsComment ?? null,
          offer.modesOfContact ?? [],
          offer.anonymousCounseling ?? null,
          offer.appointmentArrangement ?? null,
          offer.institutionId ?? null,
          offer.institutionName ?? null,
          offer.status ?? 'released',
          offer.validFrom ?? null,
          offer.validTo ?? null,
          offer.releasedFrom ?? null,
          offer.releasedTime ?? null,
          offer.locationProvinces ?? [],
          offer.locationPostCodes ?? [],
          categories.map(k => k.label),
          (offer.targetGroups ?? []).map(t => t.label),
          buildSearchText(offer, categoryLabels),
          offer.createdAt ?? null,
          offer.updatedAt ?? null,
        ],
      );

      for (const cat of categories) {
        await client.query(
          `INSERT INTO offer_categories(offer_id, category_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [offerId, cat.value],
        );
      }

      for (const locRef of offer.locationsIds ?? []) {
        if (!locationMap[locRef.value]) continue;
        await client.query(
          `INSERT INTO offer_locations(offer_id, location_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [offerId, locRef.value],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function run(): Promise<void> {
  const mongo = new MongoClient(MONGO_URI);
  try {
    await mongo.connect();
    const db = mongo.db('dsrp');

    await applySchema();

    const total = await db.collection('offers').countDocuments({ status: 'released' });
    console.log(`Migrating ${total} released offers...`);

    const cursor = db.collection<MongoOffer>('offers').find({ status: 'released' });
    let count = 0;
    let batch: MongoOffer[] = [];

    for await (const offer of cursor) {
      batch.push(offer);
      if (batch.length >= BATCH_SIZE) {
        await processBatch(db, batch);
        count += batch.length;
        process.stdout.write(`\r  ${count}/${total}`);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await processBatch(db, batch);
      count += batch.length;
    }

    console.log(`\nDone. ${count} offers migrated to PostgreSQL.`);
  } finally {
    await mongo.close();
    await pg.end();
  }
}

run().catch(err => {
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
