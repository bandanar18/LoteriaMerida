#!/usr/bin/env node
/**
 * Enciende todo FortunaBet (DEMO) con un solo comando: `npm run dev`.
 *
 *   1. Base de datos (Docker) y espera a que esté lista.
 *   2. Compila el dominio, aplica migraciones, carga los datos iniciales (idempotente) y genera los resultados
 *      de muestra de los últimos 3 días (la base de datos no está en el repositorio).
 *   3. API (http://localhost:3000) y web (http://localhost:5173) juntas, con su salida en esta terminal.
 *
 * Ctrl+C apaga la API y la web. La base de datos queda encendida (`npm run db:down` para apagarla).
 * Opciones: --sin-seed (no recarga datos iniciales ni historial), --sin-historial (no genera resultados de muestra),
 *           --sin-db (no toca Docker).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';
const color = { api: '\x1b[36m', web: '\x1b[35m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
const say = (msg, c = 'ok') => console.log(`${color[c]}▶ ${msg}${color.off}`);

function run(label, cmd, cmdArgs) {
  say(label);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    say(`Falló: ${label}`, 'err');
    process.exit(r.status ?? 1);
  }
}

/** ¿Hay algo escuchando en el puerto? Se prueba IPv4 e IPv6: en Windows Vite escucha solo en ::1. */
function portBusy(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const s = createConnection({ port, host });
      s.setTimeout(1500, () => (s.destroy(), resolve(false)));
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

// 0) Configuración.
if (!existsSync(join(root, 'apps/api/.env'))) {
  say('Falta apps/api/.env. Cópialo desde apps/api/.env.example y ajusta las claves antes de seguir.', 'err');
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules'))) run('Instalando dependencias (primera vez)…', 'npm', ['install']);

for (const [port, name] of [
  [3000, 'API'],
  [5173, 'web'],
]) {
  if (await portBusy(port)) {
    say(`El puerto ${port} (${name}) ya está en uso: probablemente el sistema ya está encendido en otra terminal.`, 'err');
    process.exit(1);
  }
}

// 1) Base de datos.
if (!args.has('--sin-db')) {
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore', shell: isWin });
  if (docker.status !== 0) {
    say('Docker no responde. Abre Docker Desktop y vuelve a intentar.', 'err');
    process.exit(1);
  }
  run('Encendiendo la base de datos y esperando a que esté lista…', 'docker', ['compose', 'up', '-d', '--wait']);
}

// 2) Dominio, migraciones y datos iniciales.
run('Compilando reglas del dominio y aplicando migraciones…', 'npm', ['run', 'migrate']);
if (!args.has('--sin-seed')) run('Cargando datos iniciales (juegos, usuarios de prueba; no duplica)…', 'npm', ['run', 'seed']);
// La base de datos no viaja en el repositorio: cada instalación genera su propio historial de muestra
// (hoy y los 2 días anteriores, de 8 a. m. a 8 p. m. cada hora) con el RNG provably fair. Solo llena lo que falta.
if (!args.has('--sin-seed') && !args.has('--sin-historial')) {
  say('Generando resultados de muestra (últimos 3 días, 8 a. m. – 8 p. m.; solo lo que falta)…');
  const r = spawnSync('npm', ['run', 'simulate:history', '-w', '@loteria/api', '--silent', '--', '2', '--desde', '8', '--hasta', '20'], {
    cwd: root, stdio: 'inherit', shell: isWin,
  });
  if (r.status !== 0) say('No se pudo generar el historial de muestra; el sistema arranca igual.', 'warn');
}

// 3) API y web.
const children = [];
function start(name, workspace) {
  const p = spawn('npm', ['run', 'dev', '-w', workspace, '--silent'], { cwd: root, shell: isWin, env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `${color[name]}[${name}]${color.off} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    if (!stopping) {
      say(`${name} se detuvo (código ${code}). Apagando todo…`, 'err');
      stop(code ?? 1);
    }
  });
  children.push(p);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) {
    if (p.exitCode !== null) continue;
    // En Windows hay que matar el árbol de procesos (npm → nest/vite → node).
    if (isWin) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => (say('Apagando API y web… (la base de datos sigue encendida: npm run db:down)', 'warn'), stop(0)));
process.on('SIGTERM', () => stop(0));

say('Arrancando API y web…');
start('api', '@loteria/api');
start('web', '@loteria/web');

// Avisa cuando las dos respondan.
const t0 = Date.now();
const ready = setInterval(async () => {
  if ((await portBusy(3000)) && (await portBusy(5173))) {
    clearInterval(ready);
    console.log(
      `\n${color.ok}✔ FortunaBet (DEMO) encendido en ${Math.round((Date.now() - t0) / 1000)} s${color.off}\n` +
        `  Web:  http://localhost:5173\n  API:  http://localhost:3000/api/v1\n` +
        `${color.dim}  Ctrl+C para apagar. Aplicación DEMO: sin valor real, prohibida su comercialización.${color.off}\n`,
    );
  } else if (Date.now() - t0 > 180_000) {
    clearInterval(ready);
    say('La API o la web tardan más de 3 minutos en arrancar; revisa los mensajes de arriba.', 'warn');
  }
}, 2000);
