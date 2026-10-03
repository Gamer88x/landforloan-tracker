// Land for Loan → Telegram tracker
// usage: node tracker.mjs morning   (สรุปทรัพย์ที่เปิดอยู่ทั้งหมด ทุกเช้า)
//        node tracker.mjs watch     (เช็คทรัพย์ใหม่ / ทรัพย์ปิดดีล)
// env:   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN=1 (พิมพ์ออกจอแทนการส่ง)

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://landforloan.co.th/wp-json/wp/v2';
const UA = { 'user-agent': 'Mozilla/5.0 (LandForLoan-Telegram-Tracker)' };
const STATE_FILE = new URL('./state.json', import.meta.url);
const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID } = process.env;
const DRY_RUN = process.env.DRY_RUN === '1' || !TOKEN;
const MODE = process.argv[2] || 'watch';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

async function getJSON(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return { data: await r.json(), headers: r.headers };
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

const FIELDS = '_fields=id,date,link,title,acf,featured_media';

async function fetchAllListings() {
  const first = await getJSON(`${API}/listing?per_page=100&page=1&${FIELDS}`);
  const pages = Number(first.headers.get('x-wp-totalpages') || 1);
  let all = first.data;
  for (let p = 2; p <= pages; p++) all = all.concat((await getJSON(`${API}/listing?per_page=100&page=${p}&${FIELDS}`)).data);
  return all;
}

async function fetchByIds(ids) {
  let out = [];
  for (let i = 0; i < ids.length; i += 100)
    out = out.concat((await getJSON(`${API}/listing?per_page=100&include=${ids.slice(i, i + 100).join(',')}&${FIELDS}`)).data);
  return out;
}

async function fetchModifiedSince(isoLocal) {
  let out = [];
  for (let p = 1; ; p++) {
    const { data, headers } = await getJSON(`${API}/listing?per_page=100&page=${p}&orderby=modified&modified_after=${encodeURIComponent(isoLocal)}&${FIELDS}`);
    out = out.concat(data);
    if (p >= Number(headers.get('x-wp-totalpages') || 1)) return out;
  }
}

async function attachCovers(listings) {
  const ids = [...new Set(listings.map((x) => x.featured_media).filter(Boolean))];
  const map = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await getJSON(`${API}/media?per_page=100&include=${ids.slice(i, i + 100).join(',')}&_fields=id,source_url`);
    for (const m of data) map[m.id] = m.source_url;
  }
  for (const x of listings) x.cover = map[x.featured_media] || '';
  return listings;
}

// แปลงข้อมูลจาก API ให้อยู่ในรูปที่ใช้งาน
function normalize(x) {
  const a = x.acf || {};
  const code = clean(a['listing-id']);
  const type = code.includes('จำนอง') ? 'จำนอง' : code.includes('ขายฝาก') ? 'ขายฝาก' : '';
  const amount = clean(a['listing-limit']) || clean(a['listing-mortgage']);
  const coverFile = decodeURIComponent((x.cover || '').split('/').pop());
  // ทรัพย์ที่ปิดดีลแล้ว เว็บจะเปลี่ยนรูปปกเป็นรูป "MATCH" และ/หรือลบวงเงินออก
  const matched = /m\W?a?\W?tch/i.test(coverFile);
  return {
    id: x.id,
    date: x.date,
    link: x.link,
    cover: x.cover,
    code: code.replace(/\s*:\s*/, ' : '),
    type,
    propertyType: clean(x.title?.rendered).replace(/&#8211;/g, '-'),
    location: clean(a.location),
    area: clean(a.area),
    value: clean(a['listing-value']),
    amount,
    open: Boolean(type && amount && !matched),
  };
}

// ขายฝากก่อนจำนองเสมอ แล้วเรียงใหม่→เก่า
const sortListings = (arr) =>
  arr.sort((a, b) => (a.type === b.type ? b.date.localeCompare(a.date) : a.type === 'ขายฝาก' ? -1 : 1));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function caption(l, heading) {
  return [
    `<b>${esc(heading)}</b>`,
    '',
    `• ประเภททรัพย์ ${esc(l.propertyType)}`,
    `• ${esc(l.location)}`,
    `• พื้นที่ ${esc(l.area)}`,
    `• มูลค่าทรัพย์ ${esc(l.value)}`,
    '',
    l.amount ? `• วงเงิน${l.type} ${esc(l.amount)}` : null,
    `<a href="${l.link}">ดูรายละเอียด</a>`,
  ].filter((s) => s !== null).join('\n');
}

async function tg(method, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body });
    const j = await r.json();
    if (j.ok) return j;
    if (j.parameters?.retry_after) { await sleep((j.parameters.retry_after + 1) * 1000); continue; }
    throw new Error(`${method}: ${j.description}`);
  }
}

async function sendText(text) {
  if (DRY_RUN) return console.log(`\n[TEXT]\n${text}`);
  const f = new FormData();
  f.set('chat_id', CHAT_ID); f.set('text', text); f.set('parse_mode', 'HTML'); f.set('disable_web_page_preview', 'true');
  await tg('sendMessage', f);
  await sleep(3500); // กลุ่ม Telegram ส่งได้ ~20 ข้อความ/นาที
}

