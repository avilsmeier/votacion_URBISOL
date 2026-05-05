# Instructivo para Fiscales

Guía para usuarios con rol `fiscal`.

## Objetivo

El fiscal puede consultar resultados, revisar votos individuales, verificar sellos y exportar información para control. El rol fiscal no modifica campañas ni habilita votantes.

El sistema es trazable por diseño: permite ver qué voto quedó registrado para cada unidad habilitada.

---

## 1. Ingreso

Entrar a:

```text
/admin
```

Usar el correo y clave asignados.

El rol fiscal puede acceder a vistas de consulta y fiscalización. No puede aprobar solicitudes, crear campañas, editar preguntas ni sellar.

---

## 2. Qué puede revisar un fiscal

El fiscal puede revisar:

- campañas activas o históricas;
- resultados;
- detalle de votos individuales;
- acta PDF;
- padrón PDF si está disponible;
- sellos de integridad;
- export CSV de fiscalización.

---

## 3. Entrar a fiscalización

Desde el panel, usar:

```text
Fiscalización
```

Luego seleccionar la campaña correspondiente.

Para cada voto debe verse:

- unidad o propiedad;
- nombre del votante registrado;
- DNI/CE;
- correo;
- opción votada;
- fecha y hora;
- posición en cadena;
- hash del voto.

---

## 4. Qué revisar durante la votación

Durante el proceso, revisar que:

- la cantidad de votos suba de forma coherente;
- no aparezcan votos duplicados para la misma unidad;
- las posiciones de cadena sean correlativas: `1, 2, 3...`;
- cada fila corresponda a una unidad habilitada.

Si aparece algo extraño, avisar al administrador antes de que se selle la campaña.

---

## 5. Qué revisar después del cierre

Después de cerrar y sellar la campaña, revisar:

1. Resultados publicados.
2. Acta PDF.
3. Cantidad total de votos.
4. Detalle de fiscalización.
5. Sello o hash de integridad.
6. Export CSV si se requiere respaldo.

---

## 6. Exportar fiscalización

La vista de fiscalización permite descargar CSV.

Ese archivo sirve para control interno y respaldo documental.

Recomendación: conservar una copia junto con el acta firmada.

---

## 7. Verificación de integridad

La verificación confirma que la cadena de votos coincide con el sello guardado al cierre.

Si el administrador ejecuta la verificación técnica, el resultado esperado es que coincida el hash global.

La verificación protege contra cambios posteriores al sellado.

---

## 8. Limitaciones del rol fiscal

El fiscal no puede:

- crear campañas;
- editar campañas;
- modificar preguntas u opciones;
- aprobar o rechazar solicitudes;
- reemitir enlaces;
- enviar recordatorios;
- sellar campañas;
- crear usuarios.

Si necesita que se corrija algo, debe solicitarlo al administrador.

---

## 9. Señales de alerta

Reportar inmediatamente si se observa:

- más de un voto para la misma unidad;
- posiciones de cadena salteadas;
- resultados visibles antes del cierre de votación;
- acta sin sello;
- diferencia entre resultados y fiscalización;
- votos asociados a datos de residente incorrectos.

---

## 10. Criterio operativo

El fiscal no debe modificar el proceso. Su función es observar, verificar y dejar constancia.

Si hay duda sobre un voto, usar el detalle de fiscalización, hash, posición de cadena, unidad y registro asociado para revisarlo con el Consejo Directivo.
