# Cumbre Futuros (MER-06) — Manual de reglas y modelo para desarrollo

> **Propuesta v0.1 · 09-11-2026 · BORRADOR NO OFICIAL · implementado en la plataforma (modo DEMO).** Sexto producto de SuerteAndes Marketplace.
>
> Reproduce la mecánica de los **contratos perpetuos con margen en USDT** de los exchanges de criptomonedas (modelo USDⓈ-M popularizado por Binance Futures), con **tres contratos: BTCUSDT, ETHUSDT y SOLUSDT**. Se opera **solo en USDT**.
>
> «Cumbre Futuros» y el código `MER-06` son nombres de trabajo; la operadora puede cambiarlos. El producto no usa la marca, el logo ni el nombre de Binance: solo su mecánica pública.

Leyenda: **[B]** mecánica estándar de los perpetuos USDⓈ-M (igual que en Binance) · **[P]** propuesta de este documento (valor o regla de la plataforma) · **[⚠]** riesgo o diferencia que hay que conocer.

---

## 0. Advertencias previas (leer antes de aprobar)

1. **[⚠] No es un juego de lotería.** Un futuro perpetuo apalancado es un **instrumento derivado sobre criptoactivos**. Necesita una autorización **distinta** de la de lotería: en Venezuela, la del regulador de criptoactivos (SUNACRIP) y la que corresponda a valores. Hasta tenerla, el producto opera **solo en modo DEMO** (`DEMO - SIN VALOR`), como los demás juegos de la plataforma.
2. **[⚠] La casa es la contraparte.** En Binance cada long tiene un short de otro usuario en el libro de órdenes. Aquí **no hay libro de órdenes**: la plataforma toma el otro lado de cada operación. Por eso, cuando los jugadores ganan, paga la casa. Esto cambia el riesgo de la operadora (ver §9) y obliga a las reglas de integridad de §3.
3. **[⚠] El precio nunca lo pone la casa.** El precio de referencia sale de **fuentes externas del mercado** (§3). La operadora no puede editar precios, mover la marca para liquidar a nadie ni anular operaciones ganadoras. Es la misma regla de integridad que el azar en la lotería: el resultado no depende de quién ganaría.
4. **[⚠] El apalancamiento hace perder rápido.** Con 20× basta un movimiento de ~5 % en contra para perder todo el margen de la posición. La pantalla de órdenes debe mostrar siempre el precio de liquidación **antes** de confirmar.

---

## 1. Identificación

| Campo | Valor |
|---|---|
| Nombre | Cumbre Futuros [P] |
| Código | `MER-06` [P] |
| Tipo | Contratos perpetuos lineales con margen en USDT [B] |
| Contratos | `BTCUSDT`, `ETHUSDT`, `SOLUSDT` [P] |
| Moneda | **Solo USDT** (margen, comisiones, PnL y funding) [P] |
| Vencimiento | Ninguno (perpetuo) [B] |
| Contraparte | La plataforma (sin libro de órdenes entre usuarios) [P][⚠] |
| Horario | 24/7; se pausa si el feed de precios falla (§3.4) [P] |
| Edad / KYC | 18+, **KYC nivel 2 obligatorio** antes de operar [P] |
| Versión de reglas | `MER-06 v0.1-borrador`, guardada en cada orden y posición [P] |
| Autorización | **SIN ACREDITAR** → modo DEMO [⚠] |

---

## 2. Especificación de los contratos

| | BTCUSDT | ETHUSDT | SOLUSDT |
|---|---|---|---|
| Subyacente | Bitcoin | Ether | Solana |
| Tipo | Perpetuo lineal USDT-M [B] | igual | igual |
| Tamaño | 1 contrato = 1 unidad del subyacente [B] | igual | igual |
| Paso de cantidad | 0,001 BTC [P] | 0,001 ETH [P] | 0,01 SOL [P] |
| Paso de precio (tick) | 0,10 USDT [P] | 0,01 USDT [P] | 0,001 USDT [P] |
| Nocional mínimo por orden | 5 USDT [P] | 5 USDT [P] | 5 USDT [P] |
| Apalancamiento máximo | 50× [P] | 50× [P] | 25× [P] |
| Apalancamiento por defecto | 10× [P] | 10× [P] | 5× [P] |
| Funding | cada 8 h [B] | cada 8 h | cada 8 h |

