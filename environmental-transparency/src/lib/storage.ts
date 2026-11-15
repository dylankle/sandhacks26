import "server-only";
import { createHash } from "node:crypto";
import { getAdmin } from "@/lib/supabase/admin";
import { STORAGE_BUCKET } from "@/lib/config";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let bucketReady: Promise<void> | null = null;

/** Ensures the private cache bucket exists (idempotent). */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const admin = getAdmin();
    const { data } = await admin.storage.getBucket(STORAGE_BUCKET);
    if (!data) {
      const { error } = await admin.storage.createBucket(STORAGE_BUCKET, { public: false });
      if (error && !/already exists/i.test(error.message)) throw error;
    }
  })().catch((e) => {
    bucketReady = null;
    throw e;
  });
  return bucketReady;
}

export async function putObject(path: string, body: string | Buffer, contentType: string) {
  await ensureBucket();
  const { error } = await getAdmin()
    .storage.from(STORAGE_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed (${path}): ${error.message}`);
}

export async function getObject(path: string): Promise<Buffer | null> {
  await ensureBucket();
  const { data, error } = await getAdmin().storage.from(STORAGE_BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

export async function getJson<T>(path: string): Promise<T | null> {
  const buf = await getObject(path);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function putJson(path: string, value: unknown) {
  await putObject(path, JSON.stringify(value), "application/json");
}

export async function listObjects(prefix: string, limit = 20) {
  await ensureBucket();
  const { data, error } = await getAdmin()
    .storage.from(STORAGE_BUCKET)
    .list(prefix, { limit, sortBy: { column: "name", order: "desc" } });
  if (error) throw error;
  return data ?? [];
}

/** Cached plain text of a stored document, keyed by content hash (used for grounded Q&A). */
export const documentTextPath = (contentHash: string) => `text/${contentHash}.txt`;
