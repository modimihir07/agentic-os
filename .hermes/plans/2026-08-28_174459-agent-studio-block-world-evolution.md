# Agent Studio Block World & Evolution Mode Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Transformar Agent Studio en una experiencia visual tipo LEGO/Minecraft donde cada skill se entiende como un bloque de “superpoder”, el usuario ve qué aporta al agente y cómo participa en su workflow, y el botón **Evolucionar agente** abre un modo de composición seguro para modificar un perfil Hermes existente.

**Architecture:** Mantener FastAPI + SPA vanilla y reutilizar la transacción ya desplegada de Agent Studio (`preview → HMAC → confirmación exacta → backup validado → apply → verificación → rollback`). Añadir una capa semántica no técnica sobre el catálogo de skills y un `Power Map` explicativo con bloques y conexiones tipadas. En el MVP el mapa explica composición y flujo esperado; no ejecuta automáticamente skills ni convierte `SKILL.md` en funciones invocables.

**Tech Stack:** FastAPI, Python stdlib, JavaScript/CSS/SVG existentes, HTML5 drag-and-drop/pointer events accesibles, JSON determinista, suite `unittest`, Caddy y `agentic-os.service` existentes.

---

## 1. Resultado de producto

### Nueva promesa de Agent Studio

La pantalla debe responder, sin exigir conocimiento técnico:

1. **¿Quién es este agente?** — identidad, misión, personalidad y límites.
2. **¿Cuáles son sus superpoderes?** — skills explicadas por resultado, no por estructura de archivos.
3. **¿Qué aporta cada superpoder?** — entrada, transformación, resultado, requisitos y límites.
4. **¿Cómo trabajan juntos?** — mapa visual de preparación → análisis → creación → revisión → entrega.
5. **¿Qué cambiará si lo evoluciono?** — comparación antes/después, readiness e impacto.
6. **¿Puedo probar sin arriesgar Hermes?** — sandbox visual sin escritura hasta confirmación final.

### Metáfora de interfaz

- **Mundo / habitación:** el perfil Hermes real.
- **Bloques:** skills aprobadas y capacidades nativas.
- **Superpoder:** beneficio entendible para la persona.
- **Loadout:** hasta cinco capacidades destacadas; no limita todas las skills instaladas.
- **Power Map:** explicación visual de cómo se combinan las capacidades.
- **Blueprint:** borrador de evolución todavía no aplicado.
- **Construir evolución:** preview transaccional, no ejecución del workflow.
- **Estado del bloque:** disponible, equipado, requiere configuración, sólo lectura o no compatible.

No usar XP, niveles o afirmaciones ficticias. La evolución se basa en evidencia real: skill presente, configuración requerida detectada, gateway/modelo conocido, preview válido y apply verificado.

---

## 2. Alcance del MVP

### Incluido

1. **Modo Evolución real** al pulsar `Evolucionar agente`.
2. **Paleta de bloques** con skills aprobadas, búsqueda y filtros no técnicos.
3. **Ficha de superpoder** para cada skill:
   - qué permite conseguir;
   - cuándo usarla;
   - qué necesita como entrada;
   - qué produce;
   - qué aporta al perfil;
   - requisitos/configuración;
   - límites y acciones sensibles;
   - estado real: instalada, lista, requiere setup o sólo diseño.
4. **Power Map** explicativo con bloques conectados en una secuencia visual.
5. **Loadout principal** de hasta cinco superpoderes destacados.
6. **Plantillas de composición** por objetivo:
   - Investigar y decidir.
   - Crear y publicar con aprobación.
   - Operar un proceso repetible.
   - Analizar y reportar.
   - Preparar y apoyar ventas.
7. **Inspector contextual** al seleccionar un bloque.
8. **Preview antes/después** de identidad, skills, loadout y Power Map.
9. **Apply transaccional existente**, ampliado para metadata visual gobernada.
10. **Perfiles protegidos** visibles pero sin evolución ni mutación.
11. **Accesibilidad móvil/escritorio**, teclado y reducción de movimiento.

