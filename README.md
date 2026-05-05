# Sistema de Votación Isla del Sol / URBISOL

Sistema web de votación digital para campañas internas de comunidades vecinales, urbanizaciones o condominios. Está diseñado para operar procesos simples de votación, referéndum interno y elecciones de representantes, con registro controlado, enlaces personales de uso único, auditoría, sellado criptográfico, actas PDF y verificación posterior.

El sistema prioriza:

- operación simple para vecinos y adultos mayores;
- control manual por parte del Consejo Directivo;
- trazabilidad completa;
- bajo costo de infraestructura;
- evidencias verificables después del cierre;
- soporte para voto por unidad o propiedad habilitada.

> Este sistema no está pensado para elecciones estatales oficiales. Es una herramienta privada para procesos internos comunitarios.

---

## Estado funcional actual

Incluye:

- campañas de tipo `VOTACION` para consultas internas o referéndums;
- campañas de tipo elección de directiva/fiscales;
- registro público de vecinos;
- aprobación manual de solicitudes;
- aprobación individual y aprobación en bloque;
- enlace personal de votación por correo;
- reemisión individual de enlace cuando un vecino perdió el correo;
- recordatorio masivo simple a aprobados que aún no votaron, sin incluir enlace;
- voto único por unidad o propiedad;
- soporte para un mismo residente con más de una propiedad;
- hash individual por voto;
- cadena criptográfica por campaña;
- recibo de voto individual con opción, hash, código de verificación y enlace de validación;
- verificación pública del voto con código de verificación + DNI/CE o correo;
- rol `admin`, rol `fiscal` y rol `viewer`;
- fiscalización de votos individuales por admin/fiscal;
- sellado criptográfico de campaña;
- acta PDF y padrón PDF;
- publicación de resultados sellados;
- bloqueo de edición después del sellado;
- histórico de campañas cerradas;
- auditoría y log de notificaciones.

---

## Modelo operativo

### Regla principal de voto

El sistema trabaja bajo esta regla:

```text
1 unidad o propiedad habilitada = 1 voto
```

No usa la regla `1 DNI = 1 voto`.

Esto significa que una misma persona puede registrarse más de una vez si representa más de una propiedad. Cada registro corresponde a una unidad distinta, cada unidad recibe su propio enlace y cada enlace permite emitir un solo voto para esa unidad.

Ejemplo:

```text
Juan Pérez
DNI 12345678
Unidad A-101
Unidad B-204
```

Puede tener:

```text
2 solicitudes
2 aprobaciones
2 enlaces personales
2 votos, uno por cada propiedad
```

El sistema debe impedir más de un voto para la misma unidad.

---

## Tipos de campaña

### VOTACION

Para referéndums, consultas internas o decisiones simples.

Ejemplo:

```text
¿Debe actualizarse la cuota mensual?
A. S/ 230
B. S/ 250
```

Este es el modo recomendado para votaciones internas simples.

### Elección de Directiva/Fiscales

Flujo de elección con listas de Consejo Directivo y lista de fiscales. Mantiene compatibilidad con el modelo original de elección en dos pasos.

---

## Roles

### admin

Puede:

- crear campañas;
- editar campañas no selladas;
- configurar votaciones;
- aprobar/rechazar solicitudes;
- aprobar solicitudes en bloque;
- reemitir enlaces;
- enviar recordatorios;
- gestionar usuarios;
- gestionar padrón maestro;
- ver resultados;
- fiscalizar votos individuales;
- generar PDFs;
- sellar campañas;
- cerrar/desactivar campañas;
- activar campañas selladas en modo consulta para revisar resultados, fiscalización, acta y verificación, sin habilitar edición ni votos.

### fiscal

Puede consultar y fiscalizar, pero no modificar.

Puede ver:

- resultados;
- actas;
- sellos;
- detalle de votos individuales;
- export CSV de fiscalización.

No puede aprobar, editar campaña, crear usuarios ni sellar.

### viewer

Rol de solo consulta general. Puede acceder a resultados y vistas permitidas, sin acciones administrativas sensibles.

---

## Flujo completo del proceso

### 1. Crear campaña

Desde el panel administrativo:

```text
/admin
Campañas -> Crear nueva campaña
```

Completar:

- título;
- tipo de campaña;
- ventana de registro;
- ventana de votación.

