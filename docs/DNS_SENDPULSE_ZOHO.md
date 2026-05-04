# DNS para isladelsol.org: SendPulse + Zoho

Este archivo resume los registros DNS recomendados para usar:

- SendPulse como proveedor SMTP transaccional para `votacion@isladelsol.org`
- Zoho Mail como buzón de recepción

## SPF

Debe existir **un solo registro SPF TXT** para el dominio raíz.

SendPulse documenta como valor SPF para SMTP:

```txt
v=spf1 include:mxsspf.sendpulse.com +a +mx ~all
```

Si Zoho ya agregó su SPF, no crees un segundo SPF. Fusiona ambos includes en un único registro.

Ejemplo recomendado si Zoho también envía correo desde el dominio:

```txt
Host/Name: @
Type: TXT
Value: v=spf1 include:zoho.com include:mxsspf.sendpulse.com ~all
```

Notas:

- Si Zoho te dio otro include específico, usa el que muestre tu panel de Zoho.
- Si SendPulse te muestra un SPF distinto en su panel, usa el del panel como fuente final.
- No debe haber dos TXT distintos que empiecen con `v=spf1`.

## DKIM

### Zoho

Mantener el DKIM generado por Zoho para el buzón.

### SendPulse

Agregar el DKIM exacto generado por SendPulse para el dominio. Normalmente será un TXT similar a:

```txt
Host/Name: sign._domainkey
Type: TXT
Value: v=DKIM1; k=rsa; p=...
```

No copies valores de ejemplo de documentación. Usa la clave generada por tu cuenta SendPulse.

## DMARC

Para arrancar en modo observación:

```txt
Host/Name: _dmarc
Type: TXT
Value: v=DMARC1; p=none; rua=mailto:votacion@isladelsol.org; adkim=s; aspf=s
```

Cuando el envío esté validado y no haya problemas de entrega, se puede endurecer:

```txt
v=DMARC1; p=quarantine; rua=mailto:votacion@isladelsol.org; adkim=s; aspf=s
```

Y eventualmente:

```txt
v=DMARC1; p=reject; rua=mailto:votacion@isladelsol.org; adkim=s; aspf=s
```

## Variables .env esperadas por la app

La app usa variables `SMTP_*`:

```env
BASE_URL=https://isladelsol.org
SMTP_HOST=<host smtp sendpulse>
SMTP_PORT=587
SMTP_USER=<usuario smtp sendpulse>
SMTP_PASS=<password/api key smtp sendpulse>
SMTP_FROM="Votación Isla del Sol <votacion@isladelsol.org>"
```

## Checklist de pruebas

1. Validar SPF en MXToolbox o herramienta equivalente.
2. Validar DKIM de Zoho y SendPulse.
3. Validar DMARC.
4. Enviar prueba a Gmail.
5. Enviar prueba a Outlook/Hotmail.
6. Enviar prueba a un correo corporativo si hay vecinos con ese tipo de buzón.
7. Confirmar que el `From` visible sea `votacion@isladelsol.org`.
8. Confirmar que las respuestas llegan al buzón Zoho.
