# Sistema de Instagram para GO APPLE (@goapple.sj)

Esto es la versión standalone, solo para GO APPLE, del sistema de Instagram que ya usa @ramaruiz.ads (repo `panel-ramamkr`). Mismo motor (API de Meta + GitHub Actions + datos cifrados en el propio repo), pero separado: no comparte datos ni secretos con el otro repo.

## Lo que falta cargar en GitHub (Rama, no Claude)

En `Settings → Secrets and variables → Actions` de este repo (`ramaskere/go-apple-sistema`):

**Secrets** (Settings → Secrets and variables → Actions → Secrets):
- `TOKEN_ORG_ADS`: el mismo token de Meta que ya usa el otro sistema (tiene acceso a las dos cuentas vía el Business Manager). Se puede cargar el mismo valor acá.
- `DATA_PASS`: una contraseña nueva, elegida por Rama, para cifrar los datos de este repo (leads, recursos, posts, campañas). No tiene que ser la misma que la del otro sistema.

**Variables** (Settings → Secrets and variables → Actions → Variables):
- `IG_USERNAME`: `goapple.sj`
- `IG_USER_ID`: el ID numérico de la cuenta de Instagram de GO APPLE (se puede obtener corriendo el workflow "Verificar cuentas" con `cuentas: goapple.sj`, o desde Meta Business Suite).
- `AD_ACCOUNT_ID`: solo si en algún momento se conecta una cuenta publicitaria para GO APPLE (hoy no hay, así que el workflow "Sincronizar Meta" solo va a traer datos orgánicos).

## Qué automatizaciones quedaron activas (cron, cada repo es independiente del otro)
- `Programador` (cada 15 min): publica lo que esté en `cola.json`.
- `Historias diarias` (cada 15 min): rota las historias de `rotaciones.json`.
- `Responder comentarios` (cada 5 min): bot de comentario → DM (solo texto, sin adjuntar PDF/link, según la regla de GO APPLE).
- `Sincronizar Meta` (cada 6 h): métricas orgánicas (y de Ads si se conecta cuenta publicitaria).
- `Publicar en Instagram` (manual, con `confirmar: PUBLICAR`): publica un post/carrusel/historia ahora mismo.
- `Gestionar datos` (manual): crea/edita/borra leads, recursos, posts, campañas.
- `Verificar cuentas` (manual): chequea si Meta ve la cuenta.

Hasta que no se carguen los secrets/variables de arriba, estos workflows van a aparecer como fallidos en la pestaña Actions (es esperado, no rompe nada — simplemente no tienen con qué autenticarse todavía).

## Qué no se tocó
- El repo compartido `panel-ramamkr` / carpeta local `sistema-instagram/` sigue como estaba, sin cambios. Lo que ya está sincronizado ahí de @goapple.sj (las ~35 publicaciones orgánicas, por ejemplo) no se migró — queda como historial en el panel compartido. Este sistema nuevo arranca de cero para adelante.
