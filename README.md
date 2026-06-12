# DEAD PING

Duelo táctico de sigilo submarino: 1v1 contra una IA bayesiana o **online contra otro
humano** (P2P con código de sala, sin servidor). Todo lo que hacés suena; todo lo que
suena te delata. Ver `DESIGN.md` para la dirección creativa completa.

## Correr

```bash
npm install
npm run dev      # abre http://localhost:5173
```

## Online

En la portada: **CREAR DUELO ONLINE** te da un código de 4 letras; el otro jugador lo
pone en **UNIRSE**. La conexión es WebRTC P2P (señalización via relays públicos de nostr,
trystero). Turnos simultáneos lockstep con seed compartida — ambos clientes resuelven
exactamente la misma partida.

## Otros comandos

```bash
npm run build    # typecheck + build de producción en dist/ (portable, base relativa)
npm run preview  # servir el build
npm run sim      # 300 partidas IA vs IA para validar balance
npm run e2e      # test de navegador real via CDP: partida vs IA + duelo online
                 # entre dos pestañas con verificación de determinismo (requiere dev server)
```

## Controles

- Teclas `1-6` o click en los botones para elegir acción
- Click en el mapa para elegir destino/objetivo
- `ESC` cancela el targeting

## Puntajes

La bitácora (inmersiones, cazas, hundimientos, rachas, precisión, récord online) se
guarda en `localStorage` y se muestra en la portada y al final de cada partida.
