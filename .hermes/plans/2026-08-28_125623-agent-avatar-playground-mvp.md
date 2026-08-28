# Agent Avatar Playground MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Convertir la creación técnica de perfiles Hermes en una experiencia visual tipo “incubadora de avatares”, donde una persona diseña la identidad de su agente, elige un arquetipo, equipa un pequeño set de skills y lo crea de forma segura como un perfil Hermes real.

**Architecture:** Mantener FastAPI + SPA vanilla. Añadir un router independiente `playground.py` que componga el CLI oficial de Hermes, un catálogo controlado de arquetipos/skills y metadatos visuales por perfil. El frontend será un wizard 2D ligero con vista previa en vivo; no se añadirá motor 3D, economía, multijugador ni generación de imágenes en el MVP.

**Tech Stack:** FastAPI/Pydantic existentes, Python stdlib, Hermes CLI, JavaScript/CSS/SVG sin framework nuevo, JSON atómico para metadatos visuales y la suite `unittest` existente.

---

## 1. Visión de producto

### La idea central

El usuario no debería sentir que está rellenando un formulario administrativo. Debería sentir que está “dando vida” a un compañero digital:

1. Elige cómo se ve.
2. Decide para qué existe.
3. Escoge su clase o arquetipo inicial.
4. Equipa sus primeras habilidades.
5. Revisa su ficha.
6. Pulsa **Crear agente** y aparece en su propio espacio.

### Qué tomamos de los juegos

| Inspiración | Patrón útil | Aplicación a agentes |
|---|---|---|
| Tamagotchi | vínculo, estado visible, cuidado | avatar, salud del perfil, evolución verificable |
| The Sims | creador de personaje y rasgos | apariencia, estilo comunicativo, personalidad configurable |
| GTA / Free Fire | loadout claro | herramientas y skills equipadas, sin copiar combate ni estética violenta |
| Minecraft | construcción modular | bloques de conocimiento, skills y fuentes que se agregan progresivamente |
| Age of Empires | árbol de progresión | capacidades desbloqueadas por hitos reales y revisados |

### Principio de diseño

La capa de juego representa capacidades reales; no inventa poder, experiencia ni rendimiento.

- Un avatar “nivel 5” no significa que sea inteligente por decreto.
- El progreso debe provenir de evidencia: configuración completa, skills verificadas, fuentes aprobadas, pruebas superadas y trabajos validados.
- El usuario conserva control humano sobre credenciales, gateways, automatizaciones y acciones destructivas.

---

## 2. Reformulación del módulo actual

### Estado actual

`dashboard/pages/profiles.js` y `profile_hub.py` ofrecen un CRUD administrativo funcional:

- listar perfiles;
- crear nombre y descripción;
- editar descripción;
- renombrar;
- respaldar;
- eliminar con confirmación;
- proteger `default` y `agentic-os`.

### Bloqueo de experiencia

El sistema actual pregunta “nombre y descripción”, pero no ayuda a pensar:

- qué misión tendrá el agente;
- cómo debería comportarse;
- qué skills necesita realmente;
- qué capacidades no debe tener;
- qué identidad visual lo hace reconocible;
- qué evidencia demostrará que está listo.

### Reformulación

El CRUD seguirá existiendo como “modo administrador”. El nuevo **Playground** será la capa guiada para crear agentes. Ambos terminarán utilizando el mismo backend seguro y el CLI oficial de Hermes.

---

## 3. Alcance básico del MVP

### Incluido

1. Nueva navegación: **Agent Playground**.
2. Wizard de cinco pasos con progreso visible.
3. Avatar 2D compuesto con piezas predefinidas:
   - forma/base;
   - color primario;
   - rostro/expresión;
   - accesorio;
   - fondo/bioma.
4. Cinco arquetipos iniciales:
   - Explorador;
   - Constructor;
   - Analista;
   - Creador;
   - Operador.
5. Misión escrita en lenguaje natural.
6. Estilo comunicativo con tres controles simples:
   - conciso ↔ detallado;
   - formal ↔ cercano;
   - reactivo ↔ proactivo con aprobación.
