# 📘 README.md

```markdown
# 🗳 Sistema de Votación URBISOL 1.0

Sistema de votación digital para elecciones vecinales (urbanizaciones / condominios), diseñado para ser:

- Transparente
- Auditable
- De bajo costo
- Fácil de usar para adultos mayores
- Verificable criptográficamente

Incluye registro aprobado manualmente, token único por unidad, mini-blockchain por campaña, sello criptográfico de cierre y verificación independiente.

---

# 🎯 Objetivo

Permitir votación digital complementaria a urna física, asegurando:

- 1 voto por unidad
- Token único de uso único
- Registro aprobado por el Comité Electoral
- Resultados auditables
- Imposibilidad práctica de manipulación posterior

Este sistema está pensado para comunidades pequeñas (100–300 familias).

---

# 🧱 Arquitectura Técnica

## Stack

- Node.js 24
- Express
- PostgreSQL
- EJS
- PDFKit
- Crypto (SHA256)
- Nginx + Cloudflare (opcional)

---

# 🔐 Modelo de Seguridad

## 1️⃣ Registro

Cada vecino se registra con:

- Dirección (normalizada)
- DNI / CE
- Email obligatorio
- Teléfono

Estado inicial: `PENDING`.

El Comité Electoral aprueba manualmente.

Solo registros aprobados pueden votar.

---

## 2️⃣ Token de Votación

Al aprobar:

- Se genera token único
- Se guarda hash del token en DB
- Se envía enlace por email
- Se registra evento en auditoría

El token:

- Es de uso único
- Está ligado a una unidad
- Se bloquea tras completar ambos votos

---

## 3️⃣ Votación en 2 pasos

1. Voto Directiva
2. Voto Fiscales

Ambos se registran dentro del mismo flujo con el mismo token.

---

## 4️⃣ Mini-Blockchain por Campaña

Cada voto contiene:

- `chain_position`
- `previous_hash`
- `vote_hash`

El hash se calcula como:

```

SHA256(JSON(payload))

```

Donde el payload incluye:

- election_id
- unit_id
- candidate_id o fiscal_list_id
- token_id
- cast_at
- previous_hash
- chain_position

Cada voto referencia criptográficamente al anterior.

Si alguien modifica un voto:
→ Se rompe la cadena  
→ Falla la verificación  

---

## 5️⃣ Sello Criptográfico

Al cerrar la elección:

1. Se concatenan todos los `vote_hash` en orden.
2. Se calcula:

```

global_hash = SHA256(concatenación)

```

3. Se guarda en `election_seals`
4. Se publica en el Acta PDF

Después del sellado:
Cualquier modificación es detectable matemáticamente.

---

# 🔎 Verificación

Existen dos métodos:

## 🔹 Web

Panel Admin → Verificar Integridad

Permite:

- Verificar contra sello guardado
- Pegar hash manual del acta (verificación histórica)

---

## 🔹 CLI independiente

```

node scripts/verify_chain.mjs <election_id>

```

Recalcula:

- Encadenamiento completo
- Hash de cada bloque
- Hash global

Si algo fue modificado:
→ Error

---

# 📊 Auditoría

Tabla `audit_log` registra:

- Registro creado
- Registro aprobado
- Token generado
- Token enviado
- Voto emitido
- PDF generado
- Sello generado
- Verificación ejecutada

Cada evento incluye:

- actor_admin_id
- election_id
- meta_json
- timestamp

Auditoría exportable por campaña.

---

# 👤 Guía Rápida – Usuario

1. Recibe email con enlace único.
2. Ingresa.
3. Vota Directiva.
4. Vota Fiscales.
5. Fin.

No puede votar dos veces.
El enlace queda inutilizable.

---

# 🧑‍⚖️ Guía Rápida – Comité Electoral

## Antes de votar

1. Crear campaña.
2. Cargar listas y planes PDF.
3. Abrir registro.
4. Aprobar solicitudes.
5. Verificar envío de tokens.

---

## Durante votación

- Monitorear participación.
- Exportar padrón si necesario.

---

## Al cerrar

1. Cerrar votación.
2. Presionar "Cerrar y Sellar".
3. Descargar Acta PDF.
4. Publicar hash global en grupo oficial.
5. (Opcional) Ejecutar verify_chain desde CLI.

---

# 📄 PDFs

## Padrón

- Solo registros aprobados
- Sin datos sensibles innecesarios

## Acta

Incluye:

- Resultados
- Métricas
- Hash global
- Espacios de firma
- Sello digital del sistema

---

# ⚙️ Instalación

```

git clone [https://github.com/avilsmeier/votacion_URBISOL.git](https://github.com/avilsmeier/votacion_URBISOL.git)
cd votacion_URBISOL
npm install

```

Crear archivo `.env` basado en `.env.sample`:

```

DATABASE_URL=postgres://user:pass@localhost:5432/votacion
SESSION_SECRET=clave_larga_segura
MAIL_HOST=smtp...
MAIL_USER=...
MAIL_PASS=...
MAIL_FROM=...

```

Migrar base de datos.

Ejecutar:

```

node src/server.js

```

Producción recomendada con:

```

pm2 start src/server.js --name votacion

```

---

# 🧪 Verificación Técnica

Para verificar una campaña:

```

node scripts/verify_chain.mjs 1

```

Salida esperada:

```

✔ Cadena íntegra
✔ Hash global coincide

```

---

# 🔒 Consideraciones de Seguridad

- Tokens hasheados en DB
- Rate limiting activo
- Sesiones seguras detrás de proxy
- Advisory locks en votos
- Sello criptográfico inmutable
- Auditoría completa
- Cache deshabilitado en PDFs administrativos

---

# 🧠 Limitaciones

- El voto no es anónimo (es nominal por diseño).
- No es sistema electoral estatal.
- Depende de integridad del servidor.
- No incluye cifrado homomórfico.

---

# 🚀 Futuras Mejoras

- Campo `is_sealed` obligatorio
- Bloqueo total tras sellado
- Export auditoría CSV
- Referéndums / preguntas múltiples
- Dockerfile
- Firma digital del hash
- Endpoint público read-only

---

# 🏁 Estado del Proyecto

Versión 1.0

Incluye:

✔ Registro controlado  
✔ Token único  
✔ Voto encadenado  
✔ Sello criptográfico  
✔ Verificación reproducible  
✔ Auditoría trazable  
✔ Acta PDF  
✔ Repo versionado  

Sistema apto para elecciones vecinales privadas.

---

# 📜 Licencia

Uso privado para comunidades vecinales.
Sin garantía para procesos electorales oficiales estatales.
```