### Fuera del MVP

- Ejecutar workflows automáticamente desde el canvas.
- Convertir cualquier `SKILL.md` en una función callable.
- Instalar skills de terceros o marketplace remoto.
- Comprar/vender skills o implementar moneda.
- Motor 3D, mundo multijugador o física tipo Minecraft.
- Configurar secretos, tokens, gateways o modelos desde el mapa.
- Borrar/renombrar perfiles desde Evolution Mode.
- React Flow/Xyflow u otra dependencia nueva.

`YAGNI:` primero se construye un **mapa explicativo y componible**. Un runner real sólo se añade después de contratos de puertos, adapters, aprobaciones y auditoría de ejecución.

---

## 3. Modelo semántico de un bloque

Cada skill debe exponerse al frontend mediante un contrato saneado:

```json
{
  "id": "research/arxiv",
  "name": "Investigación académica",
  "category": "Descubrir",
  "icon": "🔎",
  "superpower": "Encuentra y compara evidencia académica relevante.",
  "contribution": "Mejora la calidad de las decisiones al aportar fuentes verificables.",
  "use_when": ["Necesitas evidencia", "Quieres comparar enfoques"],
  "inputs": [{"id": "question", "label": "Pregunta", "type": "text"}],
  "outputs": [{"id": "evidence", "label": "Evidencia", "type": "research_bundle"}],
  "workflow_steps": ["Buscar", "Filtrar", "Comparar", "Citar"],
  "requirements": ["Acceso a Internet"],
  "side_effects": "none",
  "readiness": "available",
  "readiness_reason": "Disponible en el catálogo aprobado",
  "source": "approved-local",
  "studio_mutable": true
}
```

### Reglas de verdad

- `installed` significa físicamente presente en el perfil.
- `available` significa presente en catálogo aprobado.
- `ready` sólo se usa si los requisitos verificables están satisfechos.
- `requires_setup` debe mostrar los nombres de requisitos, nunca valores secretos.
- `design_only` indica que el bloque explica un procedimiento, pero no tiene adapter ejecutable.
- `side_effects` puede ser `none`, `read`, `write`, `send`, `publish`, `delete` o `unknown`.
- Si falta metadata, usar fallback conservador:
  - `any → structured`;
  - `design_only`;
  - contribución derivada de la descripción, sin inventar resultados;
  - acciones sensibles como `unknown`.

### Fuente de metadata

Orden de precedencia:

1. Frontmatter opcional gobernado en `SKILL.md` (`capability`, `inputs`, `outputs`, `side_effects`, `requirements`).
2. Catálogo local curado en `dashboard/data/skill-capabilities.json` para skills prioritarias.
3. Inferencia determinista conservadora desde nombre, categoría y descripción.
4. Fallback genérico explícito; nunca inferencia LLM en tiempo de carga del panel.

---

## 4. Arquitectura UX

### 4.1 Vista normal: habitación del agente

Mantener la vista actual, pero añadir:

- Botón primario: **Evolucionar agente**.
- Resumen de superpoderes principales.
- Mini Power Map de sólo lectura.
- Readiness:
  - Identidad.
  - Superpoderes.
  - Modelo.
  - Configuración pendiente.
  - Aprobaciones requeridas.

### 4.2 Evolution Mode: “mesa de construcción”

Al pulsar el botón, cambiar a una superficie de tres paneles:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ EVOLUTION MODE   Blueprint sin aplicar      [Salir] [Revisar evolución] │
├───────────────────┬───────────────────────────────┬─────────────────────┤
│ BLOQUES           │ POWER MAP                     │ INSPECTOR           │
│ Buscar objetivo   │                               │ Superpoder          │
│                   │ [Entrada] → [Skill] → [Salida]│ Qué aporta          │
│ Descubrir         │                ↓              │ Entradas/salidas    │
│ Pensar            │             [Revisión]        │ Requisitos          │
│ Crear             │                               │ Límites             │
│ Comunicar         │ + Añadir bloque compatible    │ [Equipar/Retirar]   │
│ Proteger          │                               │                     │
├───────────────────┴───────────────────────────────┴─────────────────────┤
│ 3 cambios pendientes · readiness 80%   [Descartar] [Revisar evolución] │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Paleta no técnica

