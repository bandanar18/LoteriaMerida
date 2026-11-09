# Animalitos de Mérida (MER-05) — Modelo para desarrollo

> Síntesis de: Manual reglamentario MER-05 v1.0 (29-10-2026, Drive), Ficha Única de Registro (FUR, infografía), infografía "Programa de Agencias Virtuales" y sitio base `sites.google.com/view/meridabets` (su contenido está en imágenes; no aporta texto adicional).
>
> **Estado de la fuente:** todo el material es *propuesta conceptual, no oficial*. Autorización, operadora, domicilio, tabla actuarial, catálogo y procedimiento de sorteo están **SIN ACREDITAR / PENDIENTES** (Manual, Anexo D). El sistema debe poder operar en modo **DEMO** hasta que existan.

Leyenda: **[F]** dato de la fuente · **[P]** propuesta de este documento para cerrar un vacío · **[⚠]** inconsistencia o riesgo detectado.

> **v2.0 (09-11-2026) — decisión de la operadora [P]:**
> - **Un solo juego:** Animalitos de Mérida. Tepuy y La Sabana se retiraron (sus sorteos pendientes se anularon con reembolso; el historial se conserva).
> - **70 animales (00–69):** los 37 de la v1.1 conservan su número y nombre; se agregan del 37 Delfín al 69 Mapache (`MERIDA_ANIMALS`).
> - **Animal exacto 50×:** RTP = 50/70 = **71,4 %**, margen de la casa **28,6 %**. Las jugadas vendidas antes conservan el factor con que se vendieron (25×).
> - **Hasta 70 jugadas por ticket** (antes 50), para poder jugar el tablero completo.
> - Cada sorteo guarda en `rng.rng_call.range_n` cuántos animales había, así los sorteos de 37 siguen verificándose con 37. La frecuencia, la prueba χ² y la terna del backoffice solo cuentan sorteos con 70.
> - Migración `008_merida_70.sql`. Lo que sigue en este documento describe la v1.1 salvo donde dice v2.0.

---

## 1. Identificación

| Campo | Valor |
|---|---|
| Nombre | Animalitos de Mérida [F] |
| Código | `MER-05` [F] |
| Tipo | Lotería de animalitos, sorteo de un resultado [F] |
| Universo | **v2.0: 00–69 → 70 códigos** [P] (fuente: 00–36, 37 códigos; no existe el `0`) [F] |
| Modalidades | Animal exacto, Combinada, Múltiple [F] |
| Operador | Propuesta: Lotería del Estado Mérida (SuerteAndes Marketplace) — **sin acreditar** [F] |
| Licencia / reglamento | POR VALIDAR / prototipo [F] |
| Zona horaria | America/Caracas (BD en UTC) [F] |
| Edad mínima | 18 años, con verificación [F] |
| Versión de reglas | `MER-05 v1.0-borrador` — debe guardarse en cada ticket [F, cláusula 7ª] |

## 2. Catálogo de animales

**[F]** Solo 5 asociaciones aparecen en la FUR:

| N.º | Animal |
|---|---|
| 00 | Oso Frontino |
| 07 | Venado |
| 17 | Colibrí |
| 24 | Cunaguaro |
| 36 | Cóndor |

**[⚠]** El manual (Anexo B.1) advierte que la FUR tiene dibujos, nombres y códigos inconsistentes. En la infografía el oso aparece también en el 24 ("Cunaguaro", que es un felino) y en ejemplos combinados. **El catálogo debe ser único, auditado y aprobado antes de activar el juego.**

**[P]** Catálogo temático de trabajo (fauna andina y venezolana), editable desde el backoffice. Los marcados con ★ vienen de la fuente:

| N.º | Animal | N.º | Animal | N.º | Animal | N.º | Animal |
|---|---|---|---|---|---|---|---|
| 00 | Oso Frontino ★ | 10 | Jaguar | 20 | Cochino | 30 | Caimán |
| 01 | Paují | 11 | Gato | 21 | Gallo | 31 | Morrocoy |
| 02 | Toro | 12 | Caballo | 22 | Danta | 32 | Ardilla |
| 03 | Trucha | 13 | Mono Araña | 23 | Cachicamo | 33 | Guacamaya |
| 04 | Puma | 14 | Paloma | 24 | Cunaguaro ★ | 34 | Chigüire |
| 05 | Águila | 15 | Zorro | 25 | Gallina | 35 | Tucán |
| 06 | Rana | 16 | Lapa | 26 | Vaca | 36 | Cóndor ★ |
| 07 | Venado ★ | 17 | Colibrí ★ | 27 | Perro | | |
| 08 | Ratón | 18 | Burro | 28 | Zamuro | | |
| 09 | Gallito de las Rocas | 19 | Chivo | 29 | Búho | | |

