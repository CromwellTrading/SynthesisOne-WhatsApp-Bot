# Configuración rápida desde el teléfono

## GitHub

Sube todos los archivos del ZIP a la raíz del repositorio. No dejes una carpeta extra envolviendo el proyecto.

## Render

Crea un nuevo servicio desde el repositorio y usa Docker. El `render.yaml` ya describe el servicio y el persistent disk.

### Variables

Render debe tener:

- `ADMIN_SECRET`
- `SYNTHESISONE_WEBHOOK_SECRET`
- `WHATSAPP_DEFAULT_COUNTRY_CODE=53`
- `LICENSE_PRICE_AMOUNT=28000`
- `LICENSE_CURRENCY=CUP`
- `LICENSE_RECEIVER_ACCOUNTS=<cuenta receptora de la licencia>`

No pongas secretos en el repositorio.

### Persistent disk

Debe existir `/var/data`. Render indica que los persistent disks requieren un plan de servicio de pago. Sin ese disco, una sesión LocalAuth no sobrevivirá a un redeploy/restart.

## Vincular WhatsApp

Abre:

`https://TU-SERVICIO.onrender.com/admin`

Introduce `ADMIN_SECRET`.

### QR

Pulsa `Mostrar QR` y escanéalo desde el WhatsApp principal.

### Pairing code

Escribe el número de la cuenta de WhatsApp que quieres vincular, con código de país, sin `+`, y pulsa `Generar código`.

Luego usa en WhatsApp la opción para vincular un dispositivo con número de teléfono. WhatsApp permite vincular hasta cuatro dispositivos y puede desconectar dispositivos enlazados después de periodos de inactividad; por eso la frase correcta es "sesión persistente mientras WhatsApp la mantenga vinculada", no "nunca se cerrará".

## Conectar SynthesisOne

En el panel del cliente SynthesisOne, pon como webhook:

`https://TU-SERVICIO.onrender.com/webhook/synthesisone`

y el mismo secreto que aparezca en `SYNTHESISONE_WEBHOOK_SECRET`.

## Prueba

1. Confirma `READY/READY` en el panel.
2. Usa `Enviar prueba` a tu propio WhatsApp.
3. Envía un webhook real de SynthesisOne.
4. Revisa `Eventos recientes`.