Agrupar por intención humana, no por carpetas:

- **Descubrir** — buscar, investigar, escuchar, recopilar.
- **Pensar** — analizar, comparar, decidir, calcular.
- **Crear** — escribir, diseñar, programar, producir.
- **Comunicar** — presentar, enviar, publicar, coordinar.
- **Organizar** — planificar, documentar, calendarizar, dar seguimiento.
- **Proteger** — revisar, aprobar, validar derechos, presupuesto o seguridad.

Cada bloque muestra:

- Icono y nombre humano.
- Una frase de superpoder.
- “Aporta al agente…”
- Estado real.
- Badge `LECTURA`, `ESCRITURA`, `REQUIERE APROBACIÓN` o `DISEÑO`.
- Botón `Añadir al agente`, no “instalar paquete”.

### 4.4 Power Map

El mapa debe ser legible antes que sofisticado:

- Layout por columnas: **Entrada → Trabajo → Control → Resultado**.
- Bloques movibles dentro de la zona de trabajo.
- Conectores tipados visibles.
- Compatibilidad determinada localmente.
- Si dos bloques no son compatibles, explicar por qué.
- Botón `+` entre bloques para inserción contextual.
- En móvil, representar el flujo como lista vertical ordenable.
- El mapa no promete ejecución; encabezado visible: `Mapa de capacidades · no ejecuta acciones`.

### 4.5 Inspector

Tabs:

- **Superpoder:** resultado y contribución.
- **Cómo funciona:** workflow_steps en lenguaje simple.
- **Necesita:** entradas, configuración y setup.
- **Entrega:** outputs y artefactos.
- **Seguridad:** side effects y aprobaciones.
- **Detalles:** ID técnico, procedencia y contenido de `SKILL.md` bajo disclosure avanzado.

### 4.6 Review de evolución

Antes de aplicar, mostrar:

- Avatar/nombre y perfil exacto.
- SOUL antes/después.
- Superpoderes añadidos/retirados.
- Loadout antes/después.
- Power Map antes/después.
- Configuración pendiente.
- Acciones que siguen bloqueadas.
- Confirmación exacta del perfil.
- Mensaje explícito: `Todavía no se ha modificado Hermes`.

---

## 5. Persistencia y transacción

### Metadata visual gobernada

Guardar para perfiles compatibles en:

```text
<profile_home>/.agent-playground/avatar.json
```

Ampliar el schema de forma backward-compatible:

```json
{
  "schema_version": 2,
  "display_name": "Luma",
  "archetype": "explorer",
  "appearance": {},
  "communication": {},
  "mission": "...",
  "boundaries": [],
  "equipped_skills": ["research/arxiv"],
  "loadout": ["research/arxiv"],
  "power_map": {
    "version": 1,
    "nodes": [{"id": "n1", "capability_id": "research/arxiv", "x": 320, "y": 160}],
    "edges": [{"id": "e1", "source": "trigger", "source_port": "request", "target": "n1", "target_port": "question"}]
  }
}
```

### Invariantes

- No guardar rutas absolutas, secretos o contenido completo de skills en metadata.
- IDs de nodo únicos y límites de cantidad/tamaño.
- Sólo capacidades del catálogo aprobado o ya instaladas.
- Edges sólo entre puertos compatibles.
- El Power Map puede estar incompleto como borrador, pero no se presenta como workflow ejecutable.
- `default` y `agentic-os`: lectura solamente.
- Toda mutación usa el lock compartido existente.
- `expected_revision` debe incorporar SOUL, skills y metadata visual.
- `preview_token` HMAC debe ligar exactamente SOUL, add/remove, loadout y power_map.
- Backup validado contra manifiesto antes de mutar.
- Apply verifica read-back de SOUL, skills y metadata.
- Rollback conserva cuarentenas y evita clobber, igual que Agent Studio 0.6.0.