Reglas del catálogo:
- Es versionado. Un catálogo publicado es inmutable: cambiarlo crea una versión nueva que solo aplica a sorteos futuros.
- El número es la clave. El nombre y la ilustración son presentación.
- Cada ticket referencia el `symbol_id`, que conserva número y nombre en ese momento.

## 3. Calendario de sorteos

**Decisión de la operadora (v1.1, 06-11-2026):** 12 sorteos diarios, uno por hora, de **09:00 a 20:00** (VET). Sustituye los 5 sorteos de la fuente (09, 12, 15, 18 y 21 h).

| Sorteo (VET) | Cierre de venta | Resultado preliminar | Resultado oficial |
|---|---|---|---|
| 09:00, 10:00, 11:00 … 20:00 (cada hora) | HH:55 de la hora anterior | ≈ HH:02 | ≈ HH:10, con acta validada |

Cada sorteo sortea **un animal al azar entre los 37** (1 en 37 para cada uno), con el procedimiento y el acta de §7. El resultado no depende de lo vendido: el margen y el riesgo se controlan con el factor de pago (§4) y los topes (§5).

- **[F]** La fuente pedía 5 sorteos diarios; se mantiene el cierre 5 minutos antes. Los tiempos de +2 y +10 minutos son metas, no obligaciones. Si falta el acta, el resultado queda **pendiente / incidencia**.
- **[P]** Los 7 días de la semana. Feriados y excepciones se manejan como sorteos `CANCELLED` o extraordinarios cargados desde el backoffice.
- **[P]** La venta abre al cierre del sorteo anterior; el sorteo de las 09:00 abre al cierre del de las 20:00 del día previo. Se puede jugar a sorteos futuros del mismo día.

## 4. Modalidades y premios

### 4.1 Lo que dice la fuente

| Modalidad | Selección | Factor bruto | Ejemplo (Bs. 10) |
|---|---|---|---|
| Animal exacto | 1 animal | 30× | Bs. 300 |
| Combinada | 2 a 4 animales | 50× | Bs. 500 |
| Múltiple | 5 o más animales | 20× | Bs. 200 |

**[F]** El manual (cláusulas 6ª y 18ª, Anexo B.2) dice que la condición de premio de Combinada y Múltiple **está "por formalizar"**. Toda modalidad con condición indefinida **no debe activarse**. Tampoco se ha definido si las varias selecciones se juegan en un mismo sorteo o en varios.

### 4.2 Análisis matemático [⚠]

Con un sorteo de 37 resultados equiprobables, la probabilidad de un animal es p = 1/37.

| Modalidad e interpretación | Probabilidad | Retorno al jugador (RTP) | Viable |
|---|---|---|---|
| Exacto 30× | 1/37 | **81,1 %** | ✅ Margen de la casa 18,9 % |
| Combinada "acierta cualquiera de k" en un sorteo, 50× sobre el total | k/37 | k=2: 270 %; k=4: 540 % | ❌ Quiebra a la operadora |
| Múltiple "acierta cualquiera de k≥5", 20× | k/37 | k=5: 270 % | ❌ Quiebra |
| Combinada "todos aciertan" en k sorteos consecutivos (k=2), 50× | 1/1369 | 3,7 % | ❌ Abusivo para el jugador |
| Combinada "todos aciertan" en k sorteos consecutivos (k=2), pago justo al 81 % | 1/1369 | 81 % con ≈ 1.110× | ✅ Pero con otro factor |

**Conclusión:** solo *Animal exacto 30×* es coherente tal como está escrito. Los factores 50× y 20× no cuadran con ninguna interpretación razonable. Esto confirma el Anexo B.3: hay que verificar retornos, probabilidad y exposición antes de aprobar.

### 4.3 Propuesta de implementación [P]

