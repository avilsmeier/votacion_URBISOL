# Instructivo para Administradores

Guía operativa para miembros del Consejo Directivo con rol `admin`.

## Objetivo

El administrador prepara la campaña, revisa solicitudes, habilita votantes, monitorea el proceso, sella la campaña y publica resultados.

Regla base del sistema:

```text
1 unidad o propiedad habilitada = 1 voto
```

Una misma persona puede representar más de una propiedad, pero cada unidad debe registrarse por separado.

---

## 1. Ingreso al panel

Entrar a:

```text
/admin
```

Usar el correo y clave asignados. Si se recibe una clave temporal, cambiarla o guardarla de forma segura según el procedimiento interno.

---

## 2. Crear campaña

Desde el panel:

```text
Campañas -> Crear nueva campaña
```

Completar:

- título de la campaña;
- tipo de campaña;
- fecha y hora de apertura/cierre de registro;
- fecha y hora de apertura/cierre de votación.

Para consultas internas simples usar tipo:

```text
VOTACION
```

Solo debe existir una campaña activa a la vez.

---

## 3. Configurar pregunta y opciones

Para campañas `VOTACION`, entrar en:

```text
Configurar votación
```

Cargar:

- pregunta;
- opciones disponibles;
- orden de presentación.

Revisar cuidadosamente el texto antes de abrir votación. Una vez sellada la campaña, no se podrá modificar.

---

## 4. Registro de residentes

Los vecinos se registran desde la página pública de registro.

El sistema recibe solicitudes con estado:

```text
PENDING
```

El sistema no decide automáticamente si alguien está habilitado. El Consejo Directivo debe revisar por fuera del sistema:

- pago al día;
- sanciones administrativas;
- representación válida;
- datos correctos de unidad y contacto.

---

## 5. Revisar solicitudes

Entrar en:

```text
Solicitudes
```

Filtros útiles:

- Pendientes;
- Aprobadas;
- Rechazadas;
- Todas.

Si una solicitud aparece con alerta de duplicado, significa que existe otra solicitud pendiente o aprobada para la misma unidad.

Regla operativa actual:

- se permiten solicitudes duplicadas para revisión;
- no se permite aprobar dos solicitudes de la misma unidad;
- si ya hay una solicitud aprobada, la segunda debe rechazarse salvo que se defina un procedimiento formal posterior.

---

## 6. Aprobar solicitud

Al aprobar una solicitud, el sistema:

- cambia la solicitud a `APPROVED`;
- genera un enlace personal de votación;
- guarda solo el hash del token;
- envía el enlace por correo;
- muestra el enlace en pantalla como respaldo manual;
- registra auditoría y notificación.

El enlace es personal, único y solo sirve para esa unidad.

---

## 7. Rechazar solicitud

Al rechazar una solicitud, se puede indicar un motivo.

El sistema:

- cambia la solicitud a `REJECTED`;
- envía correo de rechazo si hay email;
- registra la acción en auditoría;
- registra el intento de notificación.

Usar rechazo para solicitudes duplicadas, datos incorrectos o vecinos no habilitados.

---

## 8. Aprobación en bloque

Desde la lista de pendientes se pueden seleccionar varias solicitudes y usar:

```text
Aprobar seleccionadas y enviar email
```

Recomendación operativa:

- usar primero con una solicitud de prueba;
- luego aprobar grupos pequeños;
- tener en cuenta límites del proveedor SMTP.

Si una unidad ya tiene otra solicitud aprobada, el sistema debe omitir o bloquear la aprobación duplicada.

---

## 9. Reemitir enlace

Usar solo cuando un vecino aprobado perdió el correo o no encuentra su enlace.

La reemisión:

- revoca enlaces anteriores activos;
- genera un enlace nuevo;
- envía correo;
- muestra el link nuevo en pantalla;
- no funciona si la unidad ya votó;
- no funciona si la campaña está sellada.

Nunca se puede recuperar el enlace anterior porque no se guarda en texto plano.

---

## 10. Recordar pendientes

Entrar a:

```text
Recordar pendientes
```

El recordatorio masivo:

- se envía solo a aprobados que aún no votaron;
- no incluye link de votación;
- no cambia tokens;
- solo recuerda que la votación está pendiente.

Esto evita exponer enlaces y reduce riesgo con límites del proveedor de correo.

---

## 11. Monitorear durante la votación

Durante la votación revisar:

- cantidad de aprobados;
- cantidad de votos emitidos;
- fiscalización;
- logs de notificación si alguien reporta que no recibió correo.

Los resultados públicos no deben mostrarse antes del cierre de votación.

---

## 12. Fiscalización básica

Entrar en:

```text
Fiscalización
```

Permite ver detalle de votos individuales:

- unidad;
- nombre;
- DNI/CE;
- email;
- opción votada;
- fecha/hora;
- posición de cadena;
- hash.

La fiscalización debe mostrar una fila por voto real. Si se ven duplicados, no continuar hasta revisar.

---

## 13. Sellar campaña

Al finalizar la votación, usar:

```text
Cerrar y Sellar Campaña
```

El sellado:

- calcula el hash global;
- guarda el sello;
- bloquea nuevos votos;
- bloquea edición de campaña y opciones;
- permite verificar integridad después.

Después del sellado, descargar y revisar el acta.

---

## 14. Acta, padrón y resultados

Desde el panel:

- Padrón PDF;
- Acta PDF;
- Resultados;
- Export CSV si corresponde.

El acta debe mostrar resultados y sello de integridad.

---

## 15. Notificar resultados sellados

Después de sellar y revisar acta/resultados, se puede usar:

```text
Notificar resultados sellados
```

El correo incluye resumen de resultados, enlace y sello/hash.

---

## 16. Campañas selladas

Una campaña sellada puede activarse solo para consulta.

Activar una campaña sellada permite revisar:

- resultados;
- fiscalización;
- acta;
- padrón;
- verificación.

No permite:

- votar;
- aprobar solicitudes;
- reemitir enlaces;
- editar campaña;
- editar pregunta/opciones;
- sellar de nuevo con cambios.

---

## Checklist final antes de producción

Antes de abrir a vecinos:

1. Crear campaña de prueba.
2. Registrar dos unidades.
3. Aprobar una solicitud.
4. Confirmar email de aprobación.
5. Votar.
6. Confirmar recibo de voto.
7. Validar voto en `/verificar-voto`.
8. Revisar fiscalización.
9. Sellar.
10. Revisar acta.
11. Ejecutar verificación de integridad.
12. Confirmar que campaña sellada bloquea edición y votos.

---

## Regla de emergencia

Si aparece un error durante producción:

1. No borrar datos manualmente.
2. Tomar captura del error.
3. Revisar `journalctl`.
4. Revisar `notification_log` y `audit_log`.
5. No reemitir enlaces masivamente sin confirmar causa.

Comando útil:

```bash
journalctl -u votacion -n 100 --no-pager
```