7. Tienda inicial de skills en modo catálogo:
   - búsqueda y categorías;
   - descripción;
   - origen;
   - estado disponible/no disponible;
   - máximo tres skills iniciales.
8. Ficha de agente antes de crearlo.
9. Vista previa determinista de `SOUL.md`; todavía no usa un LLM.
10. Creación transaccional de un perfil Hermes real.
11. Copia de las skills elegidas desde un catálogo aprobado.
12. “Habitación del agente” posterior a la creación:
   - avatar;
   - misión;
   - arquetipo;
   - skills equipadas;
   - modelo, gateway y salud;
   - checklist de preparación.
13. Metadatos visuales aislados por perfil.
14. Auditoría y rollback si el spawn queda incompleto.

### Fuera del MVP

- mundo 3D;
- movimiento libre o mapa multijugador;
- moneda, pagos o marketplace comercial;
- ranking competitivo;
- generación de imágenes por IA;
- compra e instalación remota de skills de terceros;
- MCP, plugins, cron o gateways como “add-ons” instalables;
- puntos de experiencia artificiales;
- agentes que se auto-modifican sin aprobación;
- edición de tokens o secretos desde el Playground.

La tienda básica permite elegir skills aprobadas al crear el agente. La tienda completa y los add-ons quedan para la segunda fase.

---

## 4. Lenguaje del sistema

### Conceptos visuales y su equivalente real

| UX del juego | Objeto real |
|---|---|
| Avatar | metadatos visuales del perfil |
| Nombre | nombre seguro del perfil Hermes |
| Clase/arquetipo | plantilla de misión, tono y starter pack sugerido |
| Skill equipada | skill copiada al home aislado del perfil |
| Inventario | catálogo de skills disponibles, no instaladas |
| Add-on | futura integración MCP/plugin/herramienta |
| Casa/habitación | panel de detalle del perfil |
| Salud | disponibilidad verificable de modelo, configuración y gateway |
| Nivel | futura agregación de hitos comprobables, no antigüedad ni uso |
| Spawn | creación confirmada del perfil con rollback |

### Arquetipos iniciales

Los arquetipos son puntos de partida, no identidades rígidas:

1. **Explorador**
   - investiga, compara fuentes y descubre patrones;
   - sugiere skills de research y navegación.
2. **Constructor**
   - crea software, sistemas y automatizaciones;
   - sugiere skills de desarrollo y DevOps.
3. **Analista**
   - estructura información, calcula y evalúa;
   - sugiere hojas de cálculo, documentos y evaluación.
4. **Creador**
   - convierte ideas en contenido y artefactos;
   - sugiere diseño, video, escritura y presentaciones.
5. **Operador**
   - coordina tareas repetibles y mantiene procesos;
   - sugiere operaciones, mensajería y productividad.

Cada arquetipo debe ser white-label y neutral. No incorpora biografías ficticias ni afirmaciones de experiencia.

---

## 5. Flujo de creación

### Pantalla 0: Plaza de agentes

- Muestra los perfiles actuales como personajes/tarjetas.
- Acciones: “Visitar”, “Administrar” y “Crear agente”.
- `default` y `agentic-os` aparecen como personajes protegidos.

### Paso 1: Apariencia

- Vista previa del avatar en vivo.
- Selector de base, color, rostro, accesorio y bioma.
- Botón “Aleatorio” que sólo combina opciones allowlisted.
- La apariencia no altera permisos ni comportamiento.

### Paso 2: Propósito

Preguntas guiadas:

1. “¿Qué quieres que este agente te ayude a conseguir?”
2. “¿Qué tareas debería hacer muy bien?”
3. “¿Qué no debe hacer sin pedirte permiso?”

El sistema genera una misión resumida, visible y editable. No persiste todavía.

### Paso 3: Arquetipo y personalidad

- Selección de un arquetipo.
- Tres controles de estilo comunicativo.
- Vista previa de una respuesta de ejemplo determinista, sin llamada al modelo.