**[P] Por qué menos apalancamiento que Binance (que llega a 125× en BTC):** es una plataforma de público general y el margen de error del jugador es mínimo con más de 50×. La operadora puede subirlo en Configuración sin tocar código. Los tramos de §6 ya escalan el riesgo.

---

## 3. Precios (integridad)

### 3.1 Tres precios, como en el exchange [B]

| Precio | Qué es | Para qué se usa |
|---|---|---|
| **Índice** | Mediana del precio *spot* en varias fuentes externas | Base del precio marca y del funding |
| **Marca (mark price)** | Precio justo derivado del índice | **PnL no realizado y liquidaciones** |
| **Último / ejecución** | Precio al que se llena una orden | Entrada y salida de posiciones |

### 3.2 Fuentes [P]

- Índice = **mediana** de los tickers spot públicos de al menos **3 exchanges**, en pares USDT. **Implementado (v0.1):** Kraken, OKX, KuCoin, Gate y Coinbase. Binance y Bybit bloquean el acceso desde la ubicación del servidor, así que no se usan.
- Una fuente se descarta si su último dato tiene más de 10 s o se aleja más de 2 % de la mediana de las demás.
- Se necesitan **mínimo 3 fuentes válidas**; con menos, ese contrato pasa a «solo cerrar» (§3.4).

### 3.3 Precio marca y precio de ejecución [B adaptado]

- En Binance el precio marca es la mediana de (índice con el funding prorrateado, índice + media de la base de 30 min, último precio del libro). **[P]** Como aquí no hay libro propio, **precio marca = índice**, recalculado **cada 2 segundos** (cada tick consulta 13 endpoints públicos; más seguido rozaría los límites de los exchanges).
- **[P] Precio de ejecución** de una orden a mercado = índice del momento de la orden, **sin spread**. La casa gana por comisiones y funding, no escondiendo un margen en el precio (más transparente para el jugador).
- **[P] Órdenes límite:** se llenan cuando el índice cruza el precio límite. Se ejecutan **a su precio límite** y pagan comisión *maker*.

### 3.4 Reglas de integridad [P]

1. Nadie de la operadora puede editar, inventar ni reprocesar un precio. No existe ningún endpoint para hacerlo.
2. Cada tick usado queda guardado (fuentes, valores, mediana, hora), igual que `rng.rng_call` en la lotería. Cualquier llenado, liquidación o funding se puede reconstruir y verificar.
3. **Feed caído** (sin 3 fuentes válidas durante más de 10 s): ese contrato pasa a **solo cerrar**, sin nuevas posiciones, y **se suspenden las liquidaciones** hasta que el feed vuelva. Así nadie es liquidado con un precio malo.
4. **Salto anómalo** (más de 10 % en 1 minuto contra la mediana de las fuentes): se pausa el contrato y queda una incidencia en el backoffice, como en `draw_incident`.

---

## 4. Billetera de futuros y modos de margen

### 4.1 Transferencias [B]

El jugador **transfiere USDT** de su billetera principal a su **billetera de futuros** (y de vuelta), como en el exchange. Solo puede transferir de vuelta el saldo disponible (lo que no está usado como margen ni comprometido en pérdidas abiertas).

### 4.2 Modo de posición [B]

**Unidireccional** (one-way): una sola posición por contrato, larga o corta. Comprar con una posición corta abierta la reduce o la invierte. **[P]** El modo cobertura (long y short simultáneos) queda para una versión posterior.

### 4.3 Margen aislado y cruzado [B]

