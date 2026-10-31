// COCO notifications. Runs hourly on GitHub Actions (see .github/workflows/bildirim.yml).
// One run reads the agenda once, claims the notifications due in the next hour (so overlapping
// runs never send twice), then waits and sends each at its time through Apple/Google push.
// Reading once per hour keeps the Neon database asleep most of the day.
// The repo is public and so are its Actions logs: log kinds and times only, never names or titles.
//   env DATABASE_URL, VAPID_PUBLIC, VAPID_PRIVATE   optional COCO_TABLES (test prefix), COCO_NOW (fake clock), COCO_FAST=1 (no waiting)
import { neon } from "@neondatabase/serverless";
import webpush from "web-push";

// until the repo secrets are set, finish quietly instead of failing (and e-mailing) every hour
if (!process.env.DATABASE_URL || !process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) {
  console.log("secrets not set yet; nothing sent");
  process.exit(0);
}
const T = process.env.COCO_TABLES || "coco";
const FAST = process.env.COCO_FAST === "1";
const offset = process.env.COCO_NOW ? Date.parse(process.env.COCO_NOW) - Date.now() : 0;
const now = () => Date.now() + offset;
const TZ = 3 * 3600e3;   // Türkiye, UTC+3 all year
const sql = neon(process.env.DATABASE_URL);
webpush.setVapidDetails("mailto:ramazan@tufanlar1952.com", process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

// ---- dates: "YYYY-MM-DD" strings in Türkiye time, like the app ----
const pad = n => String(n).padStart(2, "0");
const dayOf = ms => new Date(ms + TZ).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const at = (d, hm) => Date.parse(`${d}T${hm}:00Z`) - TZ;
const weekday = d => new Date(d + "T00:00:00Z").getUTCDay();
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const DAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
const fmtDay = d => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]} ${DAYS[weekday(d)]}`;
const clip = (s, n = 170) => s.length > n ? s.slice(0, n - 1) + "…" : s;

// ---- same rules as coco.html ----
const PILATES = t => t === "pilates" || t === "ozel";
function occursOn(e, d) {
  if ((e.skip || []).includes(d)) return false;
  if (e.date === d) return true;
  return e.repeat === "weekly" && e.date < d && weekday(e.date) === weekday(d);
}
const eventsOn = (st, d) => st.events.filter(e => occursOn(e, d)).sort((a, b) => a.start < b.start ? -1 : 1);
const tasksOn = (st, d) => st.tasks.filter(t => !t.done && t.due === d).sort((a, b) => (a.time || "~") < (b.time || "~") ? -1 : 1);
function leftOf(st, s) {
  let n = s.prior || 0;
  for (const e of st.events) for (const [d, ids] of Object.entries(e.att || {})) if (d >= s.start && ids.includes(s.id)) n++;
  return s.pkg - n;
}
function nextPeriod(st) {
  const c = [...st.cycles].sort((a, b) => a.start < b.start ? -1 : 1);
  if (!c.length) return null;
  const gaps = [];
  for (let i = 1; i < c.length; i++) { const g = daysBetween(c[i - 1].start, c[i].start); if (g >= 18 && g <= 60) gaps.push(g); }
  const g = gaps.slice(-6), avg = g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : 28;
  return addDays(c[c.length - 1].start, avg);
}
const names = (st, ids) => ids.map(id => st.students.find(s => s.id === id)?.name.split(" ")[0]).filter(Boolean).join(", ");
const KIND = { odev: "Ödev", sinav: "Sınav", sunum: "Sunum", diger: "Görev" };

// Every notification COCO could send around `days`. who = only for that person, else for everyone.
function plan(st, days) {
  const out = [];
  const add = (kind, k, when, title, body, extra = {}) => out.push({ kind, k, at: when, title, body: clip(body), ...extra });
  for (const d of days) {
    const evs = eventsOn(st, d), tks = tasksOn(st, d);
    if (evs.length || tks.length) {
      const parts = [...evs.map(e => [e.start, `${e.start} ${e.title}`]), ...tks.map(t => [t.time || "~", `${t.time ? t.time + " " : ""}${t.title}${t.kind === "sinav" ? " (sınav)" : ""}`])];
      add("sabah", `sabah_${d}`, at(d, "06:00"), "Günaydın, bugün:", parts.sort((a, b) => a[0] < b[0] ? -1 : 1).map(p => p[1]).join(" · "));
    }
    for (const e of evs) {
      const who = names(st, e.students || []);
      add("seans", `seans_${e.id}_${d}`, at(d, e.start) - 3600e3, `${e.start} ${e.title}`,
        ["1 saat sonra başlıyor", who, e.place].filter(Boolean).join(" · "));
    }
    // a day-time nudge to message the members; morning classes get it the evening before
    const pil = evs.filter(e => PILATES(e.type) && (e.students || []).length);
    const early = pil.filter(e => e.start < "12:00"), later = pil.filter(e => e.start >= "12:00");
    const list = es => es.map(e => `${e.start} ${e.title}: ${names(st, e.students)}`).join(" · ");
    if (later.length) add("uye", `uye_${d}`, at(d, "10:00"), "Üyelerine dersi hatırlat", `Bugün ${list(later)}`);
    if (early.length) add("uye", `uyeS_${d}`, at(addDays(d, -1), "18:00"), "Üyelerine dersi hatırlat", `Yarın ${list(early)}`);
    for (const t of tks) {
      add("sinav", `tY_${t.id}_${d}`, at(addDays(d, -1), "20:00"), `Yarın: ${t.title}`,
        [t.time, KIND[t.kind] || "Görev", t.note].filter(Boolean).join(" · "));
      if (t.time && t.kind === "sinav") add("sinav", `t2_${t.id}_${d}_${t.time}`, at(d, t.time) - 2 * 3600e3, `${t.time} ${t.title}`,
        ["2 saat sonra", t.note].filter(Boolean).join(" · "));
    }
    add("deger", `deger_${d}`, at(d, "21:00"), "Gün sonu değerlendirmesi", "Bugünkü değerlendirmeni henüz doldurmadın.", { evalDay: d });
    for (const s of st.students) {
      const left = leftOf(st, s);
      if (left === 1 || left === 0) add("paket", `paket_${s.id}_${s.start}_${left}`, at(d, "10:00"), `${s.name.split(" ")[0]}: paket ${left ? "bitiyor" : "bitti"}`,
        left ? `${s.name} için 1 ders kaldı.` : `${s.name} paketindeki tüm dersleri kullandı.`);
    }
    const np = nextPeriod(st);
    if (np && addDays(np, -2) === d) add("regl", `regl_${np}`, at(d, "09:00"), "Regl yaklaşıyor", `Tahmini başlangıç ${fmtDay(np)}.`);
  }
  return out;
}

async function main() {
  await sql.query(`CREATE TABLE IF NOT EXISTS ${T}_push (endpoint text PRIMARY KEY, sub jsonb NOT NULL, who text NOT NULL DEFAULT '', prefs jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now())`);
  await sql.query(`CREATE TABLE IF NOT EXISTS ${T}_push_sent (k text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`);
  await sql.query(`DELETE FROM ${T}_push_sent WHERE at < now() - interval '120 days'`);
  const subs = await sql.query(`SELECT endpoint, sub, who, prefs FROM ${T}_push`);
  const rows = await sql.query(`SELECT data FROM ${T}_store WHERE id = 1`);
  if (!subs.length || !rows.length) return console.log("nothing to do:", subs.length, "subscriptions");
  const st = { events: [], tasks: [], students: [], cycles: [], manita: {}, ...rows[0].data };

  // late runs still catch the last 45 minutes; the next run overlaps this one by design
  const t0 = now(), from = t0 - 45 * 60e3, to = t0 + 62 * 60e3;
  const today = dayOf(t0);
  const due = plan(st, [addDays(today, -1), today, addDays(today, 1), addDays(today, 2)]).filter(n => n.at >= from && n.at < to);
  const jobs = [];
  for (const s of subs) {
    const prefs = s.prefs || {}, short = s.endpoint.slice(-24);
    for (const n of due) {
      if (prefs[n.kind] === false) continue;
      if (n.kind === "deger" && !s.who) continue;
      jobs.push({ ...n, sub: s, claim: `${n.k}|${short}` });
    }
  }
  if (!jobs.length) return console.log("no notifications due");
  const won = new Set((await sql.query(`INSERT INTO ${T}_push_sent (k) SELECT unnest($1::text[]) ON CONFLICT (k) DO NOTHING RETURNING k`, [jobs.map(j => j.claim)])).map(r => r.k));
  const mine = jobs.filter(j => won.has(j.claim)).sort((a, b) => a.at - b.at);
  console.log(`${mine.length} to send (${jobs.length - mine.length} already sent)`);

  for (const j of mine) {
    const wait = j.at - now();
    if (wait > 0 && !FAST) await new Promise(r => setTimeout(r, wait));
    if (j.kind === "seans" && now() - j.at > 20 * 60e3) { console.log("skip, too late:", j.kind); continue; }   // "1 saat sonra" would be wrong
    if (j.kind === "deger") {   // she may have filled it in since the run started
      const [r] = await sql.query(`SELECT data->'manita'->'evals' AS evals FROM ${T}_store WHERE id = 1`);
      if ((r?.evals || []).some(e => e.date === j.evalDay && e.who === j.sub.who)) { console.log("skip, filled:", j.kind); continue; }
    }
    try {
      await webpush.sendNotification(j.sub.sub, JSON.stringify({ title: j.title, body: j.body, tag: j.k }), { TTL: 4 * 3600, urgency: "high" });
      console.log("sent", j.kind, new Date(j.at + TZ).toISOString().slice(11, 16));
    } catch (e) {
      console.log("failed", j.kind, e.statusCode || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) await sql.query(`DELETE FROM ${T}_push WHERE endpoint = $1`, [j.sub.endpoint]);   // phone removed the app or the permission
    }
  }
}

main().catch(e => { console.error("failed:", e.code || e.name || "error"); process.exit(1); });