### Paso 4: Tienda de skills

- Catálogo con búsqueda y categorías.
- Starter pack sugerido según arquetipo.
- Máximo tres skills equipadas en el MVP.
- La UI distingue:
  - “sugerida”;
  - “seleccionada”;
  - “ya instalada”;
  - “no disponible”;
  - “requiere credencial” cuando pueda detectarse sin revelar secretos.
- No hay compras ni instalación remota.

### Paso 5: Ficha y spawn

La ficha muestra:

- avatar;
- nombre técnico y nombre visible;
- misión;
- límites;
- arquetipo;
- estilo;
- skills;
- permisos excluidos;
- advertencia de que se creará un perfil real.

El botón final exige una confirmación explícita: **Crear agente**.

### Resultado: Habitación del agente

Después del spawn:

- muestra su avatar y ficha;
- verifica el perfil real;
- muestra “Preparación inicial”:
  - identidad creada;
  - skills instaladas;
  - modelo presente;
  - gateway detenido/activo;
  - prueba de conversación pendiente/aprobada.

---

## 6. Modelo de datos mínimo

### Metadatos por perfil

Crear dentro del home seguro del perfil:

```text
<profile-home>/.agent-playground/
└── avatar.json
```

Contrato propuesto:

```json
{
  "schema_version": 1,
  "display_name": "Luma",
  "archetype": "explorer",
  "appearance": {
    "base": "orb",
    "primary_color": "violet",
    "face": "curious",
    "accessory": "visor",
    "biome": "library"
  },
  "communication": {
    "detail": "balanced",
    "tone": "warm",
    "initiative": "ask-first"
  },
  "mission": "Investigar oportunidades y convertir evidencia en decisiones claras.",
  "boundaries": [
    "No publicar ni enviar nada sin aprobación"
  ],
  "equipped_skills": [
    "research/arxiv",
    "research/social-post-analysis"
  ],
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

### Reglas

- Escritura atómica y modo `0600`.
- Nunca incluir claves, tokens, IDs privados o contenidos de `.env`.
- Validar todos los enums y longitudes en backend.
- El cliente no envía rutas de filesystem.
- `equipped_skills` sólo acepta IDs entregados por el catálogo del backend.
- `SOUL.md` se genera desde una plantilla determinista revisable.
- Configuración Hermes se cambia únicamente mediante CLI oficial.

---

## 7. Endpoints propuestos

Todos requieren el mismo Admin Token del Profile Hub.

```text
GET  /api/playground/catalog
POST /api/playground/preview
POST /api/playground/spawn
GET  /api/playground/agents/{name}
PATCH /api/playground/agents/{name}/appearance
```

### `GET /api/playground/catalog`

Devuelve únicamente datos saneados:

- arquetipos;
- piezas visuales;
- skills aprobadas;
- categorías;
- requisitos declarados sin valores secretos.

### `POST /api/playground/preview`

- valida el draft;
- normaliza nombre y misión;
- genera ficha y `SOUL.md` en memoria;
- no escribe archivos ni crea perfiles.

### `POST /api/playground/spawn`

Secuencia transaccional:

1. Revalidar draft completo.
2. Confirmar que el nombre no existe.
3. Crear perfil con `hermes profile create --clone-from agentic-os --no-skills`.
4. Aplicar descripción de routing.
5. Escribir el `SOUL.md` determinista.
6. Copiar únicamente las skills aprobadas y seleccionadas.
7. Escribir `avatar.json` atómicamente.
8. Consultar `hermes profile show` para verificar.
9. Registrar auditoría.
10. Si falla cualquier paso, eliminar el perfil parcial y registrar rollback.

No se inicia el gateway automáticamente.

---

## 8. Arquitectura frontend

### Nueva página

Crear:

```text
dashboard/pages/agent-playground.js
```

Estados principales:

```text
plaza → appearance → purpose → archetype → skills → review → room
```

### Componentes lógicos sin framework

- `renderAgentPlaza()`
- `renderAvatarBuilder()`
- `renderPurposeStep()`
- `renderArchetypeStep()`
- `renderSkillStoreStep()`
- `renderAgentReview()`
- `renderAgentRoom()`
- `renderAvatarSvg(appearance)`

### Decisión visual del MVP

Usar SVG/CSS 2D con piezas allowlisted. Esto entrega identidad y feedback inmediato sin introducir:

- Three.js;
- canvas complejo;
- modelos 3D;
- pipeline de assets;
- problemas de GPU/móvil.

El avatar debe ser reconocible en 64 px, 160 px y móvil.

---

## 9. Plan de implementación por tareas

### Task 1: Contratos y pruebas rojas del catálogo

**Objective:** Definir arquetipos, piezas visuales y catálogo saneado de skills sin mutaciones.

**Files:**
- Create: `playground.py`
- Create: `tests/test_agent_playground.py`
- Modify: `tests/harness.py`
- Modify: `server.py`

**Steps:**

1. Extender el harness con un `HERMES_HOME` temporal y skills fixture.
2. Escribir prueba de `401` sin Admin Token.
3. Escribir prueba de contrato para cinco arquetipos.
4. Escribir prueba que garantice que el catálogo no expone rutas, `.env`, tokens ni contenido completo de skills.
5. Ejecutar:

```bash
.venv/bin/python -m unittest tests.test_agent_playground -v
```

Expected: FAIL porque el router no existe.

6. Implementar `GET /api/playground/catalog` con estructuras allowlisted.
7. Repetir y esperar PASS.
8. Commit:

```bash
git add playground.py server.py tests/harness.py tests/test_agent_playground.py
git commit -s -m "feat(playground): add sanitized creation catalog"
```

### Task 2: Validación del draft y preview determinista

**Objective:** Transformar elecciones del wizard en una ficha y `SOUL.md` revisables sin escribir estado.

**Files:**
- Modify: `playground.py`
- Modify: `tests/test_agent_playground.py`

**Tests rojos:**

- nombre inválido;
- arquetipo desconocido;
- pieza visual desconocida;
- más de tres skills;
- skill fuera del catálogo;
- misión o límites demasiado largos;
- payload con campos extra;
- preview válido no crea directorios;
- `SOUL.md` no contiene biografía ficticia ni secretos.

Endpoint:

```text
POST /api/playground/preview
```

Expected: ficha normalizada, descripción de routing y `soul_preview`.

Commit:

```bash
git commit -s -am "feat(playground): add deterministic agent preview"
```

### Task 3: Spawn transaccional de perfil real

**Objective:** Crear un perfil Hermes, equipar hasta tres skills y revertir completamente cualquier fallo.

**Files:**
- Modify: `playground.py`
- Modify: `profile_hub.py` sólo para reutilizar helpers seguros cuando sea necesario
- Modify: `tests/harness.py`
- Modify: `tests/test_agent_playground.py`

**Tests rojos:**

- usa arrays de argumentos, nunca shell;
- crea perfil con CLI oficial;
- no inicia gateway;
- escribe `SOUL.md` y `avatar.json` con modo `0600`;
- copia sólo skills seleccionadas;
- rechaza symlinks de catálogo o destino;
- rollback si falla SOUL, skill, metadata o verificación final;
- auditoría started/success/failure;
- perfiles protegidos no pueden sobrescribirse;
- dos spawns concurrentes con el mismo nombre producen uno solo.

Endpoint:

```text
POST /api/playground/spawn
```

Commit:

```bash
git commit -s -am "feat(playground): spawn isolated Hermes agents"
```

### Task 4: Plaza de agentes y navegación

**Objective:** Añadir la entrada visual al Playground sin eliminar el CRUD administrativo.

**Files:**
- Create: `dashboard/pages/agent-playground.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/utils.js`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/api.js`

