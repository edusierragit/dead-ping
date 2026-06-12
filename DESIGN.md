# DEAD PING — Creative Direction Lock

> "Silence is armor. Sound is a confession."

## Nombre elegido
**DEAD PING** (antes: "Abyssal Grid"). Corto, oscuro, memorable, funciona en una página de Steam.

## Fantasía del jugador
Sos el capitán de un submarino cazador en una fosa abisal, a oscuras totales.
Hay otro cazador ahí abajo. Ninguno de los dos puede ver. Los dos pueden **oír**.
Cada decisión es una negociación entre saber y ser sabido.

## Por qué NO es un clon de Batalla Naval
Batalla Naval es estático: ponés barcos y adivinás casillas. Acá **ambos se mueven cada turno**,
así que toda información decae. El juego deja de ser adivinanza y pasa a ser un duelo de
sigilo, lectura y mentira — gato y ratón donde los dos son el gato y los dos son el ratón.

## Mecánica diferencial: la economía del ruido
Todo lo que hacés emite sonido que el rival ve como "floraciones" en su sonar (y viceversa):

| Acción | Qué ganás | Qué pagás |
|---|---|---|
| DRIFT | moverte 1 | nada — silencio total |
| DASH | moverte 2-3 en línea | cavitación exacta en tu casilla de origen |
| LISTEN | bearing (octante) del enemigo, + flag CLOSE | un turno quieto |
| PING | posición EXACTA del enemigo | tu posición exacta gritada a la fosa |
| TORPEDO | 2 dmg directo / 1 splash, rango 4 | grito en tu posición + 3 turnos de recarga |
| DECOY | ruido falso que la IA no puede distinguir | solo tenés 2 |

Capas de mentira encima:
- **Vents termales**: emiten murmullos ambientales idénticos a los tuyos. Cobertura sonora natural.
- **Señuelos**: la IA hace inferencia bayesiana honesta sobre lo que oye — los decoys la engañan
  *de verdad*, no por script. Verla gastar un torpedo en tu fantasma es el highlight del juego.
- **Presión abisal** (anti-stall): turno 16 ambos cascos empiezan a filtrar sonido; turno 24
  filtran su posición exacta. Quedarse quieto deja de ser viable.
- **Tremor de proximidad**: a distancia ≤2 ambos sienten un latido — saben que está cerca, no dónde.

## Loop principal
Turnos **simultáneos**: elegís acción → la IA elige la suya en secreto → resolución conjunta
con beat dramático. Leés floraciones → inferís → decidís si callar o golpear. Partidas de 3-5 min.

## Estilo visual y sonoro
Sonar CRT de fósforo: verde/ámbar sobre negro, scanlines, barrido rotatorio, glow, screen shake.
Audio 100% sintetizado con WebAudio (pings, explosiones, latidos, drone de la fosa). Cero assets.

## Stack
Vite + TypeScript + Canvas 2D + WebAudio. Sin framework, sin dependencias de runtime.
`base: './'` en Vite → el build corre desde file:// o cualquier hosting → itch.io / Steam (Electron) trivial.

## IA
Grilla de creencia bayesiana sobre la posición del jugador: difusión por movimiento posible,
actualización por cada sonido oído (descontando vents), bearing por octantes, eliminación por misses.
Capa de comportamiento: caza con EV de daño esperado, evade cuando se sabe expuesta, suelta decoys.

## Riesgos principales y mitigación
1. **Legibilidad** (¿el jugador entiende qué oyó?) → log narrado estilo operador de sonar + colores
   por tipo de contacto + marcadores con edad (LKP·T-n).
2. **IA tonta o psíquica** → creencia bayesiana honesta: solo sabe lo que oye, validada con `npm run sim`.
3. **Stalling** → presión abisal + cap de 50 turnos.

## Qué NO se hace (scope lock)
Multiplayer/red, clases de submarinos, campaña, meta-progresión, mapas procedurales complejos,
mobile, arte externo, niveles de dificultad. Primero tiene que ser divertido un duelo.

## Crecimiento futuro (si la slice funciona)
Multiplayer async (el diseño simultáneo ya lo soporta), loadouts de módulos (1 slot: torpedo
guiado / silencio total / doble decoy), daily trench con seed compartida, modo 2v2.
