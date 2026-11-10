/**
 * Utilidades para grabar los videos de demostración de FortunaBet (DEMO):
 * voz (Windows, español), subtítulos y cursor dentro de la página, grabación con Playwright y montaje con ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright-core';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
export const BASE = process.env.FORTUNABET_URL ?? 'http://localhost:5173';
export const API = process.env.FORTUNABET_API ?? 'http://localhost:3000/api/v1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Variables de apps/api/.env (credenciales de prueba; nunca se imprimen). */
export const env = Object.fromEntries(
  readFileSync(join(root, 'apps/api/.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);

export async function api(method, path, token, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}

export async function login(email, password) {
  const r = await api('POST', '/auth/login', null, { email, password });
  if (!r.j?.accessToken) throw new Error(`No se pudo entrar como ${email}`);
  return r.j.accessToken;
}

// ───────────── Voz ─────────────

function wavDurationMs(file) {
  const b = readFileSync(file);
  const byteRate = b.readUInt32LE(28);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return Math.round((size / byteRate) * 1000);
    off += 8 + size;
  }
  throw new Error(`WAV sin datos: ${file}`);
}

/** Genera la narración de cada escena (WAV) y devuelve su duración. */
export function synthesize(scenes, dir) {
  mkdirSync(dir, { recursive: true });
  scenes.forEach((s, i) => {
    const txt = join(dir, `s${String(i).padStart(2, '0')}.txt`);
    const wav = join(dir, `s${String(i).padStart(2, '0')}.wav`);
    writeFileSync(txt, s.say, 'utf8');
    if (!existsSync(wav)) {
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'tts.ps1'), '-TextFile', txt, '-OutFile', wav, '-Rate', '1']);
    }
    s.wav = wav;
    s.ms = wavDurationMs(wav);
  });
  return scenes;
}

// ───────────── Subtítulos y cursor dentro de la página ─────────────

const OVERLAY = (mobile) => `
(() => {
  const css = \`
    #__cap { position: fixed; left: 50%; transform: translateX(-50%); bottom: ${mobile ? 6 : 28}px; z-index: 2147483647;
      max-width: ${mobile ? 92 : 78}vw; padding: ${mobile ? '10px 14px' : '12px 22px'}; border-radius: 14px;
      background: rgba(10, 14, 20, .86); color: #fff; font: 600 ${mobile ? 15 : 21}px/1.35 Inter, system-ui, sans-serif;
      text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: none; transition: opacity .25s; }
    #__cap:empty { opacity: 0; }
    #__demo { position: fixed; top: ${mobile ? '100px' : '10px'}; right: ${mobile ? 8 : 12}px; z-index: 2147483646;
      background: #fbbf24; color: #451a03; font: 800 ${mobile ? 10 : 12}px Inter, system-ui, sans-serif; padding: 4px 9px;
      border-radius: 999px; letter-spacing: .04em; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    #__cur { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: rgba(250, 204, 21, .55); border: 2px solid #f59e0b; pointer-events: none; transition: transform .15s; display: none; }
    #__cur.down { transform: scale(.7); background: rgba(245, 158, 11, .85); }
  \`;
  const mount = () => {
    if (!document.body || document.getElementById('__cap')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement('div'); cap.id = '__cap'; try { cap.textContent = sessionStorage.getItem('__cap') || ''; } catch {}
    const demo = document.createElement('div'); demo.id = '__demo'; demo.textContent = 'DEMO · SIN VALOR REAL';
    const cur = document.createElement('div'); cur.id = '__cur';
    document.body.append(cap, demo, cur);
    addEventListener('mousemove', (e) => { cur.style.display = 'block'; cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => cur.classList.add('down'), true);
    addEventListener('mouseup', () => cur.classList.remove('down'), true);
  };
  window.__setCap = (t) => { try { sessionStorage.setItem('__cap', t); } catch {} mount(); const c = document.getElementById('__cap'); if (c) c.textContent = t; };
  const watch = () => new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mount(); watch(); }); else { mount(); if (document.documentElement) watch(); }
})();`;

export async function caption(page, text) {
  await page.evaluate((t) => window.__setCap?.(t), text).catch(() => {});
}

// ───────────── Acciones visibles ─────────────

/** Mueve el cursor visible hasta el elemento y lo toca. Si no existe, sigue (el video no se corta). */
export async function tap(page, locator, label = '') {
  try {
    const el = locator.first();
    await el.scrollIntoViewIfNeeded({ timeout: 4000 });
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
      await sleep(250);
    }
    await el.click({ timeout: 4000 });
    await sleep(450);
    return true;
  } catch (e) {
    console.warn(`  (no se pudo tocar ${label || locator}: ${e.message.split('\n')[0]})`);
    return false;
  }
}