**Steps:**

1. Agregar “Agent Playground” en sidebar y navegación móvil.
2. Crear plaza con perfiles existentes.
3. Mostrar avatar default cuando no exista `avatar.json`.
4. Diferenciar “Crear agente” de “Administrar perfiles”.
5. Verificar navegación por teclado y móvil.

Commit:

```bash
git commit -s -m "feat(playground): add agent plaza"
```

### Task 5: Constructor visual de avatar

**Objective:** Permitir personalizar un avatar 2D con feedback instantáneo.

**Files:**
- Modify: `dashboard/pages/agent-playground.js`
- Modify: `dashboard/styles.css`

**Steps:**

1. Implementar renderer SVG/CSS con piezas del catálogo.
2. Añadir selectores accesibles con texto, no sólo color.
3. Añadir combinación aleatoria allowlisted.
4. Mantener draft únicamente en memoria/sessionStorage sin secretos.
5. Probar contrastes, 64/160 px y viewport móvil.

Commit:

```bash
git commit -s -am "feat(playground): add interactive avatar builder"
```

### Task 6: Propósito, arquetipo y personalidad

**Objective:** Guiar al usuario desde una intención abierta hasta una misión y límites concretos.

**Files:**
- Modify: `dashboard/pages/agent-playground.js`
- Modify: `dashboard/styles.css`