### Endpoints

Extender los actuales sin duplicar la transacción:

```text
GET  /api/hermes/profiles/{name}/studio
GET  /api/hermes/profiles/{name}/studio/capabilities
POST /api/hermes/profiles/{name}/studio/evolution/validate
POST /api/hermes/profiles/{name}/studio/preview
POST /api/hermes/profiles/{name}/studio/apply
```

`studio` incluirá metadata y Power Map saneados. `capabilities` devolverá el catálogo enriquecido. `validate` será no mutante y devolverá compatibilidad, warnings y readiness. `preview/apply` conservarán el protocolo existente y aceptarán los nuevos campos.

---

## 6. Plan de implementación por tareas

### Task 1: Congelar contratos actuales y añadir tests RED del Evolution Mode

**Objective:** Proteger Agent Studio 0.6.0 y definir el comportamiento visible nuevo antes de implementarlo.

**Files:**
- Modify: `tests/test_agent_studio.py`
- Create: `tests/test_agent_block_world.py`
- Modify: `tests/run_all.py`

**Steps:**
1. Añadir fixtures con skills de lectura, escritura, diseño y setup pendiente.
2. Escribir test RED que exija metadata de superpoder saneada.
3. Escribir test RED que exija que `Evolucionar agente` abra `Evolution Mode`, no sólo la pestaña SOUL.
4. Escribir test RED para paleta, Power Map, Inspector y review.
5. Escribir test RED para perfiles protegidos en modo lectura.
6. Ejecutar:
   ```bash
   .venv/bin/python -m unittest tests.test_agent_block_world -v
   ```
   Expected: FAIL por endpoints/UI aún ausentes.
7. Commit propuesto: `test(profiles): define block world evolution contracts`.

### Task 2: Crear el catálogo semántico de superpoderes

**Objective:** Convertir skills técnicas en bloques comprensibles sin inventar capacidades.

**Files:**
- Create: `capability_catalog.py`
- Create: `dashboard/data/skill-capabilities.json`
- Modify: `agent_studio.py`
- Test: `tests/test_agent_block_world.py`

**Steps:**
1. Implementar schema allowlisted y normalizador CRLF/frontmatter.
2. Añadir categorías humanas, iconos, superpower, contribution, inputs, outputs, readiness y side effects.
3. Curar inicialmente 15–20 skills prioritarias; el resto usa fallback conservador.
4. Exponer sólo nombres de requisitos/credenciales, nunca valores.
5. Añadir deduplicación por ID + hash de contenido.
6. Añadir `GET .../studio/capabilities` protegido por admin token.
7. Probar secretos, frontmatter inválido, symlinks y metadata exagerada.
8. Commit propuesto: `feat(profiles): add governed capability block catalog`.

### Task 3: Definir y validar el Power Map

**Objective:** Representar composición y workflow esperado con nodos/puertos tipados, sin ejecución.

**Files:**
- Create: `power_map.py`
- Modify: `agent_studio.py`
- Test: `tests/test_agent_block_world.py`

**Steps:**
1. Definir schema de nodes, edges, typed ports y layout.
2. Validar límites: máximo 40 nodos, 80 edges y payload de 100 KiB.
3. Rechazar IDs duplicados, edges colgantes, ciclos no declarados y puertos incompatibles.
4. Permitir borradores incompletos con warnings; marcar `executable: false` siempre en MVP.
5. Implementar readiness y explicaciones de compatibilidad.
6. Añadir plantillas deterministas de composición.
7. Probar payloads malformados, capabilities desconocidas y datos técnicos/secretos.
8. Commit propuesto: `feat(profiles): add validated capability power maps`.

