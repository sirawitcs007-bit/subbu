// SUBBU LINE reminders (Cloudflare Worker)
//
//  POST /line/webhook  LINE Messaging API webhook. Links a LINE user to a SUBBU account when they
//                      send the 6-digit code from the app, and answers follow events with instructions.
//  scheduled (cron)    Every morning, sends each linked user one LINE message listing the charges whose
//                      reminder day is today.
//  POST /cron          Runs the daily job on demand. Requires the x-cron-key header (CRON_KEY secret).
//
// Secrets: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, GOOGLE_SERVICE_ACCOUNT (JSON key), CRON_KEY
// Vars (wrangler.toml): FIREBASE_PROJECT_ID, APP_URL, TZ_OFFSET_MINUTES

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/line/webhook") return handleWebhook(request, env, ctx);
    if (request.method === "POST" && url.pathname === "/cron") {
      if (!env.CRON_KEY || request.headers.get("x-cron-key") !== env.CRON_KEY) return new Response("Forbidden", { status: 403 });
      const result = await runDaily(env);
      return Response.json(result);
    }
    return new Response("SUBBU LINE reminders", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  }
};

/* ---------------- LINE webhook ---------------- */

async function handleWebhook(request, env, ctx) {
  const body = await request.text();
  if (!(await validSignature(body, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET))) {
    return new Response("Bad signature", { status: 401 });
  }
  const events = (JSON.parse(body).events) || [];
  // LINE expects a quick 200; do the work after responding.
  ctx.waitUntil(Promise.all(events.map(e => handleEvent(e, env).catch(err => console.error("event failed", err)))));
  return new Response("OK");
}

async function validSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleEvent(event, env) {
  if (event.type === "follow") return reply(env, event.replyToken, MSG.th.welcome + "\n\n" + MSG.en.welcome);
  if (event.type !== "message" || event.message.type !== "text") return;

  const lineUserId = event.source && event.source.userId;
  const code = (event.message.text.match(/\b(\d{6})\b/) || [])[1];
  if (!code || !lineUserId) return reply(env, event.replyToken, MSG.th.help + "\n\n" + MSG.en.help);

  const fs = await firestore(env);
  const link = await fs.get(`lineLinks/${code}`);
  if (!link || !link.uid || !(link.expires > Date.now())) {
    return reply(env, event.replyToken, MSG.th.badCode + "\n\n" + MSG.en.badCode);
  }
  const lang = link.lang === "en" ? "en" : "th";
  await fs.set(`lineUsers/${link.uid}`, { lineUserId, lang, linkedAt: new Date().toISOString() });
  await fs.delete(`lineLinks/${code}`);

  // Confirm with what's coming up this week (a reply message, which doesn't use the push quota).
  const subs = await fs.list(`users/${link.uid}/subs`);
  const today = todayUTC(env);
  const week = upcoming(subs, today, 7);
  const m = MSG[lang];
  let text = m.linked;
  text += "\n\n" + (week.length ? m.weekHead + "\n" + week.map(o => "• " + m.chargeLine(o, today)).join("\n") : m.weekNone);
  return reply(env, event.replyToken, text);
}

/* ---------------- daily reminders ---------------- */

async function runDaily(env) {
  const fs = await firestore(env);
  const today = todayUTC(env);
  const users = await fs.listWithIds("lineUsers");
  let sent = 0, failed = 0;
  for (const { id: uid, data: u } of users) {
    if (!u.lineUserId) continue;
    const subs = await fs.list(`users/${uid}/subs`);
    const due = dueToday(subs, today);
    if (!due.length) continue;
    const m = MSG[u.lang === "en" ? "en" : "th"];
    const text = m.dailyHead(due.length) + "\n\n" + due.map(o => "• " + m.chargeLine(o, today)).join("\n") + "\n\n" + m.open(env.APP_URL);
    const ok = await push(env, u.lineUserId, text);
    ok ? sent++ : failed++;
  }
  console.log(`daily reminders: users=${users.length} sent=${sent} failed=${failed}`);
  return { users: users.length, sent, failed, date: iso(today) };
}

/* ---------------- reminder rules (mirror the app) ---------------- */

const DAY = 86400000;
const MONTHS = { weekly: null, monthly: 1, quarterly: 3, yearly: 12 };