1. **v1.1:** solo **Animal exacto 25×** (la fuente decía 30×; ver §4.4). Un ticket puede llevar varias jugadas exactas, cada una con su propio monto, sobre uno o varios sorteos. Este es el modelo que ya existe en el MVP.
2. **Combinada y Múltiple:** se modelan como `modality` con `status = 'PENDING_APPROVAL'`. El API las rechaza (`MODALITY_NOT_ACTIVE`) hasta que el ente apruebe la condición y la tabla actuarial.
3. Dos alternativas para presentar a la operadora:
   - **A · Cobertura en un sorteo:** el jugador elige k animales y el monto se reparte entre ellos. Paga el factor del exacto sobre la porción del animal ganador. Es equivalente a k jugadas exactas, con el mismo RTP. Solo es una forma cómoda de jugar, no un premio nuevo.
   - **B · Combinada en secuencia:** k animales en k sorteos consecutivos, en orden, y deben acertar todos. El factor se calcula como `⌊0,81 × 37^k⌋` (k=2 → ~1.100×) y tiene un tope de exposición propio.
4. El factor se guarda por modalidad como entero ×100 (`2500` = 25×). El premio es `monto × factor / 100`, en BIGINT y en unidades mínimas.

### 4.4 Factor de pago y margen (v1.1)

La operadora fija el margen con el factor publicado, no con el resultado. Con 37 animales equiprobables:

| Factor | Premio por Bs. 10 | Retorno al jugador (RTP) | Margen de la casa |
|---|---|---|---|
| 30× (fuente) | Bs. 300 | 81,1 % | 18,9 % |
| 28× | Bs. 280 | 75,7 % | 24,3 % |
| 25× (v1.1) | Bs. 250 | 67,6 % | 32,4 % |

**v2.0 — con 70 animales:**

| Factor | Premio por Bs. 10 | Retorno al jugador (RTP) | Margen de la casa |
|---|---|---|---|
| 25× | Bs. 250 | 35,7 % | 64,3 % |
| 40× | Bs. 400 | 57,1 % | 42,9 % |
| 47× | Bs. 470 | 67,1 % | 32,9 % |
| **50× (vigente)** | **Bs. 500** | **71,4 %** | **28,6 %** |

Con el tope de pago de Bs. 600.000 por animal, a 50× se pueden apostar hasta Bs. 12.000 por animal y sorteo.

- El factor se muestra al jugador antes de apostar y queda congelado en cada jugada. Las jugadas vendidas a 30× antes del cambio se pagan a 30×.
- Más sorteos al día reparten las ventas y estabilizan el resultado diario alrededor del margen esperado.

## 5. Límites y valor de la apuesta

| Parámetro | Fuente | Propuesta MVP |
|---|---|---|
| Apuesta mínima | Bs. 5,00 (propuesta) [F] | Bs. 5,00 / 0,10 USDT |
| Apuesta máxima por jugada | Según normativa [F] | Bs. 2.000 / 50 USDT |
| Máximo por ticket | No definido | Bs. 10.000 / 250 USDT |
| Exposición máxima por animal y sorteo | Exigida, sin cifra (Anexo B.3) [F] | Bs. 600.000 / 15.000 USDT de premio posible. Al alcanzarla el animal aparece **«Agotado»** en ese sorteo y no se vende más |
| Máximo por jugador y sorteo | No definido | Bs. 5.000 / 125 USDT, sumando todos sus tickets abiertos en ese sorteo |
| Cancelación | Solo antes del cierre de ventas [F] | Hasta el cierre y como máximo 5 minutos después de comprar |
| Caducidad del premio | 3 días hábiles (propuesta) [F] | Configurable. En web el premio se acredita automáticamente, así que solo aplica a canje en punto de venta (POS) |

**[F]** Bs. 5 y Bs. 10 son montos de simulación: **todos los límites deben ser configurables**, no constantes en el código.

**Pérdida máxima por sorteo.** Como sale un solo animal, lo máximo que un sorteo puede pagar es el tope por animal (Bs. 600.000), menos lo vendido en ese sorteo. El backoffice muestra en cada sorteo:
- el «resultado neto si sale el peor animal» (vendido − mayor premio posible);
- una alerta cuando algún animal pasa el 80 % del tope (▲ Riesgo en la lista de sorteos y aviso en el panel).

Para arriesgar menos por sorteo se baja el tope por animal; el resultado no se toca.

## 6. Flujo del juego