Solo debe haber una campaña activa a la vez.

### 2. Configurar votación

Para tipo `VOTACION`, configurar:

- pregunta;
- opciones;
- orden de opciones.

Para tipo elección, configurar listas de directiva y fiscales.

### 3. Registro de vecinos

El vecino ingresa al formulario de registro público:

```text
/registro
```

Debe completar:

- calle;
- número;
- piso/depto si corresponde;
- nombre y apellidos;
- DNI/CE;
- teléfono;
- correo electrónico.

El correo es obligatorio porque el sistema envía enlaces y notificaciones por email.

Al terminar, el sistema muestra una pantalla indicando que revise su correo, Spam, Correo no deseado o Promociones, y que agregue el remitente a contactos o remitentes seguros.

### 4. Revisión del Consejo Directivo

La solicitud queda en estado:

```text
PENDING
```

El Consejo Directivo revisa por fuera del sistema si la unidad/persona está habilitada:

- pago al día;
- ausencia de sanción;
- representación válida;
- datos correctos.

El sistema no decide automáticamente si el vecino está habilitado. Esa decisión es administrativa.

### 5. Aprobación

Al aprobar una solicitud, el sistema hace todo junto:

- cambia la solicitud a `APPROVED`;
- genera un token secreto;
- guarda solo el hash del token;
- envía el enlace personal por email;
- muestra el enlace en pantalla para respaldo manual;
- registra auditoría;
- registra notificación.

No existe selector manual de “copiar” o “email”. La aprobación siempre intenta enviar por email y además muestra el link.

### 6. Aprobación en bloque

Desde la lista de solicitudes pendientes se pueden seleccionar varias solicitudes y aprobarlas en bloque.

El sistema:

- aprueba las seleccionadas;
- genera un enlace por cada solicitud;
- envía los correos;
- muestra resumen de aprobadas/enviadas/fallidas/omitidas;
- audita la operación.

Recomendación: probar primero con una solicitud y luego con grupos pequeños, especialmente si el proveedor SMTP tiene límites por hora.

### 7. Reemisión individual de enlace

Si un vecino no encuentra el correo o perdió el enlace, el admin puede usar:

```text
Reemitir enlace
```

La reemisión:

- solo funciona si la campaña no está sellada;
- solo funciona si la solicitud está aprobada;
- solo funciona si la unidad todavía no votó;
- revoca enlaces activos anteriores;
- genera un token nuevo;
- envía un nuevo correo;
- audita `TOKEN_REISSUED`.

No se recupera el enlace anterior porque el sistema no guarda el token en texto plano. Esto es intencional por seguridad.

### 8. Recordatorio a pendientes

Existe una pantalla:

```text
/admin/recordatorios-voto
```

Muestra:

- aprobados;
- ya votaron;
- pendientes;
- lista de pendientes.

Permite enviar recordatorio masivo simple a quienes todavía no votaron.

Importante:

- el recordatorio no incluye enlace de votación;
- no toca tokens;
- no reemplaza ni reemite enlaces;
- solo avisa que el vecino tiene una votación pendiente.

Esto reduce riesgo de exponer enlaces y ayuda a manejar límites de envío del proveedor SMTP.

### 9. Votación

Cada vecino abre su enlace personal.

Antes del inicio de votación:

- el sistema reconoce que el enlace es válido;
- no muestra opciones;
- informa fecha/hora de inicio;
- muestra contador regresivo.

Durante la ventana de votación:

- muestra opciones;
- permite seleccionar y confirmar;
- registra el voto;
- marca el token como usado;
- genera recibo de voto;
- envía correo de confirmación.

Después de la ventana:

- no permite votar.

Si el enlace ya fue usado:

- informa que el enlace ya fue usado;
- sugiere validar el voto;
- indica contactar al Consejo Directivo si corresponde.

### 10. Recibo individual de voto

Al votar, el vecino recibe un correo con:

- campaña;
- unidad/propiedad;
- fecha/hora;
- opción registrada;
- código de verificación;
- enlace para validar voto;
- hash del voto;
- posición en cadena.

Este recibo no permite votar otra vez ni modificar el voto. Solo permite consultar el voto registrado.

### 11. Validación pública del voto

Ruta pública:

```text
/verificar-voto
```

El vecino ingresa:

- código de verificación;
- DNI/CE o correo.

