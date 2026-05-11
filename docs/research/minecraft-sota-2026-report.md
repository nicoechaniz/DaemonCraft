# SOTA Stunning Looking Minecraft Servers 2026
## Reporte de Investigación Visual para DaemonCraft (Java 1.21.11 / Purpur / Fabric Client-Side)

---

## 1. Shaders SOTA 2026

El ecosistema de shaders para Minecraft Java en 2025–2026 sigue dominado por **Iris + Sodium** como pipeline base obligatorio. Los shaders más relevantes son:

| Shader | Estilo | Fortalezas | Requisitos | Compat. Fabric/Iris |
|--------|--------|------------|------------|---------------------|
| **Complementary Reimagined r5.4+** | Vanilla+ / Realista adaptable | Mejor equilibrio calidad/performance. Tiene dos perfiles: *Reimagined* (estética vanilla mejorada) y *Unbound* (más cinematográfico). Excelente integración con Distant Horizons | Media-Alta. GTX 1060/RX 580 mínimo recomendado. RTX recomendado para Unbound con path tracing | ✅ Iris/Sodium |
| **Photon v1.1+** | Realista cálido | Nubes volumétricas únicas, mejor performance que Complementary en algunos setups, look cálido ideal para builds de fantasía | Media. Más ligero que Complementary Unbound | ✅ Iris/Sodium |
| **Solas Shader** | Atmosférico / Fantasía | Efectos climáticos dinámicos muy avanzados. Gran alternativa a Complementary si se busca un look distintivo | Media-Alta | ✅ Iris/Sodium |
| **Bliss Shader** | Realista oscuro | Muy tecnológicamente avanzado, path tracing parcial, pero el estilo oscuro/sepia no gusta a todos. Performance exigente | Alta. RTX recomendado | ✅ Iris/Sodium |
| **Continuum RT Build 23 (2025)** | Path tracing completo comercial | El único path tracing "comercial" serio para Java. Calidad fotorealista. Requiere OptiFine legacy o builds específicas | **Extrema**. RTX 3070+ mínimo. Pagado (Patreon) | ⚠️ OptiFine (no Iris nativo) |
| **Sildur's Vibrant / Enhanced Default** | Clásico confiable | El estándar de confiabilidad. Menos efectos modernos pero máxima compatibilidad | Baja-Media | ✅ Iris/Sodium |

### Recomendación shader para DaemonCraft
**Complementary Reimagined** es la opción más actionable: es gratis, recibe actualizaciones constantes para 1.21.11, funciona perfecto con Iris+Sodium, y se ve impresionante sin matar el performance en LAN con PCs modernos. Photon es excelente alternativa si el look cálido encaja con la temática del servidor.

> ⚠️ **Nota importante**: Geyser/Bedrock players **no pueden usar shaders Java**. Solo los jugadores Java con Iris/Sodium verán los shaders. Bedrock tiene "Vibrant Visuals" oficial de Mojang (2025–2026) que mejora agua, nubes y sombras, pero no es comparable.

---

## 2. Visual Mods para Fabric 1.21

Los mods visuales trending en 2025–2026 que funcionan en **Fabric 1.21.1 / 1.21.11** y son **100% client-side** (compatibles con Purpur sin tocar el servidor):

| Mod | Qué hace | Versión 1.21 | Client/Server |
|-----|----------|--------------|---------------|
| **Distant Horizons v2.1+** | LODs para render distance extremo (512+ chunks) con bajo costo. Integra con shaders vía Iris | ✅ | Client |
| **Voxy** | Alternativa LOD más nueva. Mejores transiciones de texturas vanilla que DH, pero más experimental. Shader support desde 0.2.4 | ✅ | Client |
| **Particular ✨** | Sucesor espiritual de Effective. Añade luciérnagas, hojas cayendo, cascadas de agua con partículas, ambience biome-specific | ✅ (1.21.1) | Client |
| **Visuality** | Partículas cosméticas: sparkles en cristales, soul dust, splash mejorado en mobs | ✅ | Client |
| **Wakes** | Estelas realistas en agua al nadar/navegar. Reacciona a shaders con reflejos | ✅ | Client |
| **Particle Rain** | Reemplaza lluvia vanilla por partículas densas y direccionales. Mucho más inmersivo | ✅ | Client |
| **Effective** | Efectos de cascada, splash de agua, fireflies. Algunos features migraron a Particular; aún funciona en 1.21.1 | ✅ (1.21.1) | Client |
| **Falling Leaves** | Hojas cayendo de árboles (ya lo tienen) | ✅ | Client |
| **Continuity** | Conected textures para glass/wool (ya lo tienen) | ✅ | Client |
| **EMF + ETF** | Entity Model/Texture Features para Fresh Animations (ya lo tienen) | ✅ | Client |
| **Better Leaves / Clear Glass** | Resource packs tipo mod (ya lo tienen) | ✅ | Client |