### Task 4: Integrar metadata visual en preview/apply/rollback

**Objective:** Hacer que loadout y Power Map se guarden bajo la misma transacción segura de SOUL y skills.

**Files:**
- Modify: `agent_studio.py`
- Modify: `playground.py`
- Modify: `profile_backup.py`
- Test: `tests/test_agent_block_world.py`
- Test: `tests/test_agent_studio.py`

**Steps:**
1. Extender `expected_revision` para incluir metadata normalizada.
2. Extender HMAC del preview con `loadout` y `power_map` exactos.
3. Crear staging privado de metadata y publicar con no-clobber/ownership.
4. Verificar backup contra manifiesto incluyendo `.agent-playground/avatar.json` si existe.
5. Verificar read-back exacto tras apply.
6. Añadir rollback y cuarentena para escritores concurrentes.
7. Mantener compatibilidad con schema_version 1.
8. Probar sustitución concurrente antes/después de publicación y descriptors abiertos.
9. Confirmar que ningún endpoint toca gateway, modelo, `.env`, cron o plugins.
10. Commit propuesto: `feat(profiles): transact agent evolution blueprints`.

### Task 5: Construir Evolution Mode y paleta de bloques

**Objective:** Activar el botón y entregar la experiencia de construcción visual.

**Files:**
- Modify: `dashboard/pages/profiles.js`
- Modify: `dashboard/styles.css`
- Test: `tests/test_agent_block_world.py`

**Steps:**
1. Añadir estado explícito `mode: view|evolve|review` y blueprint separado del estado persistido.
2. Cambiar `studioEvolve` para abrir la mesa de construcción.
3. Implementar paleta categorizada por intención humana.
4. Implementar bloque con superpoder, contribución, estado y side effects.
5. Añadir filtros: objetivo, instalado, listo, setup pendiente, lectura/escritura.
6. Implementar inspector tabs y disclosure técnico avanzado.
7. Añadir plantillas de composición.
8. Mantener guardas de navegación y borrador existentes.
9. Añadir empty/loading/error states sin borrar blueprint.
10. Commit propuesto: `feat(profiles): activate block-based evolution mode`.

### Task 6: Construir Power Map responsive y accesible

**Objective:** Mostrar cómo colaboran las capacidades y permitir composición básica sin framework nuevo.

**Files:**
- Create: `dashboard/pages/profile-power-map.js`
- Modify: `dashboard/pages/profiles.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/styles.css`
- Test: `tests/test_agent_block_world.py`

**Steps:**
1. Renderizar nodos SVG/HTML con INPUT/OUTPUT y labels permanentes.
2. Implementar selección, mover bloque y Quick Add contextual.
3. Usar el mismo resolver de compatibilidad para preview y commit de edge.
4. Añadir undo/redo local limitado a 30 operaciones.
5. Añadir navegación por teclado y botones alternativos a drag-and-drop.
6. En móvil, transformar el mapa en lista vertical reordenable.
7. Respetar `prefers-reduced-motion`.
8. Mostrar banner permanente `Mapa de capacidades · no ejecuta acciones`.
9. Commit propuesto: `feat(profiles): add responsive capability power map`.

### Task 7: Review “antes/después” y apply seguro

**Objective:** Conectar el blueprint visual al protocolo transaccional real sin degradar garantías.

**Files:**
- Modify: `dashboard/pages/profiles.js`
- Modify: `agent_studio.py`
- Test: `tests/test_agent_block_world.py`
- Test: `tests/test_agent_studio.py`

**Steps:**
1. Mostrar diff de SOUL, skills, loadout y Power Map.
2. Mostrar warnings de setup y side effects.
3. Exigir confirmación exacta del perfil.
4. Aplicar sólo usando el preview_token correspondiente al blueprint exacto.
5. Conservar blueprint si aparece 409 por cambio externo.
6. Ofrecer `Recargar estado` y `Comparar con cambios externos`.
7. Tras éxito, volver a la habitación y mostrar evidencia verificada.
8. Probar que modificar el blueprint después del preview invalida apply.
9. Commit propuesto: `feat(profiles): review and apply agent evolution safely`.