| | Aislado | Cruzado |
|---|---|---|
| Margen de la posición | Solo el asignado a esa posición | Todo el saldo de la billetera de futuros |
| Pérdida máxima | El margen asignado | Todo el saldo de futuros |
| Liquidación | Por posición | Cuando el saldo total ya no cubre el mantenimiento de todas |
| Añadir/quitar margen | Sí, manualmente | Automático |

**[P] Por defecto: aislado.** Es más fácil de entender y limita la pérdida a lo que el jugador asignó.

**[P] Protección de saldo negativo:** el jugador **nunca** queda debiendo. Si una liquidación se ejecuta peor que el precio de quiebra (*bankruptcy price*), la diferencia la absorbe la casa.

---

## 5. Órdenes [B]

| Tipo | Comportamiento |
|---|---|
| **Mercado** | Se llena al precio de ejecución del momento (§3.3) |
| **Límite** | Se llena cuando el índice toca el precio; GTC por defecto |
| **Stop mercado** | Al tocar el precio de activación, envía una orden a mercado |
| **Take profit / Stop loss (TP/SL)** | Asociados a la posición; disparo por **precio marca** [P] |
| **Solo reducir** (reduce-only) | Nunca aumenta la posición |
| **Post-only** | Si se llenaría al instante, se cancela (garantiza *maker*) |
| Vigencia | GTC, IOC y FOK |

Validaciones al enviar:

- cantidad múltiplo del paso;
- nocional ≥ 5 USDT;
- apalancamiento ≤ el del tramo (§6);
- margen inicial + comisión estimada ≤ saldo disponible;
- precio de liquidación resultante del lado correcto del precio de entrada.

---

## 6. Margen, tramos y apalancamiento [B]

### 6.1 Definiciones

- **Nocional** = cantidad × precio.
- **Margen inicial (IM)** = nocional ÷ apalancamiento.
- **Margen de mantenimiento (MM)** = nocional (a precio marca) × MMR − monto de mantenimiento del tramo (`cum`).
- Si el **margen de la posición** (aislado) o el **saldo de margen** (cruzado) ≤ MM, hay **liquidación**.

### 6.2 Tramos de riesgo [P, estructura igual a la de Binance]

A más nocional, menos apalancamiento permitido y más mantenimiento. `cum` hace que el MM sea continuo entre tramos: `cum_n = cum_{n−1} + piso_n × (MMR_n − MMR_{n−1})`.

**BTCUSDT**

| Tramo | Nocional (USDT) | Apalancamiento máx. | MMR | cum (USDT) |
|---|---|---|---|---|
| 1 | 0 – 10.000 | 50× | 0,40 % | 0 |
| 2 | 10.000 – 50.000 | 25× | 0,50 % | 10 |
| 3 | 50.000 – 100.000 | 20× | 1,00 % | 260 |

**ETHUSDT**

| Tramo | Nocional (USDT) | Apalancamiento máx. | MMR | cum (USDT) |
|---|---|---|---|---|
| 1 | 0 – 10.000 | 50× | 0,50 % | 0 |
| 2 | 10.000 – 50.000 | 25× | 0,65 % | 15 |
| 3 | 50.000 – 100.000 | 20× | 1,00 % | 190 |

**SOLUSDT**

| Tramo | Nocional (USDT) | Apalancamiento máx. | MMR | cum (USDT) |
|---|---|---|---|---|
| 1 | 0 – 5.000 | 25× | 1,00 % | 0 |
| 2 | 5.000 – 25.000 | 20× | 1,50 % | 25 |
| 3 | 25.000 – 50.000 | 10× | 2,50 % | 275 |

**[P]** El techo del último tramo es el **nocional máximo por jugador y contrato**. En demo los tramos son editables desde Configuración. Los valores reales de Binance cambian con el tiempo y no se copian literalmente: son una propuesta para la aprobación de la operadora.

---

## 7. Fórmulas [B]

