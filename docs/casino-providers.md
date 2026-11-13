# Casino: juegos externos de demostración

La sección `/casino` conecta juegos publicados por **GameMonetize**, desarrollados por **Inlogic Software**.
No se implementaron motores de slots, póker o ruleta propios. La conexión es mediante los iframes oficiales
del catálogo, no mediante una API de apuestas o monedero. No requiere una API key para estos embeds.

La elección del usuario fue priorizar juegos gratuitos con fichas del proveedor, aceptando la posibilidad
de anuncios. El saldo, los tickets y la identidad de Fortuna.Bet no se envían al proveedor ni se modifican.
Las fichas, idioma, progreso y publicidad pertenecen al juego externo; la persistencia puede depender de
cookies y almacenamiento del navegador. No se promete guardado entre dispositivos.

## Juegos y fuentes oficiales

Verificados el 2026-11-13: los seis enlaces de juego devolvieron HTTP 200 y no enviaron
`X-Frame-Options` ni `Content-Security-Policy` que impidieran incrustarlos.

| Juego | Categoría | Ficha oficial con código de inserción |
| --- | --- | --- |
| Fruit Slot Machine | Slots de frutas | https://gamemonetize.com/fruit-slot-machine-game |
| Las Vegas Roulette | Ruleta | https://gamemonetize.com/las-vegas-roulette-game |
| Las Vegas Poker | Cartas | https://gamemonetize.com/las-vegas-poker-game |
| Las Vegas Blackjack | Cartas | https://gamemonetize.com/las-vegas-blackjack-game |
| Lucky Vegas Slots | Slots | https://gamemonetize.com/lucky-vegas-slots-game |
| Wild West Slot Machine | Slots | https://gamemonetize.com/wild-west-slot-machine-game |

- Publicación e integración: https://gamemonetize.com/faq
- Información para publishers: https://gamemonetize.com/game-embed-code-generator
- Las fichas oficiales publican dos servidores de inserción: `html5.gamemonetize.games` y `html5.gamemonetize.co`.
- Las miniaturas oficiales de `img.gamemonetize.com/{providerId}/512x384.jpg` se guardan en
  `apps/web/src/assets/casino` para evitar dependencia del CDN al explorar el catálogo. Son las imágenes
  ofrecidas para descargar en cada ficha; su propiedad sigue siendo del proveedor/desarrollador.

## Implementación

- Catálogo controlado en `apps/web/src/lib/casino.ts`. Las rutas nunca aceptan una URL arbitraria de un usuario.
- `/casino` muestra el catálogo con búsqueda y filtros; `/casino/:gameId` abre un juego conocido.
- El iframe se crea solo al abrir la ruta del juego, no al navegar por el catálogo.
- Se mantiene separado del origen de Fortuna.Bet y con sandbox: no se concede navegación de la ventana principal.
- El reproductor permite reintentar, alternar entre los servidores oficiales y abrir el juego aparte.
- La carga del documento del iframe no prueba que el motor haya terminado de arrancar; no hay protocolo oficial
  de eventos de disponibilidad. Por eso siempre se ofrecen acciones de recuperación y no se afirma que una ronda haya iniciado.
- No se escucha `postMessage` del proveedor ni se aceptan operaciones de saldo desde el iframe.
- Antes de monetizar anuncios, registrar el sitio como publisher y revisar las condiciones vigentes con el proveedor.

La disponibilidad depende de GameMonetize, del navegador, la red y los bloqueadores de anuncios. Una URL pública
de demo de un casino comercial no equivale a permiso de integración ni a una API gratuita. Proveedores comerciales
como Evoplay ofrecen integración por acuerdo y acceso de partner: https://evoplay.games/partnerships/.

## Validación de esta integración

- La compilación de producción de la web pasó con TypeScript y Vite.
- Se comprobó el enlace Casino, los seis juegos del catálogo, filtros, búsqueda, estado vacío y anchura móvil.
- Se comprobó que el iframe de Fruit Slot Machine carga la pantalla oficial `PLAY GAME`.
- Los seis documentos externos respondieron HTTP 200; las fichas del proveedor publican los mismos IDs y URLs.
- La comprobación automatizada del arranque del motor de los seis juegos después de pulsar `PLAY GAME`
  fue bloqueada por la revisión automática de herramientas, sin motivo adicional. No se afirma haber completado
  rondas ni comprobado el funcionamiento de los motores externos. Esta comprobación queda para una prueba manual.
- Publicado en AWS el 2026-11-13 en `https://54.208.140.254.sslip.io/casino`, release
  `/opt/loteria/releases/20261113T222822Z-e926629` (base `e926629` y cambios locales de Casino).
- Se verificaron por HTTPS los 27 archivos de la web, las seis rutas de juego, API y WebSockets.
  Las rondas externas conservan la limitación de verificación indicada arriba.
- No se ejecutó el seed ni se importó historial: las 10 cuentas, los 14 tickets, los 10 juegos de lotería
  y las 29 migraciones se conservaron. La identidad y el hash de contraseña del administrador coinciden
  antes y después del despliegue. Respaldo en `/var/backups/loteria/20261113T222822Z-e926629`.
