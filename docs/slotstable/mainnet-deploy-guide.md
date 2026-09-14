# Guía de Deploy — SlotsTable (Tigerous) Mainnet (Arbitrum One)

## ⚠️ Antes de empezar: bloqueante de infraestructura

**AuthHub nunca se ha desplegado en mainnet.** No aparece en ningún archivo de
`scripts/mainnet/deployments/*.json` ni en `index.json` → `platform.core`.
Todos los juegos ya vivos en mainnet (Roulette, Plinko, Mines, Slots, Crash)
son `BaseGame` y nunca lo necesitaron. SlotsTable es un `PushVRFGame`, cuyo
constructor recibe la dirección de AuthHub directamente
(`contracts/games/SlotsTable.sol:175`) — **no puede desplegarse sin uno**.

Este documento asume que el Paso 1 (deploy de AuthHub) se ejecuta una sola
vez, antes que nada.

**Segundo punto a verificar antes de correr esto en serio:** `contracts/core/PaymentHandler.sol`
hoy solo tiene una versión de `registerGame` (6 argumentos, con `jackpotBps`).
Pero el script que desplegó el PaymentHandler que está VIVO en mainnet hoy
(`scripts/mainnet/deploy-arbitrum-v5.ts`) usa una versión de 5 argumentos (sin
`jackpotBps`) seguida de `setGameStatus` — igual que `setup-mines-v5.ts`, un
deploy que todavía no se ha corrido. Esto sugiere que esos scripts son
anteriores al código fuente actual, y que **el PaymentHandler real en mainnet
podría no aceptar la llamada de 6 argumentos**. `deploy-slotstable.ts` hace un
`simulateContract` antes de enviar la transacción real, así que si esto pasa,
falla ahí con un mensaje claro — pero si falla, el problema es de la
plataforma (el PaymentHandler necesitaría actualizarse), no algo que este
script pueda resolver solo.

## Prerrequisitos

### Herramientas
- Node 20+, este repo con `npm install` ya corrido.
- Una wallet de deploy con ETH real en Arbitrum One (gas).
- Acceso a un RPC de mainnet real (Infura/Alchemy/nodo dedicado) — el endpoint
  público rate-limita fuerte bajo cualquier carga real.

### Infraestructura EVA ya desplegada — V5 (`scripts/mainnet/deployments/index.json`)
| Contrato | Dirección |
|---|---|
| EverValueCoin (EVA) | `0x45D9831d8751B2325f3DBf48db748723726e1C8c` |
| PaymentHandler | `0xabe66fc056dd0e116b90201e487ea102fd7df1ba` |
| RandomProviderV2 | `0x6513baa6c53a570ec899bb1504a95f160b8d7850` |
| House wallet | `0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd` |
| AuthHub | **No existe todavía — Paso 1 de esta guía** |

Estas direcciones ya están como default en `deploy-slotstable.ts`; solo hace
falta sobreescribirlas por env var si la plataforma migra a un core nuevo.

### Variables de entorno
Copiar `.env.example` → `.env` y completar la sección "Mainnet":
```
MAINNET_ARBITRUM_RPC_URL=
MAINNET_DEPLOYER_PRIVATE_KEY=
MAINNET_ARBISCAN_API_KEY=       # opcional, para verificar en Arbiscan
MAINNET_AUTH_HUB_ADDRESS=       # se completa después del Paso 1
CONFIRM_MAINNET=yes             # obligatorio para que cualquier script corra
```

## Paso 1 — Deploy de AuthHub (una sola vez)

```bash
CONFIRM_MAINNET=yes npm run deploy:authhub:mainnet
```

Guarda la dirección impresa (también queda en
`scripts/mainnet/deployments/arb-mainnet-authhub.json`) y agrégala a `.env`
como `MAINNET_AUTH_HUB_ADDRESS`.

## Paso 2 — Deploy de SlotsTable

```bash
CONFIRM_MAINNET=yes npm run deploy:slotstable:mainnet
```

Esto despliega el contrato, lo registra como consumidor de
`RandomProviderV2`, lo registra en `PaymentHandler` (2% house / 2% referral /
1% jackpot — el mismo split ya certificado en testnet contra estos fixtures),
y lo registra como spend tracker en AuthHub. **No fondea el bankroll** salvo
que se defina `MAINNET_SLOTSTABLE_BANKROLL` — por defecto queda para hacerlo
manualmente después de verificar que todo lo anterior salió bien.

El resultado queda en `scripts/mainnet/deployments/slotstable-mainnet.json`.
El script también imprime el snippet a pegar manualmente en
`scripts/mainnet/deployments/index.json` (ese archivo es una fuente de verdad
curada a mano, no se edita automáticamente).

## Paso 3 — Configurar las 3 tablas de pago (Tigrinho)

```bash
CONFIRM_MAINNET=yes npm run configure:slotstable:mainnet
```

Configura `configIndex` 0/1/2 (1/3/5 líneas) con los mismos fixtures
certificados por el solver que ya se usan en testnet
(`scripts/testnet/fixtures/tigrinho-*line.runtime.json` — son solo
probabilidades y multiplicadores, no dependen de la red), y verifica que
`getRtpBps()` on-chain coincida con el RTP del fixture después de cada
`setConfig`.

## Paso 4 — Fondear el bankroll (si no se hizo en el Paso 2)

```
evaToken.transfer(<dirección de SlotsTable>, <monto>)
```

## Paso 5 — Verificar en Arbiscan

Los tres scripts imprimen el comando `npx hardhat verify` exacto al final de
su ejecución (con los argumentos del constructor ya resueltos).

## Checklist de verificación post-deploy

- [ ] `AuthHub` desplegado y verificado en Arbiscan.
- [ ] `SlotsTable` desplegado y verificado en Arbiscan.
- [ ] `RandomProviderV2.setConsumerStatus(slotsTable, true, 1)` confirmado.
- [ ] `PaymentHandler.registerGame(...)` confirmado (si esto falló por el
      problema de arity descrito arriba, no continuar — resolver con el
      equipo de la plataforma primero).
- [ ] `AuthHub.setSpendTracker(slotsTable, true)` confirmado.
- [ ] Bankroll fondeado y balance verificado on-chain.
- [ ] Los 3 `setConfig` corridos y las 3 RTPs certificadas on-chain.
- [ ] `scripts/mainnet/deployments/index.json` actualizado a mano.
- [ ] `VITE_SLOTSTABLE_ADDRESS` / `VITE_AUTH_HUB_ADDRESS` del visualizador
      actualizados a las direcciones de mainnet (y su RPC/red también) antes
      de correr el pipeline de CI/CD del juego.

## Orden de ejecución (resumen)

1. Deploy AuthHub → guardar dirección
2. Deploy SlotsTable → guardar dirección
3. Configurar las 3 tablas de pago
4. Fondear bankroll
5. Verificar en Arbiscan
6. Actualizar `index.json` y los secrets del CI/CD del visualizador