1. El jugador entra a Animalitos de Mérida.
2. Elige uno o varios animales y la modalidad.
3. Elige uno o varios sorteos abiertos.
4. **El servidor valida:** sorteo abierto, modalidad activa, límites, KYC, saldo y exposición.
5. Registro y cobro atómicos en el ledger: `PLAYER_CASH → BETS_IN_PLAY`. Se emite el ticket.
6. Cierre automático a T−5 minutos. Después el sorteo se ejecuta con los equipos oficiales.
7. Se publica el **resultado preliminar** (`RESULT_PENDING`). Con el **acta validada** pasa a **oficial** (`RESULT_CONFIRMED`), con doble verificación.
8. Liquidación: los premios se acreditan a la billetera (`HOUSE_GGR → PLAYER_CASH`) y el ticket queda `WON` o `LOST`.

### Estados del sorteo

`SCHEDULED → OPEN → CLOSED → RESULT_PENDING (preliminar) → RESULT_CONFIRMED (oficial, con acta) → SETTLED`

Cualquier estado anterior a `RESULT_CONFIRMED` puede pasar a `CANCELLED`. Al cancelar se registra la causa, el responsable y la hora, y se reintegran las jugadas como `VOID`. También se publica un aviso (cláusula 23ª).

## 7. Resultado, acta y certificación

- **[F]** El resultado sale de "equipos y procedimientos oficiales". El generador aleatorio, los equipos, el ejecutor y el fiscal **no están acreditados**.
- **[P]** Fuente de resultado `MANUAL_ACTA` (o `OFFICIAL_FEED` cuando exista integración):
  - Un operador **propone** el resultado y adjunta el acta (número, archivo, ejecutor, fiscal).
  - Otro usuario **confirma**. Rige la regla de cuatro ojos.
  - El acta adjunta se guarda cifrada y cada consulta queda en la auditoría, igual que en KYC.
- Los campos que se publican son fecha, hora, juego, número y animal ganador, y el estado (`PRELIMINAR`, `OFICIAL` o `INCIDENCIA`).
- En entornos de desarrollo y demo se usa el generador interno con CSPRNG y compromiso publicado antes de la venta (*provably fair*). **Nunca** se usa en producción como sustituto del acta oficial.

## 8. Ticket / comprobante

Campos obligatorios [F, cláusulas 7ª y 16ª]:
- Juego y código: *Animalitos de Mérida · MER-05*.
- Versión de reglas.
- Fecha y hora de venta, en VET.
- Identificación de cada sorteo: fecha y hora.
- Por línea: modalidad, número y animal, monto, premio potencial.
- Serie / código del ticket y un identificador de seguridad (código de verificación).
- Canal (WEB o POS) y agencia, si aplica.
- En modo demo, el texto visible **«DEMO - NO CANJEABLE»** y un identificador con el formato `DEMO-MER-05-000001`.
- **No se inventan** datos fiscales, códigos de autorización ni datos de la operadora. Si no existen, el campo se muestra vacío o "pendiente".

## 9. Prohibiciones y controles

Prohibido por diseño [F, cláusulas 14ª y 15ª]:
- Apuestas de menores. Se exige 18+ y KYC.
- Ventas después del cierre, con hora validada en el servidor.
- Modificar tickets o resultados. Las tablas son inmutables y toda corrección es un movimiento nuevo.
- Que terceros sin facultades cobren el premio.

Pendiente de definir, con soporte previsto en el sistema:
- Autoexclusión y límites de juego responsable.
- Reclamaciones: plazo, instancia y documentos.
- Inventario de incidentes humanos, mecánicos, informáticos y de comunicaciones, con su registro de resolución (cláusula 25ª).
- Consentimiento para publicar ganadores. No se publica nada sin consentimiento (cláusula 19ª).

## 10. Mapeo con la arquitectura de la FUR (Odoo) → este proyecto

La FUR propone módulos de Odoo. Aquí se implementan en NestJS y Postgres:

| FUR / Odoo | Este proyecto |
|---|---|
| `lot.game` (configuración del juego y animalitos) | `lottery.game`, `lottery.symbol`, `lottery.schedule`, `lottery.game_limit` |
| `lot.draw` (sorteos y resultados) | `lottery.draw` |
| `lot.ticket` (registro de apuestas) | `lottery.ticket`, `lottery.play` |
| `lot.result` (validación y publicación) | `lottery.draw.proposed_*` / `confirmed_*`, más una tabla nueva `lottery.draw_record` (acta) |
| `lot.prize.payment` (pago de premios) | Liquidación con `wallet.ledger` (producto LOTTERY) |
| `account` (contabilidad de ventas, premios y contribuciones) | Ledger de doble entrada y reportes de GGR. Falta la cuenta de **contribución social** |
| Website / portal de usuario | `apps/web` |