### Mods que DaemonCraft NO tiene y debería considerar
- **Particular** (el mod visual más trending de ambience en 2025)
- **Distant Horizons** (impacto visual masivo para exploración/paisajes)
- **Wakes** (barato visualmente, gran mejora en lagos/océanos)
- **Particle Rain** (transforma completamente tormentas)

> ⚠️ **Advertencia técnica**: En 1.21.5+ hay reportes de caída de performance con Sodium+Iris (45–55% FPS drop vs 1.21.4). Como están en **1.21.11**, esto puede aplicar. Se recomienda quedarse en 1.21.1 si es posible, o testear extensivamente antes de actualizar.

---

## 3. Resource Packs Trending 2026

| Resource Pack | Estilo | Notas | Compat. Shaders |
|---------------|--------|-------|-----------------|
| **Fresh Animations** | Vanilla animado | Ya lo tienen. Requiere EMF+ETF. Sigue siendo el estándar para animaciones de entidades | ✅ Todos |
| **Patrix 32x** | Realista vanilla-friendly | Texturas custom-made para shaders. La versión 32x es gratis. Colores vanilla pero con profundidad PBR. Se ve espectacular con Complementary/Photon | ✅ Optimizado |
| **Compliance 32x / Faithless** | Vanilla+ limpio | Alternativas claras si Patrix es demasiado realista. Faithless tiene un estilo muy limpio y moderno | ✅ Todos |
| **Gray's Mob Overhaul** | Mob retextures | Tendencia en 2026 para complementar Fresh Animations con mobs más detallados | ✅ Todos |
| **Better Foliage (RP)** | Vegetación densa | Versión resource-pack (no mod) para vegetación extra sin mods server-side | ✅ Todos |

### Recomendación RP para DaemonCraft
- Mantener **Fresh Animations + EMF/ETF** (core del pack actual).
- Agregar **Patrix 32x** como base de texturas si quieren un salto visual masivo con shaders.
- Considerar **Gray's Mob Overhaul** para complementar FA.

---

## 4. Servers Conocidos por su Look Impresionante

| Servidor | Qué hacen | Técnicas aplicables a DaemonCraft |
|----------|-----------|-----------------------------------|
| **MCC Island (Noxcrew)** | Minigames con identidad visual única. Usan **resource packs custom forzados** y **optimización agresiva de assets** para que todo se vea consistente en Bedrock+Java | Forzar RP server-side; usar Polymer (server-side modding visual para Java); optimizar assets |
| **Wynncraft** | MMORPG con **mapa custom completo**, terrains esculpidos a mano, resource pack masivo con sonidos y modelos custom | World pre-generado con Terra o world painter; RP obligatorio; builds temáticas por biome |
| **Servidores con Terra + Terralith** | Worldgen custom que hace que Minecraft vanilla parezca otro juego. Usan mods server-side como Terra o datapacks Terralith/Amplified Nether | Agregar Terralith/Amplified Nether (datapacks, compatibles Purpur) |
| **Servidores con Voxy/DH showcase** | En 2025–2026, servidores de creative/exploración usan DH/Voxy en sus trailers para mostrar vistas imposibles en vanilla | DH/Voxy son client-side, pero un server con terreno épico se beneficia masivamente |

### Técnicas actionable para DaemonCraft
1. **Server Resource Pack**: Configurar `server.properties` para forzar el modpack visual a los players Java. Bedrock vía Geyser puede recibir un RP Bedrock separado.
2. **World Generation**: Usar datapacks **Terralith** + **Amplified Nether** + **Nullscape** (End). Son puros datapacks, 100% compatibles con Purpur y no rompen Bedrock Geyser (el terrain es server-side).
3. **Custom Builds con WorldEdit**: Zonas "spawn" y hubs esculpidos visualmente para impacto inmediato al unirse.

---

## 5. Tecnologías Emergentes

| Tecnología | Estado Actual 2026 | Viabilidad Producción |
|------------|-------------------|----------------------|
| **Distant Horizons 2.1+** | Estable. LOD system maduro con shader integration vía Iris. El estándar para render distance masivo en Java | ✅ Alta. Usar ya. |
| **Voxy** | Beta. Mejor calidad de LOD que DH (conserva texturas vanilla al zoom), pero más experimental. Shader support reciente (0.2.4+) | ⚠️ Media-Alta. Probar en el modpack, no es reemplazo definitivo de DH todavía. |
| **Path Tracing (Continuum RT)** | Activo pero comercial/Patreon. Build 23 de 2025. Requiere OptiFine legacy. No es gratis ni abierto | ❌ Baja para DaemonCraft. Los players necesitan setups específicos; no es práctico para un server LAN general. |
| **Ray Tracing oficial Bedrock** | Mojang confirmó que **no hay más desarrollo activo** de RTX para Bedrock Java-style. Vibrant Visuals es el futuro oficial | ❌ N/A para Java. |
| **Vibrant Visuals (Mojang)** | Lanzado para Bedrock como gráficos "oficiales mejorados". No hay fecha para Java | ❌ Solo Bedrock. Geyser no traduce estos gráficos a Java. |
| **Photonix** | *No se encontró evidencia de una tecnología o mod llamado "Photonix" en el ecosistema Minecraft 2025–2026.* Probable confusión con **Photon Shader** u otros proyectos. | ❌ N/A |