function todayUTC(env) {
  const offset = Number(env.TZ_OFFSET_MINUTES || 420);
  const local = new Date(Date.now() + offset * 60000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function step(t, cycle) {
  if (cycle === "weekly") return t + 7 * DAY;
  const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + (MONTHS[cycle] || 1)); return d.getTime();
}
// The next charge on or after today, or null if the subscription has ended.
function nextCharge(s, today) {
  if (!s || s.status === "cancelled" || !(Number(s.price) > 0)) return null;
  let next = parseDate(s.next); if (next == null) return null;
  const cycle = MONTHS.hasOwnProperty(s.cycle) ? s.cycle : "monthly";
  let guard = 0;
  while (next < today && guard++ < 600) next = step(next, cycle);
  const last = s.inst && parseDate(s.inst.last);
  if (last != null && next > last) return null;
  return next;
}
function dueToday(subs, today) {
  const out = [];
  for (const s of subs) {
    const remind = Number(s.remind) || 0;
    if (remind <= 0) continue;
    const next = nextCharge(s, today);
    if (next != null && next - remind * DAY === today) out.push({ s, date: next });
  }
  return out.sort((a, b) => a.date - b.date);
}
function upcoming(subs, today, days) {
  const out = [];
  for (const s of subs) {
    const next = nextCharge(s, today);
    if (next != null && next - today <= days * DAY) out.push({ s, date: next });
  }
  return out.sort((a, b) => a.date - b.date);
}

/* ---------------- messages ---------------- */

const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const TH_DAY = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const EN_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const METHOD_TH = { "Bank debit": "หักบัญชีธนาคาร", "PromptPay transfer": "โอนพร้อมเพย์", "Cash": "เงินสด" };
function money(n, cur) {
  const s = Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cur === "USD" ? "$" : "฿") + s;
}
const dateTh = t => { const d = new Date(t); return `${TH_DAY[d.getUTCDay()]} ${d.getUTCDate()} ${TH_MON[d.getUTCMonth()]}`; };
const dateEn = t => { const d = new Date(t); return `${EN_DAY[d.getUTCDay()]}, ${EN_MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const whenTh = n => n === 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : `ในอีก ${n} วัน`;
const whenEn = n => n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;

const MSG = {
  th: {
    welcome: "ขอบคุณที่เพิ่ม SUBBU เป็นเพื่อน\nเปิดแอป SUBBU → บัญชี → แจ้งเตือนทาง LINE → สร้างรหัส แล้วส่งรหัส 6 หลักมาในแชตนี้เพื่อเชื่อมต่อ",
    help: "ส่งรหัส 6 หลักจากแอป SUBBU (บัญชี → แจ้งเตือนทาง LINE) เพื่อเชื่อมต่อ",
    badCode: "รหัสไม่ถูกต้องหรือหมดอายุแล้ว สร้างรหัสใหม่ในแอป SUBBU แล้วส่งมาอีกครั้ง",
    linked: "เชื่อมต่อ LINE กับ SUBBU แล้ว จะส่งข้อความเวลา 08:00 ในวันที่ถึงกำหนดเตือนของแต่ละรายการ",
    weekHead: "7 วันข้างหน้า:", weekNone: "ไม่มีรายการที่ต้องจ่ายใน 7 วันข้างหน้า",
    dailyHead: n => `SUBBU แจ้งเตือน ${n} รายการ`,
    chargeLine: (o, today) => {
      const s = o.s, n = Math.round((o.date - today) / DAY);
      const method = METHOD_TH[s.method] || s.method;
      return s.status === "trial"
        ? `${s.name} หมดทดลองใช้${whenTh(n)} (${dateTh(o.date)}) จะถูกตัดเงิน ${money(s.price, s.currency)} ถ้าไม่ยกเลิก`
        : `${s.name} ${money(s.price, s.currency)} ตัดเงิน${whenTh(n)} (${dateTh(o.date)})${method ? " ผ่าน " + method : ""}`;
    },
    open: url => `เปิด SUBBU: ${url}`
  },
  en: {
    welcome: "Thanks for adding SUBBU.\nIn the SUBBU app, open Account → LINE reminders → Get code, then send the 6-digit code in this chat to connect.",
    help: "Send the 6-digit code from the SUBBU app (Account → LINE reminders) to connect.",
    badCode: "That code is wrong or has expired. Get a new code in the SUBBU app and send it again.",
    linked: "LINE is connected to SUBBU. You'll get a message at 08:00 on each reminder day.",
    weekHead: "Next 7 days:", weekNone: "Nothing is due in the next 7 days.",
    dailyHead: n => `SUBBU: ${n} reminder${n === 1 ? "" : "s"}`,
    chargeLine: (o, today) => {
      const s = o.s, n = Math.round((o.date - today) / DAY);
      return s.status === "trial"
        ? `${s.name} trial ends ${whenEn(n)} (${dateEn(o.date)}). You'll be charged ${money(s.price, s.currency)} unless you cancel.`
        : `${s.name} charges ${money(s.price, s.currency)} ${whenEn(n)} (${dateEn(o.date)})${s.method ? " to " + s.method : ""}`;
    },
    open: url => `Open SUBBU: ${url}`
  }
};

/* ---------------- LINE API ---------------- */

async function reply(env, replyToken, text) {
  if (!replyToken) return;
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000) }] })
  });
  if (!res.ok) console.error("LINE reply failed", res.status, await res.text());
}
async function push(env, to, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5000) }] })
  });
  if (!res.ok) console.error("LINE push failed", res.status, await res.text());
  return res.ok;
}

/* ---------------- Firestore REST with a service account ---------------- */

async function firestore(env) {
  const token = await googleToken(env);
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) throw new Error(`Firestore ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const listAll = async path => {
    const docs = []; let pageToken = "";
    do {
      const page = await call("GET", `${path}?pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`);
      if (!page) break;
      (page.documents || []).forEach(d => docs.push({ id: d.name.split("/").pop(), data: decodeFields(d.fields || {}) }));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return docs;
  };
  return {
    get: async path => { const d = await call("GET", path); return d ? decodeFields(d.fields || {}) : null; },
    set: (path, data) => call("PATCH", path, { fields: encodeFields(data) }),
    delete: path => call("DELETE", path),
    list: async path => (await listAll(path)).map(d => d.data),
    listWithIds: listAll
  };
}

function decodeValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "string") return { stringValue: x };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(x) } };
}
function encodeFields(o) { const f = {}; for (const k in o) f[k] = encodeValue(o[k]); return f; }

// OAuth access token for the service account (JWT bearer grant, RS256 signed with WebCrypto).
async function googleToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const b64url = s => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Google token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}