El sistema muestra:

- campaña;
- unidad;
- representante;
- fecha/hora;
- opción registrada;
- posición en cadena;
- hash del voto.

Funciona aunque la campaña ya esté cerrada o inactiva.

### 12. Fiscalización

Ruta:

```text
/admin/fiscalizacion
```

Disponible para admin y fiscal.

Permite ver campañas, sellos y detalle de votos individuales.

Detalle:

```text
/admin/fiscalizacion/:electionId/votos
/admin/fiscalizacion/:electionId/votos.csv
```

Incluye:

- unidad;
- representante;
- DNI/CE;
- email;
- opción votada;
- fecha/hora;
- posición en cadena;
- hash del voto.

Este sistema es trazable por diseño. No es voto secreto.

### 13. Resultados

Los resultados públicos no se muestran durante la votación activa. Se publican al cierre para evitar influir el voto.

Si no hay campaña activa, el home muestra la última campaña cerrada y permite consultar resultados históricos.

### 14. Sellado

Al finalizar la votación, el admin usa:

```text
Cerrar y Sellar Campaña
```

El sellado:

- calcula hash global por campaña/tipo de voto;
- guarda el sello en `election_seals`;
- publica el hash en el acta;
- bloquea nuevas votaciones y ediciones de campaña;
- permite verificación posterior.

Una campaña sellada puede activarse nuevamente solo para consulta administrativa: resultados, fiscalización, acta, padrón y verificación. Esa activación no reabre votación, edición de campaña, preguntas, listas, fiscales, solicitudes ni reemisión de enlaces.

### 15. Notificación de resultados sellados

Después del sellado se puede enviar un correo a los aprobados con:

- resumen de resultados;
- enlace a resultados publicados;
- sello/hash de integridad.

### 16. PDFs

Desde el panel se generan:

- Padrón PDF;
- Acta PDF.

Ambos abren en una pestaña nueva desde el panel administrativo.

El acta incluye:

- campaña;
- tipo de campaña;
- pregunta si aplica;
- resultados;
- métricas;
- sellos de integridad;
- espacio de firmas.

Para votación interna, las firmas sugeridas son:

- Presidente;
- Vicepresidente;
- Secretario;
- Tesorero opcional;
- Fiscal.

---

## Modelo criptográfico

### Hash individual del voto

Cada voto registra:

- `chain_position`;
- `previous_hash`;
- `vote_hash`.

El `vote_hash` se calcula con SHA-256 sobre un payload que incluye datos esenciales del voto:

- campaña;
- unidad;
- opción/lista;
- token;
- fecha/hora de registro;
- hash anterior;
- posición en cadena.

### Cadena por campaña

Cada nuevo voto referencia el hash del voto anterior. El primer voto usa:

```text
GENESIS
```

Si se modifica un voto anterior, se rompe la cadena.

### Sello global

Al sellar, se concatenan los `vote_hash` en orden y se calcula:

```text
global_hash = SHA256(concatenacion_de_vote_hashes)
```

Ese hash queda guardado y publicado en el acta.

### Verificación

La verificación recalcula la cadena y compara con el sello guardado o con un hash ingresado manualmente desde el acta.

---

## Auditoría y notificaciones

### audit_log

Registra eventos como:

- registro creado;
- solicitud aprobada;
- aprobación en bloque;
- token reemitido;
- voto emitido;
- validación de voto;
- fiscalización vista/exportada;
- acta generada;
- campaña sellada;
- resultados notificados;
- usuario administrativo creado/editado/eliminado.

Cada evento puede incluir:

- admin actor;
- campaña;
- unidad;
- solicitud;
- token;
- metadata JSON;
- timestamp.

### notification_log

Registra correos enviados, omitidos o fallidos.

Incluye:

- canal;
- template;
- destinatario;
- estado;
- error si hubo;
- metadata;
- timestamp.

---

## Correos del sistema

Los correos son texto plano para maximizar entregabilidad y evitar problemas con clientes como Hotmail/Outlook.

Tipos principales:

- solicitud recibida;
- solicitud aprobada con enlace;
- solicitud rechazada;
- recordatorio de voto pendiente;
- recibo de voto;
- resultados sellados;
- invitación a admin/fiscal/viewer.

Todos los correos al vecino deben ser claros, con frases cortas y contexto de unidad/propiedad cuando corresponde.