`Q` = cantidad (positiva), `E` = precio de entrada, `P` = precio marca, `M` = margen de la posición (aislado), `MMR` y `cum` del tramo.

| Concepto | Long | Short |
|---|---|---|
| PnL no realizado | `Q × (P − E)` | `Q × (E − P)` |
| ROE | `PnL ÷ IM` | `PnL ÷ IM` |
| **Precio de liquidación** (aislado) | `(Q·E − M − cum) ÷ (Q × (1 − MMR))` | `(Q·E + M + cum) ÷ (Q × (1 + MMR))` |
| Precio de quiebra (margen = 0) | `E − M ÷ Q` | `E + M ÷ Q` |

- **Precio de entrada promedio** al aumentar una posición: `(Q₁·E₁ + Q₂·E₂) ÷ (Q₁ + Q₂)`.
- **PnL realizado** al cerrar una cantidad `q`: `q × (salida − E)` en long, `q × (E − salida)` en short.
- **Cruzado:** se liquida cuando `saldo de futuros + Σ PnL no realizado ≤ Σ MM de todas las posiciones`. El precio de liquidación mostrado se calcula suponiendo que las demás posiciones no se mueven.

---

## 8. Comisiones, funding y liquidación (ingresos de la casa)

### 8.1 Comisiones de operación [B, valores del nivel estándar]

| Tipo | Comisión | Sobre |
|---|---|---|
| **Taker** (mercado, stop, límite que llena al instante) | **0,05 %** | nocional de cada llenado |
| **Maker** (límite que espera en el libro) | **0,02 %** | nocional de cada llenado |

Se cobra al **abrir y al cerrar**. Un ida y vuelta a mercado cuesta **0,10 % del nocional**, que es **1 % del margen a 10×** y **2 % a 20×**.

### 8.2 Funding cada 8 horas [B]

- Se liquida a las **00:00, 08:00 y 16:00 UTC** (20:00, 04:00 y 12:00 hora de Venezuela). Solo paga o cobra quien tiene posición abierta en ese instante.
- **Pago = nocional a precio marca × tasa de funding.** Si la tasa es positiva, los longs pagan; si es negativa, los shorts pagan.
- **Tasa** = índice de prima + clamp(interés − índice de prima, −0,05 %, +0,05 %).
  - Interés: 0,01 % por periodo de 8 h.
  - Tope de la tasa: ±0,30 % por periodo [P].
- **[P] Índice de prima sin libro propio:** se toma la **tasa de funding publicada por los exchanges de referencia** (mediana de OKX, Gate y KuCoin, consultada cada minuto), así el jugador paga o cobra lo mismo que pagaría en el mercado. Sin dato válido, se aplica la tasa base de 0,01 %.
- **[⚠] Contraparte:** en el exchange el funding pasa de longs a shorts. Aquí la contraparte es la casa, así que **el funding que pagan los jugadores lo cobra la casa y el que reciben lo paga la casa.**

### 8.3 Liquidación [B adaptado]

- El motor revisa **en cada tick (2 s)** el precio marca contra el mantenimiento de cada posición.
- Al liquidarse se cierra la posición completa al precio marca y se cobra una **tarifa de liquidación del 0,50 % del nocional** [P], descontada del margen que quede.
- Lo que quede del margen después de la tarifa vuelve al jugador. Si no alcanza, rige la protección de saldo negativo (§4.3).
- **[P] Sin auto-desapalancamiento (ADL)** ni fondo de seguros: la casa es la contraparte y absorbe el faltante.
- **[P] Aviso de margen:** a partir del 80 % de uso del mantenimiento la tarjeta de la posición se marca en rojo con el aviso «Cerca de la liquidación». (v0.1: aviso en pantalla; la notificación push queda pendiente).

### 8.4 Resumen de porcentajes