### Veredicto tecnologías emergentes
No hay un "killer tech" mágico en 2026 para Java. El SOTA real es la **combinación madura** de: **Sodium + Iris + Complementary/Photon + Distant Horizons + Particular + resource packs PBR/32x**. Voxy es lo más cercano a "emergente con potencial", pero aún no desplaza a DH.

---

## 6. Recomendaciones Concretas para DaemonCraft

### Baseline actual (lo que tienen)
- Purpur 1.21.11 + Geyser crossplay
- EMF, ETF, Fresh Animations, Continuity, Better Leaves, Clear Glass Connected, Falling Leaves

### ✅ Agregar (al modpack .mrpack)

| Prioridad | Mod/RP | Por qué |
|-----------|--------|---------|
| **P0** | **Distant Horizons 2.1+** | El impacto visual más grande posible. Ver el mundo a 512 chunks cambia completamente la experiencia de exploración en un server survival/creative |
| **P0** | **Particular ✨** | El standard de ambience 2025. Fireflies, cascadas, falling leaves mejorado. Funciona perfecto con shaders |
| **P0** | **Sodium + Iris** (si no están) | Base obligatoria para shaders en Fabric 1.21. Asegurar versiones compatibles entre sí |
| **P1** | **Complementary Reimagined** | Shader por defecto del modpack. Incluir settings optimizados para LAN/PCs modernos |
| **P1** | **Wakes** | Barato, luce increíble con shaders en océanos/ríos |
| **P1** | **Particle Rain** | Transforma climas. Muy ligero |
| **P1** | **Patrix 32x** (RP) | Base de texturas si quieren look next-gen. Gratis en 32x |
| **P2** | **Terralith + Amplified Nether** (datapacks) | Worldgen server-side épico. 100% compatible Purpur y Geyser |
| **P2** | **Visuality** | Sparkles y detalles de ambiente extra |
| **P2** | **Voxy** (opcional/experimental) | Para players que quieran probar LODs alternativos. No reemplaza DH aún |

### ❌ Quitar / Reconsiderar
- **Nada urgente que quitar**. El baseline es sólido.
- Si agregan **Patrix 32x**, evaluar si **Better Leaves RP** sigue siendo necesario (Patrix ya tiene hojas mejoradas).

### ⚠️ Consideraciones Geyser/Bedrock
- Los players Bedrock **no verán**: shaders, Distant Horizons, Particular, Wakes, ni la mayoría de resource packs Java complejos.
- Sí pueden beneficiarse de: **Vibrant Visuals** (si su cliente Bedrock lo soporta), **resource packs Bedrock custom** (traducir el RP Java a Bedrock o usar uno equivalente), y el **terreno server-side** (Terralith se ve igual en Bedrock vía Geyser).
- Considerar incluir un **RP Bedrock ligero** para mantener cierta consistencia de colores/bloques.

### 📋 Action items inmediatos
1. **Crear branch del .mrpack** actual y agregar: Sodium, Iris, Distant Horizons, Particular, Wakes, Particle Rain, Visuality.
2. **Incluir Complementary Reimagined** con un `shader_settings.txt` preconfigurado para calidad alta (no ultra) pensado en PCs modernos de LAN.
3. **Testear en 1.21.11**: Verificar que Sodium e Iris sean versiones compatibles. Si hay crash/FPS drop severo, considerar downgradear clientes a **1.21.1** donde el ecosistema está más maduro.
4. **Configurar server.properties**:
   ```
   resource-pack=https://<tu-host>/daemoncraft-visual.zip
   require-resource-pack=false
   ```
   (Forzar RP puede ser hostil para players Bedrock; mejor opcional pero recomendado).
5. **Agregar datapacks Terralith** al mundo de Purpur para elevar el worldgen sin mods server-side.

---

## Resumen Ejecutivo

- **El SOTA visual de Minecraft Java en 2026 no es una sola tecnología**, sino una **pila madura**: Sodium+Iris → Complementary/Photon → Distant Horizons → Particular + resource packs 32x/Patrix.
- **Photonix no existe** como tecnología emergente; probable confusión con Photon Shader.
- **DaemonCraft tiene un baseline excelente** (EMF/ETF/FA/Continuity). Le faltan los mods de **ambiente** (Particular, Wakes, Particle Rain) y **distance rendering** (Distant Horizons) para ser "stunning".
- **Geyser limita severamente** la experiencia visual para Bedrock, pero las mejoras server-side (Terralith, builds custom, RP forzado) benefician a ambas ediciones.
- **Prioridad #1**: Agregar Distant Horizons + Particular + Wakes al modpack client-side y testear en 1.21.11. Si la performance de Sodium/Iris es inestable en 1.21.11, considerar quedarse en 1.21.1 para el cliente.