**Acceptance:**

- pregunta una cosa por vez;
- conserva campos válidos;
- permite volver sin perder el draft;
- no crea perfil antes de confirmación final;
- muestra resumen editable;
- “proactivo” siempre conserva aprobación para efectos externos.

Commit:

```bash
git commit -s -am "feat(playground): add guided agent identity flow"
```

### Task 7: Tienda básica de skills

**Objective:** Seleccionar hasta tres skills iniciales desde un catálogo aprobado.

**Files:**
- Modify: `dashboard/pages/agent-playground.js`
- Modify: `dashboard/styles.css`

**Acceptance:**

- búsqueda por nombre/descripción;
- filtro por categoría;
- starter pack sugerido por arquetipo;
- contador `0/3`;
- no permite skills no catalogadas;
- explica “skill” en lenguaje no técnico;
- requisitos declarados no implican “conectado”.

Commit:

```bash
git commit -s -am "feat(playground): add starter skill store"
```

### Task 8: Ficha final, spawn y habitación

**Objective:** Confirmar, crear y mostrar el agente real con evidencia de preparación.

**Files:**
- Modify: `dashboard/pages/agent-playground.js`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/api.js`

**Acceptance:**

- preview del backend antes del spawn;
- confirmación explícita;
- doble clic no crea duplicados;
- progreso visible durante la creación;
- errores muestran rollback sin inventar éxito;
- habitación refleja respuesta real del backend;
- botón para ir al CRUD avanzado.

Commit:

```bash
git commit -s -am "feat(playground): complete agent spawn journey"
```

### Task 9: Hardening, accesibilidad y regresión

**Objective:** Probar el recorrido completo y asegurar que el CRUD actual sigue funcionando.

**Files:**
- Modify: `tests/test_agent_playground.py`
- Modify: `tests/test_security.py`
- Modify: frontend sólo si aparecen defectos reales

**Validation:**

```bash
.venv/bin/python tests/run_all.py
node --check dashboard/pages/agent-playground.js
node --check dashboard/pages/profiles.js
node --check dashboard/api.js
node --check dashboard/app.js
git diff --check
```

Browser E2E manual:

1. Entrar por Basic Auth.
2. Introducir Admin Token.
3. Crear un avatar de prueba.
4. Elegir arquetipo y tres skills.
5. Revisar ficha.
6. Confirmar spawn.
7. Abrir habitación.
8. Verificar el perfil mediante API/CLI.
9. Respaldar y borrar el perfil smoke test.
10. Confirmar que no quedan alias, directorios o metadata huérfana.

Commit:

```bash
git commit -s -am "test(playground): verify secure avatar creation flow"
```

### Task 10: Despliegue persistente

**Objective:** Publicar el MVP sin romper la URL actual.

**Steps:**

1. Respaldar configuración y estado actual.
2. Ejecutar suite completa.
3. Reiniciar únicamente `agentic-os.service`.
4. Verificar Caddy sin modificar credenciales.
5. Validar públicamente:
   - sin Basic Auth: `401`;
   - con Basic Auth: `200`;
   - sin Admin Token en API Playground: `401`;
   - con token: catálogo y plaza `200`;
   - spawn smoke test completo.
6. Verificar que `#profiles` sigue operativo.