| Fuente | Porcentaje | Quién paga |
|---|---|---|
| Comisión taker | 0,05 % del nocional, al abrir y al cerrar | Jugador → casa |
| Comisión maker | 0,02 % del nocional, al abrir y al cerrar | Jugador → casa |
| Funding | ±tasa del mercado cada 8 h (base 0,01 %) | Lado que paga → casa, o casa → lado que cobra |
| Liquidación | 0,50 % del nocional liquidado | Jugador → casa |
| Spread | 0 % (sin margen escondido en el precio) | — |

---

## 9. Cómo gana (y cómo puede perder) la casa [⚠]

A diferencia de la lotería, aquí **no hay un margen fijo garantizado** como el 28,6 % de Animalitos.

**Resultado de la casa = comisiones + funding neto + tarifas de liquidación − PnL neto de los jugadores.**

- **Comisiones y tarifas:** ingreso estable, proporcional al volumen.
- **PnL de los jugadores:** con precios que vienen del mercado, su valor esperado es ~0 para la casa. Pero su **varianza es grande**: si el mercado sube 20 % en un día y la mayoría está long, la casa paga mucho.

Controles obligatorios [P]:

| Control | Valor inicial |
|---|---|
| Nocional máximo por jugador y contrato | techo del último tramo (§6.2) |
| **Exposición neta máxima de la casa por contrato** (Σ longs − Σ shorts) | BTC 250.000 · ETH 150.000 · SOL 75.000 USDT |
| Si se supera la exposición neta | Solo se aceptan órdenes que la reduzcan, hasta volver al límite |
| Pérdida diaria máxima de la casa en futuros | 5 % del capital asignado → pausa de nuevas posiciones y alerta |
| Cobertura externa (*hedge*) | Fuera de alcance en demo. En operación real la casa debería cubrir su exposición neta en un exchange real |

**Ejemplo de ingresos por volumen:** 1.000.000 USDT de nocional operado a mercado en el mes (ida y vuelta) deja **1.000 USDT de comisiones** (0,10 %), más funding y tarifas de liquidación. Eso es lo «seguro»; el resto depende del mercado.

---

## 10. Ejemplos resueltos

**Ejemplo 1 — Long BTC aislado, 10×.** Precio 100.000 USDT; margen 100 USDT.

| Concepto | Cálculo | Resultado |
|---|---|---|
| Nocional | 100 × 10 | 1.000 USDT |
| Cantidad | 1.000 ÷ 100.000 | 0,010 BTC |
| Comisión de apertura | 1.000 × 0,05 % | 0,50 USDT |
| Liquidación (tramo 1: MMR 0,40 %, cum 0) | (0,01 × 100.000 − 100) ÷ (0,01 × 0,996) | **90.361,45 USDT** (−9,64 %) |

- **Si BTC sube a 105.000:** PnL = 0,01 × 5.000 = **+50 USDT** (ROE +50 %). Comisión de cierre = 1.050 × 0,05 % = 0,525. **Neto: +48,975 USDT.**
- **Si BTC baja a 90.361,45:** se liquida. Margen restante 3,61 USDT; la tarifa de liquidación (0,5 % de 903,61 = 4,52 USDT) se lleva lo que queda. Pierde los 100 USDT más la comisión de apertura.

**Ejemplo 2 — Short ETH aislado, 20×.** Precio 4.000 USDT; margen 50 USDT.

| Concepto | Cálculo | Resultado |
|---|---|---|
| Nocional | 50 × 20 | 1.000 USDT |
| Cantidad | 1.000 ÷ 4.000 | 0,250 ETH |
| Liquidación (tramo 1: MMR 0,50 %, cum 0) | (0,25 × 4.000 + 50) ÷ (0,25 × 1,005) | **4.179,10 USDT** (+4,48 %) |

- **Si ETH baja a 3.800:** PnL = 0,25 × 200 = **+50 USDT** (ROE +100 %).

**Ejemplo 3 — Funding.** Long SOL de 1.000 USDT de nocional con tasa +0,01 %: paga **0,10 USDT** a las 12:00, 20:00 y 04:00 (hora de Venezuela), mientras la posición siga abierta.