async function sendListing(l, heading) {
  const text = caption(l, heading);
  if (DRY_RUN) return console.log(`\n[PHOTO] ${l.cover}\n${text}`);
  try {
    // ดาวน์โหลดรูปแล้วอัปโหลดเอง (รองรับ .webp ได้ดีกว่าส่ง URL)
    const img = await fetch(l.cover, { headers: UA });
    if (!img.ok) throw new Error(`cover ${img.status}`);
    const f = new FormData();
    f.set('chat_id', CHAT_ID); f.set('caption', text); f.set('parse_mode', 'HTML');
    f.set('photo', new Blob([await img.arrayBuffer()]), l.cover.split('/').pop() || 'cover.jpg');
    await tg('sendPhoto', f);
    await sleep(3500);
  } catch (e) {
    console.error(`ส่งรูปไม่สำเร็จ (${l.code}): ${e.message} → ส่งเป็นข้อความแทน`);
    await sendText(text);
  }
}

const loadState = async () => {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
};
const saveState = (s) => writeFile(STATE_FILE, JSON.stringify(s, null, 1) + '\n');

const thaiDate = (d = new Date()) =>
  d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
// เวลาไทย แบบ ISO ไม่มี timezone (WordPress ใช้เวลาท้องถิ่นของเว็บ)
const bkkIso = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 19);

async function morning(state) {
  const all = (await attachCovers(await fetchAllListings())).map(normalize);
  const open = sortListings(all.filter((l) => l.open));
  const n = (t) => open.filter((l) => l.type === t).length;
  await sendText(
    `🌅 <b>อัปเดตทรัพย์ Land for Loan</b>\n${thaiDate()}\n\nทรัพย์ที่เปิดรับนักลงทุน ${open.length} ทรัพย์\n• ขายฝาก ${n('ขายฝาก')} ทรัพย์\n• จำนอง ${n('จำนอง')} ทรัพย์`
  );
  for (const [i, l] of open.entries()) await sendListing(l, `รหัสทรัพย์ที่ ${i + 1} ${l.code}`);
  return { open: Object.fromEntries(open.map((l) => [l.id, l.code])), known: all.map((l) => l.id) };
}

async function watch(state) {
  const since = new Date(Date.parse(state.lastRun) - 6 * 3600e3); // เผื่อเวลาซ้อนทับ กันหลุด
  const changed = await fetchModifiedSince(bkkIso(since));
  // ตรวจทรัพย์ที่เคยเปิดอยู่ด้วย เผื่อถูกลบ/ซ่อนจากเว็บ
  const openIds = Object.keys(state.open).map(Number);
  const stillThere = await fetchByIds(openIds);
  const byId = new Map([...stillThere, ...changed].map((x) => [x.id, x]));
  const current = (await attachCovers([...byId.values()])).map(normalize);

  const known = new Set(state.known);
  const open = { ...state.open };
  const fresh = sortListings(current.filter((l) => l.open && !(l.id in open)));
  const closed = [];
  for (const id of openIds) {
    const l = current.find((c) => c.id === id);
    if (!l || !l.open) closed.push(l || { id, code: state.open[id], missing: true });
  }

  for (const l of fresh) {
    await sendListing(l, `${known.has(l.id) ? '🔄 ทรัพย์กลับมาเปิดรับ' : '🆕 ทรัพย์ใหม่'}\nรหัสทรัพย์ ${l.code}`);
    open[l.id] = l.code;
  }
  for (const l of closed) {
    if (l.missing) await sendText(`✅ <b>ปิดดีลแล้ว / นำออกจากเว็บ</b>\nรหัสทรัพย์ ${esc(l.code)}`);
    else await sendListing(l, `✅ ปิดดีลแล้ว (MATCH)\nรหัสทรัพย์ ${l.code}`);
    delete open[l.id];
  }
  for (const l of current) known.add(l.id);
  console.log(`ทรัพย์ใหม่ ${fresh.length}, ปิดดีล ${closed.length}, เปิดอยู่ ${Object.keys(open).length}`);
  return { open, known: [...known] };
}

const state = await loadState();
let next;
if (!state) {
  // รันครั้งแรก: จำทรัพย์ปัจจุบันไว้ก่อน ไม่ส่งแจ้งเตือนย้อนหลัง (ยกเว้นสั่ง morning)
  if (MODE === 'morning') next = await morning();
  else {
    const all = (await attachCovers(await fetchAllListings())).map(normalize);
    next = { open: Object.fromEntries(all.filter((l) => l.open).map((l) => [l.id, l.code])), known: all.map((l) => l.id) };
    console.log(`เริ่มต้นระบบ: จำทรัพย์ที่เปิดอยู่ ${Object.keys(next.open).length} ทรัพย์`);
  }
} else {
  // ตอนเช้าเช็คความเปลี่ยนแปลงข้ามคืนก่อน แล้วค่อยส่งสรุปทั้งหมด
  next = await watch(state);
  if (MODE === 'morning') next = await morning();
}
if (!DRY_RUN || process.env.SAVE_STATE === '1') await saveState({ lastRun: new Date().toISOString(), ...next });