---

## Variables de entorno

Ejemplo de `.env`:

```env
NODE_ENV=production
PORT=3000
BASE_URL=https://isladelsol.org
DATABASE_URL=postgres://usuario:clave@localhost:5432/votacion
SESSION_SECRET=poner_una_clave_larga_y_unica

SYSTEM_NAME=Sistema de Votación Isla del Sol
SUPPORT_EMAIL=Consejo Directivo <votacion@isladelsol.org>

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario_smtp
SMTP_PASS=clave_smtp
SMTP_FROM=Consejo Directivo Isla del Sol <votacion@isladelsol.org>
```

Importante: usar `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM`.

---

## Instalación local

```bash
git clone https://github.com/avilsmeier/votacion_URBISOL.git
cd votacion_URBISOL
npm install
```

Crear `.env` y configurar PostgreSQL.

Ejecutar migraciones/base SQL según corresponda al entorno.

Levantar:

```bash
node src/server.js
```

Por defecto escucha en:

```text
:3000
```

---

## Producción con systemd

Servicio recomendado:

```ini
[Unit]
Description=Sistema Votacion Isla del Sol
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
Environment=NODE_ENV=production
WorkingDirectory=/home/autoagent/votaciones
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
User=autoagent
EnvironmentFile=/home/autoagent/votaciones/.env
StartLimitInterval=0

[Install]
WantedBy=multi-user.target
```

Comandos útiles:

```bash
sudo systemctl daemon-reload
sudo systemctl enable votacion
sudo systemctl restart votacion
sudo systemctl status votacion --no-pager
journalctl -u votacion -n 100 --no-pager
```

---

## Despliegue después de cambios

```bash
cd /home/autoagent/votaciones
git pull --rebase origin main
node --check src/server.js
node --check src/mailer.js
node --check src/actaPdf.js
sudo systemctl restart votacion
```

Si hay scripts de patch pendientes:

```bash
node scripts/nombre_del_script.mjs
node --check src/server.js
sudo systemctl restart votacion
```

Luego versionar cambios locales generados por scripts:

```bash
git add src/server.js src/views/*.ejs
git commit -m "Describe production patch"
git push
```

---

## Migraciones importantes

### Rol fiscal y recibos de voto

```bash
sudo -u postgres psql -d votacion -v ON_ERROR_STOP=1 -f migrations/20260504_fiscal_role_vote_receipts.sql
```

### Admins y padrón maestro

```bash
sudo -u postgres psql -d votacion -v ON_ERROR_STOP=1 -f migrations/20260504_admins_and_resident_registry.sql
```

### Permitir DNI/email duplicados entre propiedades

```bash
sudo -u postgres psql -d votacion -v ON_ERROR_STOP=1 -f migrations/20260504_allow_resident_duplicate_contacts.sql
```

Esta migración es importante porque un mismo residente puede tener más de una propiedad.

---

## Verificaciones técnicas rápidas

### Sintaxis Node

```bash
node --check src/server.js
node --check src/mailer.js
node --check src/actaPdf.js
```

### Estado del servicio

```bash
sudo systemctl status votacion --no-pager
journalctl -u votacion -n 100 --no-pager
```

### Últimas notificaciones

```sql
SELECT template, recipient, status, error, created_at
FROM notification_log
ORDER BY id DESC
LIMIT 20;
```

### Últimos eventos de auditoría

```sql
SELECT event, actor_admin_id, registration_id, token_id, meta_json, created_at
FROM audit_log
ORDER BY id DESC
LIMIT 20;
```

### Recibos de voto

```sql
SELECT id, election_id, registration_id, vote_kind, vote_table, vote_id, substr(vote_hash,1,16) AS hash_prefix, created_at
FROM vote_receipts
ORDER BY id DESC
LIMIT 10;
```

---

## Checklist mínimo antes de producción

Antes de abrir producción real, validar solo los controles críticos de estabilidad, seguridad, inmutabilidad y transparencia:

