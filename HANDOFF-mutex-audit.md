# Prompt para /new — Mutex Audit

## Contexto de la sesión anterior
Estuvimos debuggeando a McCompaii (kimi-k2.6, perfil mccompaii). 
Logramos que llame tools, use gAndy, y dejamos el heartbeat limpio (sin hostiles, con body awareness, 90s cooldown).
Quedaron dos problemas abiertos:

## 1. Mutex — acciones que se cancelan entre sí
El dig (minar) puede ser interrumpido por L2 runner o auto-eat porque NO tiene protección de mutex.
Hay que auditar TODOS los lugares donde una acción de L4 o gAndy puede ser cancelada por:
- L2 runner (claimCritical)
- auto-eat (cambia el item en mano)
- pathfinder (mueve al bot)
- Otro heartbeat

### Puntos a revisar:
- `/action/dig` — no reclama mutex, L2 puede interrumpirlo
- `auto-eat` en server.js — cambia held item sin verificar si hay un dig en progreso
- `embodied_plan` — ¿el cancel_bot_task es suficiente?
- `mc_build place` — ¿está protegido?
- `MotionController.goto` — ¿el mutex routing funciona?

### Objetivo:
Que las acciones iniciadas por L4 no sean canceladas por L2/L3 sin que L4 lo sepa.
Si L2 necesita actuar (defensa), debe notificar a L4 vía `mc_interoception`.

## 2. McCompaii stuck en loop de colocar cama
No encuentra espacio plano, no verifica qué tool tiene equipado antes de minar.
SOUL necesita: "Cuando una acción falla, verificá qué tenés equipado antes de reintentar."

## Archivos clave modificados esta sesión:
- `~/.hermes/profiles/mccompaii/SOUL.md` — reescrito (positivo, gAndy-first, sin quieto/Nico)
- `~/.hermes/hermes-agent/gateway/platforms/daemoncraft.py` — heartbeat limpio, body awareness
- `~/.hermes/hermes-agent/tools/embodied_plan_tool.py` — _summarize_result()
- `~/Projects/DaemonCraft/agents/bot/server.js` — judge error → ok:false, under-foot mining removed
- `~/Projects/DaemonCraft/agents/bot/lib/motion-controller.js` — random yaw jitter
- `~/Projects/DaemonCraft/agents/agent_loop.py` — death tracking in body_session
