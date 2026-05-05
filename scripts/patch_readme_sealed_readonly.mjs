import fs from "fs";

const file = "README.md";
let s = fs.readFileSync(file, "utf8");
const before = s;

s = s.replace(
  "- cerrar/desactivar campañas.\n",
  "- cerrar/desactivar campañas;\n- activar campañas selladas en modo consulta para revisar resultados, fiscalización, acta y verificación, sin habilitar edición ni votos.\n"
);

s = s.replace(
  "Una campaña sellada no debe reactivarse. Los resultados quedan consultables en histórico.",
  "Una campaña sellada puede activarse nuevamente solo para consulta administrativa: resultados, fiscalización, acta, padrón y verificación. Esa activación no reabre votación, edición de campaña, preguntas, listas, fiscales, solicitudes ni reemisión de enlaces."
);

s = s.replace(
  "## Checklist de prueba punta a punta\n\nAntes de abrir producción real, probar con 2 o 3 usuarios internos:\n\n1. Crear campaña `VOTACION`.\n2. Configurar pregunta y opciones.\n3. Abrir ventana de registro.\n4. Registrar usuario 1.\n5. Registrar usuario 2 con otra unidad.\n6. Registrar mismo DNI en otra propiedad y confirmar que no rompe.\n7. Aprobar individualmente una solicitud.\n8. Aprobar en bloque otra solicitud.\n9. Confirmar correos recibidos.\n10. Abrir enlace antes de la votación y verificar contador.\n11. Abrir enlace durante votación y votar.\n12. Confirmar recibo de voto con opción, hash y código.\n13. Validar voto en `/verificar-voto`.\n14. Reemitir enlace a una solicitud pendiente de voto y confirmar que el link viejo no funciona.\n15. Enviar recordatorio simple a pendientes.\n16. Revisar fiscalización.\n17. Cerrar ventana de votación.\n18. Sellar campaña.\n19. Descargar acta PDF.\n20. Verificar integridad.\n21. Notificar resultados sellados.\n22. Desactivar/cerrar campaña.\n23. Confirmar que el home muestra resultados históricos.",
  "## Checklist mínimo antes de producción\n\nAntes de abrir producción real, validar solo los controles críticos de estabilidad, seguridad, inmutabilidad y transparencia:\n\n1. Login admin/fiscal/viewer.\n2. Crear una campaña de prueba `VOTACION`.\n3. Configurar una pregunta y dos opciones.\n4. Registrar 2 usuarios internos, aprobarlos y confirmar correo de enlace.\n5. Emitir 1 voto y confirmar recibo con código/hash.\n6. Validar el voto en `/verificar-voto`.\n7. Revisar resultados y fiscalización.\n8. Sellar la campaña.\n9. Descargar acta PDF y verificar que muestra resultados/sellos.\n10. Ejecutar verificación de integridad.\n11. Cerrar/desactivar la campaña.\n12. Activar nuevamente la campaña sellada.\n13. Confirmar que acta/resultados/fiscalización/verificación siguen accesibles.\n14. Confirmar que editar campaña, editar preguntas/listas, aprobar solicitudes, reemitir enlaces y votar quedan bloqueados.\n15. Cerrar/desactivar nuevamente la campaña sellada."
);

s = s.replace(
  "- no permite editar la campaña;\n- no debe poder reactivarse;\n- sí permite consultar resultados;",
  "- no permite editar la campaña;\n- no permite editar preguntas, opciones, listas ni fiscales;\n- puede activarse temporalmente solo para consulta administrativa;\n- sí permite consultar resultados;"
);

s = s.replace(
  "- sí permite descargar acta;\n- sí permite verificar integridad;",
  "- sí permite descargar acta;\n- sí permite descargar padrón;\n- sí permite verificar integridad;"
);

const anchor = "- sí permite crear una nueva campaña.\n";
if (s.includes(anchor) && !s.includes("Activar una campaña sellada no reabre votación ni edición.")) {
  s = s.replace(anchor, anchor + "\nActivar una campaña sellada no reabre votación ni edición. Solo la publica como campaña activa de consulta para poder acceder a acta, resultados, fiscalización, padrón y verificación.\n");
}

s = s.replace("- limpieza de scripts históricos de patch;\n", "");

if (s === before) {
  console.log("[OK] README ya estaba alineado o no hubo matches");
} else {
  fs.writeFileSync(file, s);
  console.log("[OK] README actualizado con política de sellado read-only");
}
