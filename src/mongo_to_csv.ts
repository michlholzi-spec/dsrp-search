import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

const MONGO_URI   = process.argv[2] ?? 'mongodb://localhost:27017';
const OUTPUT_PATH = process.argv[3] ?? path.join(__dirname, '..', 'offers_export.csv');
const DB_NAME     = 'dsrp';
const COLLECTION  = 'offers';

type FlatRecord = Record<string, string | number | boolean | null>;

function flattenObject(obj: Record<string, unknown>, prefix = ''): FlatRecord {
  return Object.entries(obj).reduce<FlatRecord>((acc, [key, val]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      Object.assign(acc, flattenObject(val as Record<string, unknown>, fullKey));
    } else if (Array.isArray(val)) {
      acc[fullKey] = JSON.stringify(val);
    } else {
      acc[fullKey] = val instanceof Date ? val.toISOString() : (val as string | number | boolean | null);
    }
    return acc;
  }, {});
}

function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportToCSV(): Promise<void> {
  const client = new MongoClient(MONGO_URI);
  try {
    console.log(`Connecting to: ${MONGO_URI}`);
    await client.connect();

    const collection = client.db(DB_NAME).collection(COLLECTION);
    const total      = await collection.countDocuments();
    console.log(`Found ${total} documents in ${DB_NAME}.${COLLECTION}`);

    if (total === 0) {
      console.log('No documents found. Exiting.');
      return;
    }

    const headers = new Set<string>();
    const rows: FlatRecord[] = [];

    for await (const doc of collection.find({})) {
      const flat = flattenObject(doc as Record<string, unknown>);
      rows.push(flat);
      Object.keys(flat).forEach(k => headers.add(k));
    }

    const headerList = Array.from(headers);
    const csvLines = [
      headerList.map(escapeCSV).join(','),
      ...rows.map(row => headerList.map(h => escapeCSV(row[h])).join(',')),
    ];

    fs.writeFileSync(OUTPUT_PATH, csvLines.join('\n'), 'utf8');
    console.log(`Exported ${rows.length} rows to: ${OUTPUT_PATH}`);
  } finally {
    await client.close();
  }
}

exportToCSV().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