1. Login admin/fiscal/viewer.
2. Crear una campaña de prueba `VOTACION`.
3. Configurar una pregunta y dos opciones.
4. Registrar 2 usuarios internos, aprobarlos y confirmar correo de enlace.
5. Emitir 1 voto y confirmar recibo con código/hash.
6. Validar el voto en `/verificar-voto`.
7. Revisar resultados y fiscalización.
8. Sellar la campaña.
9. Descargar acta PDF y verificar que muestra resultados/sellos.
10. Ejecutar verificación de integridad.
11. Cerrar/desactivar la campaña.
12. Activar nuevamente la campaña sellada.
13. Confirmar que acta/resultados/fiscalización/verificación siguen accesibles.
14. Confirmar que editar campaña, editar preguntas/listas, aprobar solicitudes, reemitir enlaces y votar quedan bloqueados.
15. Cerrar/desactivar nuevamente la campaña sellada.

---

## Reglas después del sellado

Una campaña sellada:

- no permite nuevos votos;
- no permite aprobar solicitudes;
- no permite reemitir enlaces;
- no permite editar la campaña;
- no permite editar preguntas, opciones, listas ni fiscales;
- puede activarse temporalmente solo para consulta administrativa;
- sí permite consultar resultados;
- sí permite descargar acta;
- sí permite descargar padrón;
- sí permite verificar integridad;
- sí permite gestionar admins/fiscales/viewers;
- sí permite gestionar padrón maestro;
- sí permite crear una nueva campaña.

Activar una campaña sellada no reabre votación ni edición. Solo la publica como campaña activa de consulta para poder acceder a acta, resultados, fiscalización, padrón y verificación.

---

## Seguridad y limitaciones

### Seguridad aplicada

- tokens hasheados en DB;
- tokens no recuperables en texto plano;
- rate limiting básico;
- sesiones HTTP only;
- soporte para proxy;
- advisory locks para serializar votos;
- hash encadenado por voto;
- sello global por campaña;
- auditoría;
- logs de notificación;
- bloqueo post-sellado;
- cache deshabilitado en PDFs administrativos.

### Limitaciones conocidas

- no es voto secreto;
- no es sistema electoral estatal;
- depende de la integridad del servidor y base de datos;
- no usa cifrado homomórfico;
- no usa firma digital certificada del acta;
- `MemoryStore` de sesiones no es ideal para producción prolongada;
- el envío masivo depende del proveedor SMTP y sus límites.

---

## Proveedores de correo

El sistema usa SMTP estándar.

Para pruebas se puede usar Gmail u otro SMTP, pero para producción conviene un proveedor transaccional.

Consideraciones:

- configurar SPF;
- configurar DKIM;
- configurar DMARC;
- usar remitente del dominio oficial;
- monitorear rebotes;
- evitar HTML pesado;
- evitar envíos masivos sin control si el proveedor limita correos por hora.

Los correos son texto plano para mejorar entregabilidad.

---

## Futuras mejoras recomendadas

- cola de correos con rate limit;
- panel de progreso de envíos;
- reintento de notificaciones fallidas;
- export completo de auditoría;
- almacenamiento de sesiones en PostgreSQL o Redis;
- Dockerfile;
- CI básico con `node --check`;
- backups automáticos de PostgreSQL;
- firma digital externa del acta PDF;
- soporte para múltiples preguntas por campaña;
- modo observador público read-only.

---

## Guía breve para el vecino

1. Registrarse con su unidad y datos.
2. Revisar correo y Spam/Correo no deseado.
3. Esperar aprobación del Consejo Directivo.
4. Recibir enlace personal de votación.
5. Abrir el enlace durante la ventana de votación.
6. Elegir una opción.
7. Confirmar voto.
8. Guardar el recibo recibido por correo.
9. Validar el voto en `/verificar-voto` si lo desea.

Si representa más de una propiedad, debe registrar cada unidad por separado.

---

## Guía breve para el Consejo Directivo

1. Crear campaña.
2. Configurar pregunta/opciones.
3. Abrir registro.
4. Revisar solicitudes.
5. Aprobar individual o en bloque.
6. Verificar emails enviados.
7. Reemitir enlaces puntuales si algún vecino los pierde.
8. Enviar recordatorios simples si hace falta.
9. Monitorear participación.
10. Cerrar votación.
11. Sellar campaña.
12. Descargar acta.
13. Verificar integridad.
14. Notificar resultados sellados.
15. Cerrar/desactivar campaña.

---

## Licencia y uso

Uso privado para comunidades vecinales y procesos internos. Sin garantía para procesos electorales oficiales estatales.
