// Sends the "Dürt" notifications that the GitHub Pages copy queued in the database (when the phone
// could not reach Vercel). Started on demand by the page through workflow_dispatch; the message text
// stays in the database and never appears in this public repo's logs.
import { neon } from "@neondatabase/serverless";
import webpush from "web-push";

if (!process.env.DATABASE_URL || !process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) {
  console.log("secrets not set yet; nothing sent");
  process.exit(0);
}
const T = process.env.COCO_TABLES || "coco";
const sql = neon(process.env.DATABASE_URL);
webpush.setVapidDetails("mailto:ramazan@tufanlar1952.com", process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

async function main() {
  await sql.query(`CREATE TABLE IF NOT EXISTS ${T}_nudge (id bigserial PRIMARY KEY, sender text NOT NULL, recipient text NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL, sent boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
  // claim the waiting ones in one step, so two runs never send the same nudge; older than 15 minutes is stale
  const rows = await sql.query(`UPDATE ${T}_nudge SET sent = true WHERE NOT sent AND created_at > now() - interval '15 minutes' RETURNING id, recipient, kind, title, body`);
  if (!rows.length) return console.log("nothing waiting");
  const subs = await sql.query(`SELECT endpoint, sub, who FROM ${T}_push`);
  let sent = 0;
  for (const r of rows) for (const s of subs.filter(s => s.who === r.recipient)) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: r.title, body: r.body, tag: "durt-" + r.kind }), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e) {
      console.log("failed", e.statusCode || e.code || "error");
      if (e.statusCode === 404 || e.statusCode === 410) await sql.query(`DELETE FROM ${T}_push WHERE endpoint = $1`, [s.endpoint]);
    }
  }
  console.log(`${rows.length} waiting, ${sent} delivered`);
}

main().catch(e => { console.error("failed:", e.code || e.name || "error"); process.exit(1); });
