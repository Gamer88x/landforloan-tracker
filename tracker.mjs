// Land for Loan → Telegram tracker
// usage: node tracker.mjs morning   (สรุปทรัพย์ที่เปิดอยู่ทั้งหมด ทุกเช้า)
//        node tracker.mjs watch     (เช็คทรัพย์ใหม่ / ทรัพย์ปิดดีล)
// env:   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN=1 (พิมพ์ออกจอแทนการส่ง)

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

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

async function fetchByIds(ids) {
  let out = [];
  for (let i = 0; i < ids.length; i += 100)
    out = out.concat((await getJSON(`${API}/listing?per_page=100&include=${ids.slice(i, i + 100).join(',')}&${FIELDS}`)).data);
  return out;
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

// อ่านหน้าเว็บตามลำดับ ทรัพย์ว่าง = รูปปกไม่ใช่ MATCH และการ์ดยังแสดงวงเงินขายฝาก/จำนอง
// ทรัพย์ว่างอยู่ช่วงหน้าแรกๆ จึงหยุดเมื่อเจอหน้าแรกที่ไม่มีทรัพย์ว่างเลย
async function fetchOpenIdsFromSite() {
  const ids = [];
  for (let p = 1; p <= 20; p++) {
    const r = await fetch(`https://landforloan.co.th/assets-new/${p > 1 ? p + '/' : ''}`, { headers: UA });
    if (!r.ok) throw new Error(`assets-new page ${p}: ${r.status}`);
    const cards = (await r.text()).split('<article id="post-').slice(1);
    if (!cards.length) {
      if (p === 1) throw new Error('อ่านหน้าเว็บไม่ได้ — ข้ามรอบนี้');
      break;
    }
    let found = 0;
    for (const c of cards) {
      const img = (c.match(/data-src="([^"]+)"/) || c.match(/src="(https[^"]+)"/) || [])[1] || '';
      const matched = /m\W?a?\W?tch/i.test(decodeURIComponent(img.split('/').pop()));
      const hasAmount = /วงเงิน(ขายฝาก|จำนอง)\s*[\d,]+/.test(c);
      if (!matched && hasAmount) { ids.push(Number(c.match(/^\d+/)[0])); found++; }
    }
    if (!found) break;
  }
  return ids;
}

async function loadOpenListings() {
  const ids = await fetchOpenIdsFromSite();
  if (!ids.length) return [];
  return (await attachCovers(await fetchByIds(ids))).map(normalize);
}

async function morning(open) {
  open = sortListings(open ?? (await loadOpenListings()));
  const n = (t) => open.filter((l) => l.type === t).length;
  await sendText(
    `🌅 <b>อัปเดตทรัพย์ Land for Loan</b>\n${thaiDate()}\n\nทรัพย์ว่าง เปิดรับนักลงทุน ${open.length} ทรัพย์\n• ขายฝาก ${n('ขายฝาก')} ทรัพย์\n• จำนอง ${n('จำนอง')} ทรัพย์`
  );
  for (const [i, l] of open.entries()) await sendListing(l, `รหัสทรัพย์ที่ ${i + 1} ${l.code}`);
}

async function watch(state, current) {
  const nowIds = new Set(current.map((l) => l.id));
  const known = new Set(state.known);
  const fresh = sortListings(current.filter((l) => !(l.id in state.open)));
  const goneIds = Object.keys(state.open).map(Number).filter((id) => !nowIds.has(id));
  const gone = goneIds.length ? (await attachCovers(await fetchByIds(goneIds))).map(normalize) : [];

  for (const l of fresh)
    await sendListing(l, `${known.has(l.id) ? '🔄 ทรัพย์กลับมาว่าง' : '🆕 ทรัพย์ใหม่'}\nรหัสทรัพย์ ${l.code}`);
  for (const id of goneIds) {
    const l = gone.find((g) => g.id === id);
    if (l) await sendListing(l, `✅ ปิดดีลแล้ว (MATCH)\nรหัสทรัพย์ ${l.code}`);
    else await sendText(`✅ <b>ปิดดีลแล้ว / นำออกจากเว็บ</b>\nรหัสทรัพย์ ${esc(state.open[id])}`);
  }
  console.log(`ทรัพย์ใหม่ ${fresh.length}, ปิดดีล ${goneIds.length}, ว่างอยู่ ${current.length}`);
}

const bkkDate = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const bkkHour = () => new Date(Date.now() + 7 * 3600e3).getUTCHours();

async function runOnce(mode) {
  const state = await loadState();
  const current = await loadOpenListings();
  if (!state || state.version !== 2) {
    // รันครั้งแรก: จำทรัพย์ปัจจุบันไว้ก่อน ไม่ส่งแจ้งเตือนย้อนหลัง
    console.log(`เริ่มต้นระบบ: จำทรัพย์ว่าง ${current.length} ทรัพย์`);
  } else {
    await watch(state, current);
  }
  let lastMorning = state?.lastMorning;
  // สรุปเช้า: สั่งเอง (morning) หรือในโหมด loop เมื่อถึง 07:00 และวันนี้ยังไม่ได้ส่ง
  if (mode === 'morning' || (mode === 'loop' && bkkHour() >= 7 && lastMorning !== bkkDate())) {
    await morning(current);
    lastMorning = bkkDate();
  }
  const known = new Set([...(state?.known ?? []), ...current.map((l) => l.id)]);
  const next = { version: 2, lastMorning, open: Object.fromEntries(current.map((l) => [l.id, l.code])), known: [...known] };
  if (!DRY_RUN || process.env.SAVE_STATE === '1') await saveState(next);
}

// บันทึก state.json กลับเข้า repo (เฉพาะตอนรันบน GitHub Actions)
function commitState() {
  if (!process.env.GITHUB_ACTIONS) return;
  const sh = (c) => execSync(c, { stdio: 'inherit' });
  sh('git add state.json');
  try { execSync('git diff --cached --quiet'); } catch { sh('git commit -m "update state" && git pull --rebase -q && git push'); }
}

if (MODE === 'loop') {
  // รันค้างไว้ เช็คทุก 5 นาที จนครบ ~5 ชม. 45 นาที (GitHub จำกัดงานละ 6 ชม.) แล้ว workflow จะเริ่มรอบใหม่ต่อเอง
  const end = Date.now() + (Number(process.env.LOOP_MINUTES) || 345) * 60e3;
  while (Date.now() < end) {
    const started = Date.now();
    try {
      await runOnce('loop');
      commitState();
    } catch (e) {
      console.error(`รอบนี้ผิดพลาด: ${e.message}`);
    }
    const wait = 5 * 60e3 - (Date.now() - started);
    if (Date.now() + wait >= end) break;
    if (wait > 0) await sleep(wait);
  }
} else {
  await runOnce(MODE);
}
