# SynthesisOne WhatsApp Test Bridge

Puente de prueba independiente para consumir el webhook de SynthesisOne y convertir un evento de transferencia en un mensaje normal de WhatsApp.

## Qué hace

1. Recibe `POST /webhook/synthesisone`.
2. Verifica `X-Webhook-Signature-V2` con HMAC-SHA256 y timestamp; también acepta la firma legacy si V2 no está presente.
3. Deduplica por `event_id` en almacenamiento persistente.
4. Toma únicamente `transaction.amount` como importe de negocio. No suma, resta ni usa comisiones de Transfermóvil.
5. Detecta pagos que coincidan con `LICENSE_PRICE_AMOUNT`, moneda y cuenta receptora configurada y genera el texto de compra de licencia.
6. Envía el mensaje por WhatsApp al `sender_phone` del evento.
7. Mantiene la sesión de WhatsApp con LocalAuth en un directorio persistente.
8. Permite vinculación por QR y por pairing code.

## Aviso sobre WhatsApp

Este proyecto usa `whatsapp-web.js`, una librería no oficial que automatiza WhatsApp Web. Su documentación advierte que no es una integración oficial de Meta y que existe riesgo de bloqueo. Para producción comercial de alta criticidad, el canal oficial es WhatsApp Business Platform / Cloud API.

## Persistencia en Render

La sesión de LocalAuth necesita filesystem persistente. Render documenta que el filesystem normal es efímero y que los persistent disks requieren un servicio de pago. Este proyecto usa `/var/data` como mount path. 

## Primer despliegue

1. Crea un repositorio nuevo en GitHub, por ejemplo `SynthesisOne-WhatsApp-Bot`.
2. Sube el contenido de este proyecto a la raíz del repositorio.
3. En Render crea un Web Service/Blueprint desde ese repositorio.
4. Usa `render.yaml` para crear el servicio, incluido el persistent disk.
5. Render generará `ADMIN_SECRET` y `SYNTHESISONE_WEBHOOK_SECRET` automáticamente si el Blueprint los acepta como `generateValue`.
6. Copia el valor de `SYNTHESISONE_WEBHOOK_SECRET` desde Render y configúralo como el `webhook_secret` del cliente SynthesisOne.
7. Espera a que el servicio esté Live.
8. Abre `/admin` y usa el `ADMIN_SECRET` para acceder.
9. Vincula la cuenta mediante QR o pairing code.

## Vinculación por teléfono

La función de pairing code usa `requestPairingCode(phoneNumber)` de whatsapp-web.js. El número debe ser el número de la cuenta de WhatsApp que vas a vincular, en formato internacional sin `+` ni espacios. En WhatsApp se usa la opción de vincular un dispositivo con número de teléfono y el código generado.

## Webhook de SynthesisOne

En el panel de SynthesisOne configura como webhook:

`https://TU-SERVICIO.onrender.com/webhook/synthesisone`

Y usa exactamente el mismo `SYNTHESISONE_WEBHOOK_SECRET`.

El backend SynthesisOne v1.8 ya envía:

- `X-Webhook-Event-Id`
- `X-Webhook-Timestamp`
- `X-Webhook-Signature`
- `X-Webhook-Signature-V2`

La firma V2 es HMAC-SHA256 sobre `timestamp + "." + body`, usando el secreto del cliente.

## Texto de licencia

Cuando el evento coincide con:

- `transaction.amount == LICENSE_PRICE_AMOUNT`
- `transaction.currency == LICENSE_CURRENCY`
- `transaction.receiver_account` está en `LICENSE_RECEIVER_ACCOUNTS` (si la lista no está vacía)

el bot envía:

`Se ha detectado un pago asociado a este número`

`Usted ha comprado la licencia de SynthesisOne.`

seguido de importe, cuenta, número, método, operación y fecha.

## Prueba manual

Antes del webhook real, el panel tiene `Enviar prueba` para comprobar que la sesión de WhatsApp está lista.