---

## 11. Pantallas (mismo patrón que el exchange)

**Jugador (mobile-first):**

1. **Selector de contrato** (BTC, ETH, SOL) con precio marca, variación de 24 h, próximo funding y tasa.
2. **Gráfico** de velas del índice (1 m, 15 m, 1 h, 4 h, 1 d).
3. **Formulario de orden:**
   - Long/Short; Mercado/Límite/Stop; cantidad en moneda o en USDT, con atajos de 25 %, 50 %, 75 % y 100 %.
   - Selector de apalancamiento con el máximo del tramo; Aislado/Cruzado; TP/SL opcional.
   - Antes de confirmar muestra: **margen, comisión estimada y precio de liquidación**.
4. **Posiciones:** tamaño, entrada, marca, liquidación, margen, PnL y ROE; cerrar total o parcial; TP/SL; añadir margen.
5. **Órdenes abiertas, historial de órdenes, operaciones, funding y transferencias.**
6. **Billetera de futuros:** saldo, margen usado, disponible; transferir desde y hacia la billetera principal.

**Backoffice:**

- **Salud del feed:** fuentes, retrasos, contratos pausados.
- **Exposición neta por contrato** y uso del límite.
- **Resultado del día:** comisiones, funding, liquidaciones y PnL contra la casa.
- **Liquidaciones** con su tick de precio y la verificación.
- **Configuración:** apalancamiento máximo, tramos, comisiones, tarifa de liquidación y límites de exposición, todo con auditoría.
- Pausar o reanudar un contrato (solo cerrar), con incidencia obligatoria.

---

## 12. Contabilidad (ledger de doble partida, como el resto) [P]

| Cuenta | Uso |
|---|---|
| `PLAYER_CASH` (USDT) | Billetera principal (ya existe) |
| `PLAYER_FUTURES` (USDT) | Billetera de futuros del jugador |
| `FUTURES_MARGIN` | Margen bloqueado en posiciones |
| `HOUSE_FUTURES_FEES` | Comisiones y tarifas de liquidación |
| `HOUSE_FUTURES_PNL` | PnL y funding contra la casa (contraparte) |

Cada llenado, cierre, funding y liquidación es **una transacción del ledger** con su clave de idempotencia, como las apuestas de lotería. El cuadre (Σ D = Σ C) y la cadena de auditoría siguen aplicando.

---

## 13. Juego responsable [P]

- **Aviso de riesgo obligatorio** al activar futuros, con un cuestionario corto que confirme que el jugador entiende la liquidación.
- **Límites personales:** depósito a futuros diario, pérdida diaria y apalancamiento máximo personal (puede bajar del de la plataforma, nunca subir).
- La **autoexclusión** de la plataforma bloquea también futuros.
- Sin bonos ni promociones atadas al apalancamiento.

---

## 14. Decisiones pendientes de la operadora

| # | Decisión | Propuesta |
|---|---|---|
| 1 | Nombre y código | Cumbre Futuros · MER-06 |
| 2 | Apalancamiento máximo | 50× BTC/ETH, 25× SOL |
| 3 | Comisiones | Taker 0,05 % · maker 0,02 % |
| 4 | Tarifa de liquidación | 0,50 % del nocional |
| 5 | Margen por defecto | Aislado |
| 6 | Fuentes de precio | ≥ 3 exchanges públicos, mediana |
| 7 | Exposición neta máxima de la casa | 250k / 150k / 75k USDT |
| 8 | Modo cobertura (long y short a la vez) | Fase 2 |
| 9 | Autorización regulatoria | **Pendiente** → solo DEMO |

---

## 15. Fuera de alcance de la v0.1

- Libro de órdenes entre usuarios y emparejamiento real.
- Más contratos, futuros con vencimiento o con margen en moneda (COIN-M).
- Opciones, bots de trading, copy trading, subcuentas y API para clientes.
- Cobertura automática de la exposición de la casa en un exchange externo.