### Task 8: QA visual y accesibilidad

**Objective:** Verificar que la metáfora visual sea comprensible y usable.

**Files:**
- Modify según hallazgos: `dashboard/styles.css`, `dashboard/pages/profiles.js`, `dashboard/pages/profile-power-map.js`
- Test: `tests/test_agent_block_world.py`

**Steps:**
1. Levantar instancia aislada con Hermes home temporal.
2. Probar escritorio 1440×900, tablet 1024×768 y móvil 390×844.
3. Recorrer sólo con teclado: abrir Evolution, añadir bloque, inspeccionar, deshacer, review y salir.
4. Verificar contraste, focus visible, targets ≥ 20 px y scroll interno.
5. Confirmar que no hay crecimiento vertical explosivo del documento.
6. Verificar consola sin errores propios de la app.
7. Probar reducción de movimiento.
8. Probar con catálogo grande, nombres largos y cero skills.
9. Commit propuesto: `fix(profiles): polish evolution mode ux and accessibility`.

### Task 9: Suite integral, revisión independiente y E2E real aislado

**Objective:** Probar que el nuevo Studio no afecta Hermes operativo.

**Files:**
- No cambios salvo correcciones derivadas de revisión.

**Steps:**
1. Ejecutar:
   ```bash
   .venv/bin/python tests/run_all.py
   python3 -m py_compile agent_studio.py capability_catalog.py power_map.py profile_backup.py profile_lock.py profile_hub.py playground.py
   node --check dashboard/pages/profiles.js
   node --check dashboard/pages/profile-power-map.js
   git diff --check
   ```
2. Solicitar revisión independiente de seguridad, concurrencia, UX y claims.
3. Crear un perfil Hermes temporal con gateway detenido.
4. Capturar lista de gateways antes.
5. Abrir Studio, montar blueprint, preview, apply, verificar SOUL/skill/metadata.
6. Confirmar que `.env`, modelo, gateway, cron y plugins no cambiaron.
7. Probar rollback inducido y cuarentena.
8. Eliminar perfil, backups y snapshots temporales.
9. Comparar gateways antes/después; deben ser idénticos.
10. No hacer push.

### Task 10: Despliegue controlado

**Objective:** Publicar únicamente después de aprobar todos los gates.

**Files:**
- Commit de los archivos aprobados.

**Steps:**
1. Crear commit local firmado; no push.
2. Reiniciar únicamente `agentic-os.service`.
3. Esperar readiness local en `127.0.0.1:8788`.
4. Verificar versión nueva en OpenAPI.
5. Verificar borde público:
   - sin Basic Auth → 401;
   - con Basic Auth → 200;
   - sin admin token en Profile API → 401;
   - con ambas barreras → 200.
6. Verificar `#profiles`, assets cache-busted y Evolution Mode real.
7. Repetir gateway diff y limpieza.
8. Entregar URL y evidencia; no reproducir secretos.

---

## 7. Archivos previstos

### Nuevos

- `capability_catalog.py`
- `power_map.py`
- `dashboard/data/skill-capabilities.json`
- `dashboard/pages/profile-power-map.js`
- `tests/test_agent_block_world.py`

### Modificados

- `agent_studio.py`
- `playground.py`
- `profile_backup.py`
- `dashboard/pages/profiles.js`
- `dashboard/styles.css`
- `dashboard/index.html`
- `tests/test_agent_studio.py`
- `tests/test_agent_playground.py`
- `tests/run_all.py`

### No tocar

- Perfiles Hermes reales durante desarrollo unitario.
- `.env`, `auth.json`, tokens o credenciales.
- Gateways existentes.
- `config.yaml` desde el navegador.
- Caddy salvo que el bundle/asset routing lo exija; no se espera cambio.

