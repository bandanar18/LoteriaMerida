# FortunaBet — MVP (Fase 0 + 1)

> ⚠️ **APLICACIÓN DEMO.** Los saldos, bonos, apuestas, premios y operaciones no tienen valor real; no se aceptan ni se pagan montos reales y no está autorizada por ningún ente regulador. **Se prohíbe su comercialización, reventa o uso con fines comerciales.**

Primer MVP de la plataforma descrita en el *Documento Maestro*: núcleo financiero (ledger de doble partida, auditoría, RNG) y el primer producto, **Animalitos**, con web de jugador y backoffice.

> Solo para desarrollo/demostración con dinero ficticio. Operar con dinero real requiere licencia (CNC / CONALOT-IOBPAS) y asesoría legal (Doc. Maestro §2).

## Qué incluye

| Área | Implementado |
|---|---|
| Identidad | Registro (cédula V/E/pasaporte, ≥18 años, teléfono VE), login, Argon2id, JWT corto + refresh rotativo en cookie httpOnly, roles (PLAYER, ADMIN, CASHIER, LOTTERY_OPERATOR, AUDITOR), rate limiting |
| Ledger | Doble partida en `BIGINT`, Σ D = Σ C verificado por trigger diferido, asientos inmutables, idempotencia por clave, bloqueo `FOR UPDATE` ordenado, saldo de jugador nunca negativo (`CHECK`), reconciliación |
| Auditoría | Log append-only con hash SHA-256 encadenado y verificación de la cadena |
| RNG | CSPRNG del SO, muestreo por rechazo, **provably fair**: hash de la semilla publicado antes de la venta, semilla revelada tras el resultado, verificación pública |
| Animalitos | 38 animales (dato configurable), pago 30×, calendario por juego, sorteos extraordinarios, cierre X min antes con reloj del servidor, tickets multi-jugada y multi-sorteo, **cupo por animal y sorteo**, límites por jugada/ticket y moneda, anulación en ventana de 5 min, liquidación automática, anulación de sorteo con reembolso |
| Resultados | `INTERNAL_RNG` (automático) y `MANUAL` con **4 ojos** (uno propone con evidencia, otro confirma) |
| Pagos | Depósitos Pago Móvil / transferencia / USDT con conciliación manual (referencia única), retiros con fondos bloqueados (`PLAYER_LOCKED`) y pago/rechazo por cajero |
| Juego responsable | Autoexclusión 24 h – 1 año (bloquea apostar y depositar) |
| Backoffice | Dashboard (ventas, premios, GGR, pendientes, integridad), sorteos con exposición por animal, pagos, jugadores (bloqueo), auditoría |
| Monedas | VES y USDT (D6) |

**Fuera de este MVP** (siguientes fases): KYC con documentos/selfie, AML, integración bancaria automática, POS de taquillas, WebSockets (hoy hay polling), outbox/BullMQ/Redis, reventa de sorteos oficiales (`OFFICIAL_FEED`), sportsbook y casino.

## Estructura

```
packages/domain   Reglas puras y deterministas (dinero, animalitos, provably fair, identidad) + tests
apps/api          NestJS: identity, wallet/ledger, audit, rng, lottery, payments, admin
apps/api/migrations  SQL (esquemas identity, wallet, lottery, payments, audit, rng)
apps/web          React + Vite + Tailwind: sitio del jugador (/) y backoffice (/admin)
scripts/smoke.mjs Prueba end-to-end del API
```

## Puesta en marcha

Requisitos: Node 22+, Docker Desktop (abierto).

### Un solo comando

```bash
npm run dev
```

Enciende la base de datos (Docker), aplica migraciones, carga los datos iniciales (no duplica) y arranca la API (http://localhost:3000) y la web (http://localhost:5173) en la misma terminal. **Ctrl+C** apaga la API y la web; la base de datos sigue encendida (`npm run db:down` para apagarla). La primera vez instala las dependencias si faltan; necesita `apps/api/.env` (cópialo de `apps/api/.env.example`). Opciones: `npm run dev -- --sin-seed` (no recarga datos iniciales).

### Paso a paso

```bash
npm install
```

```bash
docker compose up -d
```

```bash
copy apps\api\.env.example apps\api\.env
```

```bash
npm run migrate
```

```bash
npm run seed
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Abrir http://localhost:5173. Las cuentas de prueba (jugador con saldo inicial, admin y supervisor de sorteos) están en `apps/api/.env` (`SEED_*`). Para el flujo de 4 ojos: el admin propone el resultado de un sorteo de **La Sabana** y el supervisor lo confirma.

Para probar un sorteo completo sin esperar al horario: en Backoffice → Sorteos → **+ Sorteo extraordinario** (mín. 6 min).

## Pruebas

```bash
npm test
```

```bash
node scripts/smoke.mjs
```

```bash
node scripts/smoke.mjs --wait
```

`npm test` corre las reglas de dominio (RTP 30/38 ≈ 78,95 %, chi-cuadrado del RNG, límites, cupos, edad). `smoke.mjs` ejercita el API real (idempotencia concurrente, cupos, anulación, pagos, permisos, ledger y auditoría); con `--wait` además espera un sorteo RNG y uno manual y verifica la liquidación.

```bash
node scripts/smoke-agencias.mjs
```

`smoke-agencias.mjs` prueba el Programa de Agencias Virtuales (código de afiliado, referidos, comisión del 3 %, reversos, tasas y suspensión); con `--wait` además espera la liquidación de un sorteo y prueba la liberación y el paso a saldo de juego. Diseño: `WalletLoteria/DOCUMENTO_MAESTRO_WALLET.md`.

## Convenciones clave

- Dinero siempre en unidades mínimas (`BIGINT` / `bigint`), viaja como string en JSON. Nunca `float`.
- Todo movimiento de dinero pasa por `LedgerService.post` dentro de una transacción.
- El servidor decide todo resultado; el cliente solo muestra. Ningún `Math.random()`.
- Fechas en UTC en BD; se muestran en America/Caracas.
- Convención de saldo: `balance = Σ créditos − Σ débitos` en todas las cuentas; `PAYMENT_CLEARING` (activo) se ve negativo.