## 11. Brechas frente al MVP (estado de implementación)

Migraciones `apps/api/migrations/004_merida.sql`, `005_merida_hourly.sql` (v1.1) y `006_simulation.sql` (simulador).

| # | Cambio | Estado | Detalle |
|---|---|---|---|
| 1 | Juego `MER-05` en el seed | ✅ Hecho | v1.1: factor 25×, cierre 5 min, 12 sorteos de 09:00 a 20:00, fuente manual con acta. Es el primer juego de la lista; TEPUY y SABANA quedan como demo. |
| 2 | Catálogo de 37 códigos (00–36) | ✅ Hecho | `MERIDA_ANIMALS` en `packages/domain`. Un trigger impide cambiar número o nombre de un animal que ya tiene jugadas. |
| 3 | Tabla `lottery.modality` | ✅ Hecho | Solo EXACTO está activo. COMBINADA y MULTIPLE se rechazan con `MODALITY_NOT_ACTIVE`. Cada jugada guarda `modality_id` y `factor_x100` congelados al vender, y la liquidación usa ese factor. |
| 4 | Versión de reglas en el ticket | ✅ Hecho | `ticket.rules_version` = `MER-05 v1.1-borrador`. |
| 5 | Acta del sorteo | ✅ Hecho | `lottery.draw_record` es inmutable. El archivo (PDF/JPG/PNG, máx. 5 MB) se guarda cifrado con AES-256-GCM y cada consulta se audita. `confirm-result` exige el acta (`RECORD_REQUIRED`). El público ve el resultado **preliminar** apenas se propone y el **oficial** cuando se confirma con acta. |
| 6 | Incidencias de sorteo | ✅ Hecho | `lottery.draw_incident`, con aviso público opcional que se muestra en Resultados. Anular un sorteo registra la incidencia automáticamente. |
| 7 | Modo demo | ✅ Hecho | `game.is_demo`: código `DEMO-MER05-…`, banner y marca de agua «DEMO - NO CANJEABLE» en el ticket. |
| 8 | Mínimo Bs. 5 | ✅ Hecho | `game_limit` de MER-05. |
| 9 | Caducidad configurable | ⏳ Campo listo | `game.prize_expiry_days = 3`. Se aplicará con el canje en POS (fase posterior); en web el premio se acredita al instante. |
| 10 | Contribución social | ⏳ Campo listo | `game.social_contribution_bps` queda NULL hasta que exista la cifra oficial. |
| 11 | Mobile-first | ✅ Hecho | Ver §14. |
| 12 | Topes y riesgo (v1.1) | ✅ Hecho | `game_limit.max_player_per_draw` (NULL = sin tope). `GET /lottery/draws/:id/availability` publica solo qué animales están agotados, no montos. Alerta de riesgo ≥ 80 % en el backoffice. |
| 13 | Simulador del jugador | ✅ Hecho | Migración `006_simulation.sql`, pantalla `/simulador`. Recarga de saldo de prueba (máx. Bs. 10.000 por recarga, por el ledger), sorteo privado por jugador que no aparece en listados públicos, backoffice ni reportes, y botón «Sortear» que lo resuelve al instante con el RNG provably fair (semilla comprometida al crearlo) y lo liquida igual que un sorteo real. Solo juegos demo y solo con `SIMULATION_MODE=true` (apagado por defecto en producción). |
| 14 | Historial simulado (desarrollo) | ✅ Hecho | `npm run simulate:history -w @loteria/api -- [días]` crea los sorteos faltantes de los últimos días y las horas ya pasadas de hoy, con resultado del RNG provably fair, sin jugadas y marcados «Historial simulado (desarrollo)». Sirve para ver el tablero de Resultados (hoy, ayer, otras fechas) con datos. No corre con `SIMULATION_MODE` apagado. |

Ya cubierto por el MVP:
- Ledger con BIGINT, idempotencia y exposición por animal.
- Cierre en el servidor y KYC 18+.
- Doble verificación del resultado.
- Tiempo real y auditoría.
- Cancelación dentro de la ventana permitida.