---

## 8. Criterios de aceptación

1. Pulsar **Evolucionar agente** abre Evolution Mode completo.
2. Una persona puede añadir una skill sin ver rutas, YAML o archivos.
3. Cada bloque explica superpoder y contribución al agente.
4. Cada bloque distingue presencia, readiness, setup y ejecución real.
5. El Power Map muestra entradas, transformaciones, controles y resultados.
6. El mapa indica explícitamente que no ejecuta acciones en el MVP.
7. Una incompatibilidad se bloquea y se explica.
8. Skills con side effects muestran aprobación requerida.
9. El usuario puede deshacer cambios locales antes del preview.
10. Navegar no pierde el blueprint sin confirmación.
11. Review compara antes/después de SOUL, skills, loadout y mapa.
12. Apply requiere revisión vigente, preview HMAC y confirmación exacta.
13. Backup se valida contra manifiesto antes de escribir.
14. Read-back confirma skills y metadata tras apply.
15. Rollback no sobrescribe cambios concurrentes.
16. `default` y `agentic-os` son lectura solamente en todas las superficies.
17. Ninguna evolución toca gateway, modelo, `.env`, cron o plugins.
18. La suite actual sigue verde junto con los nuevos tests.
19. QA visual aprueba escritorio y móvil sin overflow ni controles inaccesibles.
20. E2E confirma que la lista de gateways antes/después es idéntica.
21. No quedan perfiles, backups o snapshots de prueba.
22. No se hace push sin autorización explícita.

---

## 9. Riesgos y mitigaciones

- **Gamificación engañosa:** usar readiness y evidencia reales, no niveles ficticios.
- **Skill ≠ función ejecutable:** marcar `design_only` y mantener el mapa explicativo.
- **Metadata insuficiente:** fallback conservador y catálogo curado, sin inferencia improvisada.
- **Complejidad visual:** progressive disclosure; UX humana primero, detalles técnicos bajo Inspector.
- **Catálogo grande:** búsqueda completa, scroll interno y `content-visibility`.
- **Pérdida de borrador:** state separado, guardas de navegación y undo/redo.
- **Payload manipulado:** schema allowlist, límites y HMAC ligado al blueprint exacto.
- **Concurrencia externa:** revisión optimista, lock compartido, no-clobber y cuarentenas.
- **Namespaces anidados:** sólo lectura en operaciones ambiguas.
- **Acciones sensibles ocultas:** badges y gates visibles en bloque, Inspector y review.
- **Regresión de Hermes:** pruebas aisladas primero, perfil temporal real después y gateway diff obligatorio.

---

## 10. Fases de entrega

### Entrega A — Bloques entendibles

- Catálogo semántico.
- Superpoder y contribución.
- Evolution Mode activado.
- Paleta e Inspector.
- Sin persistir Power Map todavía.

**Evidencia:** cinco usuarios no técnicos pueden explicar qué aporta cada bloque.

### Entrega B — Power Map

- Workflow explicativo.
- Compatibilidad.
- Plantillas.
- Undo/redo.
- Mobile flow.

**Evidencia:** el usuario puede explicar el recorrido entrada → resultado de su agente.

### Entrega C — Evolución transaccional

- Persistencia de loadout/mapa.
- Review antes/después.
- Apply/rollback.
- QA pública.

**Evidencia:** perfil temporal evoluciona y se restaura sin alterar gateways ni secretos.

---

## Acción mínima tangible

Implementar primero únicamente la **Entrega A** sobre una instancia aislada:

1. Pulsar `Evolucionar agente`.
2. Ver paleta de bloques.
3. Seleccionar una skill.
4. Entender su superpoder y contribución.
5. Añadirla a un blueprint local.
6. Salir sin escribir nada.

Esto valida la metáfora LEGO/Minecraft antes de ampliar la transacción o construir un runner innecesario.