---

## 10. Criterios de aceptación del MVP

1. Una persona puede crear un agente sin conocer `SOUL.md`, `profile.yaml` ni el CLI.
2. La experiencia completa cabe en cinco pasos y funciona en móvil.
3. El avatar responde inmediatamente a cada elección.
4. El usuario entiende misión, límites y skills antes de crear.
5. Ningún draft crea o modifica perfiles.
6. Sólo el botón final confirmado ejecuta el spawn.
7. El agente creado existe como perfil Hermes real y aislado.
8. Máximo tres skills aprobadas se instalan correctamente.
9. El gateway queda detenido.
10. No se copian memorias, cron, sesiones o canales del perfil fuente.
11. No se muestran ni almacenan secretos en metadata, HTML o logs.
12. Un fallo intermedio deja cero perfil parcial.
13. `default` y `agentic-os` siguen protegidos.
14. El CRUD actual continúa disponible.
15. La habitación muestra salud real, no estadísticas inventadas.
16. Suite completa y smoke público pasan.

---

## 11. Riesgos y decisiones

### Riesgo: gamificación superficial

**Mitigación:** representar capacidades reales y usar hitos verificables. No añadir XP en el MVP.

### Riesgo: dar demasiados permisos por un arquetipo

**Mitigación:** el arquetipo sólo sugiere misión y skills. No habilita gateways, secretos, cron, MCP ni acciones externas.

### Riesgo: tienda de skills insegura

**Mitigación:** catálogo local allowlisted, lectura saneada y copia desde rutas resueltas. Skills de terceros quedan fuera.

### Riesgo: clonar demasiada información

**Mitigación:** usar `--clone-from agentic-os --no-skills`, auditar qué hereda realmente el CLI y añadir una prueba que prohíba memoria, cron, plugins y plataformas heredadas. Si el CLI no garantiza ese aislamiento, crear desde perfil vacío y aplicar sólo configuración mínima mediante comandos oficiales.

### Riesgo: el usuario confunde “skill instalada” con “integración lista”

**Mitigación:** estados separados: disponible, instalada, requiere configuración, conectada y verificada.

### Riesgo: crecer demasiado pronto

**Mitigación:** no construir mundo, marketplace, economía, 3D, chat entre avatares o árbol de niveles hasta validar que diez usuarios pueden crear un agente útil sin asistencia técnica.

---

## 12. Fase 2 después de validar lo básico

Sólo después del MVP:

1. Tienda independiente para equipar/desequipar skills después del spawn.
2. Add-ons gobernados: MCP, plugins, canales y automatizaciones.
3. Especialistas/mentores que recomiendan builds, sin instalar automáticamente.
4. Árbol de evolución basado en hitos:
   - identidad validada;
   - primera skill probada;
   - primera fuente aprobada;
   - primer flujo completado;
   - evaluación de comportamiento aprobada.
5. Biomas/habitaciones por dominio.
6. Exportación/importación de una “ficha de agente” sin secretos.
7. Marketplace de terceros sólo con gobernanza, firma, revisión y sandbox.

---

## 13. Acción mínima tangible

Construir primero un prototipo navegable de un solo recorrido:

```text
Apariencia → Propósito → Arquetipo → 3 skills → Ficha
```

En esta primera prueba, el botón final puede llamar únicamente a `/preview`; todavía no crea el perfil. La evidencia buscada es observar a tres usuarios:

- ¿entienden qué están creando?
- ¿pueden terminar sin explicación técnica?
- ¿eligen skills coherentes con su objetivo?
- ¿pueden explicar qué hará y qué no hará su agente?

Si el recorrido es claro, se conecta el spawn real en la siguiente entrega. Así se valida la experiencia antes de aumentar el riesgo operativo.