## 12. Fuera de alcance (por ahora)

- **Programa de Agencias Virtuales (Fortuna Bets):**
  - Funcionamiento: los referidos se registran con el código o QR de una agencia, y la agencia cobra comisión por cada jugada con retiro inmediato.
  - Qué preparar ya: `referral_code` en el jugador y `agency_id` en el ticket, para calcular comisiones después.
  - **[⚠]** La comisión debe ir al ledger, salir del margen y no del premio, y tener tope.
  - **[⚠]** El material de la agencia anuncia "Juegos Oficiales del Gobierno Bolivariano de Mérida", pero el manual dice que no hay autorización acreditada. Esa afirmación no debe aparecer en el producto hasta que exista.
- **Resto del portafolio:** Centena Andina, Dupleta de Montaña, Kino Teleférico, Andes 5 Estrellas, Triple Andino, casino, hipismo y juegos rápidos.

## 13. Preguntas abiertas para la operadora / ente

1. ¿Qué catálogo oficial de 37 animales se usará (número, nombre, ilustración)?
2. ¿Cuál es la condición exacta de premio de Combinada y Múltiple: un sorteo o varios, todos o cualquiera? ¿Con qué factores?
3. ¿Cuáles son los límites mínimo y máximo por jugada, por ticket, por jugador y por canal?
4. ¿Cuál es el tope de responsabilidad por animal y sorteo?
5. ¿Quién ejecuta el sorteo y quién fiscaliza? ¿Cuál es el formato del acta? ¿Habrá un feed oficial?
6. ¿Qué porcentaje de contribución social se aplica, sobre qué base y con qué régimen tributario?
7. ¿Cuál es la caducidad de premios, el procedimiento de reclamos y la jurisdicción?
8. ¿Cómo se manejan feriados, suspensión y reprogramación de sorteos?

## 14. Requisito: 100 % responsive, mobile-first

La mayoría de los jugadores entrará **desde el teléfono**. Por eso el diseño parte de una pantalla de **360–390 px** y se amplía hacia tablet y escritorio, no al revés.

### Reglas de diseño (obligatorias)

| Regla | Criterio |
|---|---|
| Sin scroll horizontal de la página | Nada se desborda a 360 px. Las filas largas (juegos, sorteos) se desplazan dentro de su propio carril. |
| Objetivos táctiles | Mínimo **44 × 44 px**. Las casillas de animales miden unos 76 px de alto en una rejilla de 4 columnas. |
| Acción al alcance del pulgar | En móvil, «Agregar jugadas» y «Ver ticket» van en una barra fija sobre la navegación inferior. El ticket se abre como hoja inferior. |
| Navegación | Barra inferior de 6 secciones en móvil y menú superior desde 768 px. |
| Áreas seguras | Se respeta `env(safe-area-inset-bottom)` en iPhone con muesca y Android con barra de gestos (`viewport-fit=cover`). |
| Campos de texto | 16 px en móvil, para que iOS no haga zoom al enfocar. `inputMode="decimal"` en los montos. |
| Montos rápidos | Botones de 5, 10, 20, 50 y 100 Bs (0,5 a 10 USDT) para no tener que escribir. |
| Modales | En móvil son hojas inferiores de altura `90dvh` con scroll propio; en escritorio, diálogos centrados. |
| Rendimiento | Emojis en lugar de imágenes en la rejilla y una sola consulta por juego. Las actualizaciones llegan por WebSocket, sin recargar. |
| Legibilidad | Número del animal en negrita y nombre en dos líneas como máximo (p. ej. «Gallito de las Rocas»). |

### Puntos de quiebre

| Ancho | Diseño del juego |
|---|---|
| < 640 px (teléfono) | Una columna. Rejilla de 4 animales. Barra de acción fija y ticket en hoja inferior. |
| 640–1023 px (tablet) | Una columna. Rejilla de 6–7 animales. Sigue la barra de acción. |
| ≥ 1024 px (escritorio) | Dos columnas: juego a la izquierda y ticket fijo a la derecha. Rejilla de 6–8 animales. |

### Verificación

Cada pantalla del jugador (Animalitos, Mis jugadas, Resultados, Billetera, Cuenta, Deportes) se prueba a **375 × 812** sin desbordes horizontales. El backoffice también debe poder usarse en el teléfono (las tablas se desplazan dentro de su tarjeta), aunque su uso principal sea en escritorio.