export async function type(page, locator, text, label = '') {
  try {
    const el = locator.first();
    await tap(page, el, label);
    await el.fill('');
    await el.pressSequentially(text, { delay: 70 });
    await sleep(300);
  } catch (e) {
    console.warn(`  (no se pudo escribir en ${label}: ${e.message.split('\n')[0]})`);
  }
}

export async function scroll(page, px, ms = 900) {
  await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), px);
  await sleep(ms);
}

export async function scrollTop(page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
}

export async function go(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
  await sleep(700);
}

// ───────────── Grabación y montaje ─────────────

/**
 * Graba las escenas: cada una muestra su subtítulo, ejecuta sus acciones y dura al menos lo que su narración.
 * Devuelve la ruta del video MP4 final con voz.
 */
export async function record({ name, scenes, mobile, out }) {
  const work = join(here, '.work', name);
  rmSync(join(work, 'raw'), { recursive: true, force: true });
  synthesize(scenes, join(work, 'audio'));
  const total = scenes.reduce((a, s) => a + s.ms, 0);
  console.log(`▶ ${name}: ${scenes.length} escenas, ${Math.round(total / 1000)} s de narración`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const size = mobile ? { width: 390, height: 844 } : { width: 1440, height: 810 };
  const px = mobile ? { width: 780, height: 1688 } : size;
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: !!mobile,
    hasTouch: !!mobile,
    locale: 'es-VE',
    timezoneId: 'America/Caracas',
  });
  await context.addInitScript(OVERLAY(!!mobile));
  const page = await context.newPage();

  // Captura de cuadros con el protocolo de Chrome (sin el ffmpeg propio de Playwright): cada cuadro con su hora.
  const framesDir = join(work, 'raw');
  mkdirSync(framesDir, { recursive: true });
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const file = join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: Date.now() });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await page.goto('about:blank');
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: px.width, maxHeight: px.height, everyNthFrame: 1 });
  const t0 = Date.now();
  const timeline = [];
  for (const [i, s] of scenes.entries()) {
    const start = Date.now() - t0;
    await caption(page, s.cap ?? s.say);
    console.log(`  ${String(i + 1).padStart(2)}. ${s.cap ?? s.say.slice(0, 70)}`);
    const action = (async () => {
      try {
        await s.run?.(page);
      } catch (e) {
        console.warn(`  (escena ${i + 1}: ${e.message.split('\n')[0]})`);
      }
    })();
    await Promise.all([action, sleep(s.ms + 700)]);
    await caption(page, s.cap ?? s.say); // por si la acción navegó
    timeline.push({ wav: s.wav, start, end: Date.now() - t0, text: s.cap ?? s.say });
  }
  await caption(page, '');
  await sleep(800);
  const tEnd = Date.now();
  await cdp.send('Page.stopScreencast').catch(() => {});
  await context.close();
  await browser.close();

  // Lista de cuadros con su duración real (la pantalla solo emite cuadros cuando cambia).
  const usable = frames.filter((f) => f.t >= t0);
  if (!usable.length) throw new Error('No se capturaron cuadros');
  const list = usable
    .map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${(((usable[i + 1]?.t ?? tEnd) - f.t) / 1000).toFixed(3)}`)
    .join('\n');
  const listFile = join(work, 'frames.txt');
  writeFileSync(listFile, `${list}\nfile '${usable.at(-1).file.replace(/\\/g, '/')}'\n`, 'utf8');
  const lead = usable[0].t - t0; // el video empieza con el primer cuadro
  mkdirSync(dirname(out), { recursive: true });

  // Audio: cada narración en su momento; luego video H.264 + AAC.
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
  timeline.forEach((t) => args.push('-i', t.wav));
  const filters = timeline.map((t, i) => {
    const d = Math.max(0, t.start - lead);
    return `[${i + 1}:a]adelay=${d}|${d}[a${i}]`;
  });
  filters.push(`${timeline.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timeline.length}:duration=longest:normalize=0[aud]`);
  args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aud]');
  args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-vsync', 'cfr', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '25');
  args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out);
  execFileSync(ffmpegPath, args, { stdio: 'ignore' });

  // Subtítulos aparte (.srt), por si se quieren activar en un reproductor.
  const ts = (ms) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  writeFileSync(out.replace(/\.mp4$/, '.srt'), timeline.map((t, i) => `${i + 1}\n${ts(t.start)} --> ${ts(t.end)}\n${t.text}\n`).join('\n'), 'utf8');
  console.log(`✔ ${out} (${Math.round((timeline.at(-1).end) / 1000)} s)`);
  return out;
}

export { renameSync };
