# Un VPS del proyecto

El manual genérico de una máquina del proyecto (Alemania, Malasia y las que sigan): un nodo de
confianza, `host,verify`, que se carga desde el panel de control de nodos. El caso real, con sus
mediciones y su historia, es [VPS-SAO-PAULO.md](VPS-SAO-PAULO.md).

**Nunca le des un token del proyecto a un tercero: da confianza total.** El nodo que registra se
activa sin prueba, verifica ranked (también las suyas), se le cree cuando dice que un jugador no se
presentó y nunca se suspende. El servidor de otra persona va por Mis servidores, no por aquí.

Las fichas de cada máquina (proveedor, plan, direcciones, nombre DNS, `<tope-gb>`, `<n>`) van en las
notas privadas del mantenedor, nunca en este repo (`tests/public-docs.test.mjs`).

## Antes de instalar

1. **El país:** la máquina está en un país que nombran los textos legales en vigor. Para Alemania y
   Malasia, eso es la versión legal (a) en vigor; antes, no se registran.
2. **Endurecimiento**, igual al de São Paulo (`VPS-SAO-PAULO.md`, "Endurecimiento aplicado"):
   - SSH como `root`, solo con clave; sin contraseña;
   - firewall con entrada denegada por defecto y abiertos solo 22, 80 y 443 (IPv4 e IPv6), sin UDP;
   - fail2ban sobre `sshd`;
   - actualizaciones de seguridad automáticas, sin reinicio, y needrestart sin tocar Caddy ni el
     nodo;
   - logs de 7 días como mucho, el journal y los de texto (rsyslog, ufw, fail2ban): es lo que dice
     la política de privacidad (sección 6), porque pueden tener direcciones IP. La configuración está
     en la fila "Logs" de São Paulo.
3. **El sistema:** Debian 12 o más nuevo, o Ubuntu 22.04 o más nuevo, con NTP activo.
4. **DNS:** `<host>`, un registro A **solo DNS** (sin el proxy de Cloudflare) hacia la máquina, y un
   AAAA solo si apunta a esa misma máquina. Hace falta un nombre: el chequeo de alcance corre en el
   Worker, y un Worker no puede pedir una IP. El panel y el servidor rechazan una IP o un puerto, y
   el instalador también, antes de instalar nada.
5. **Si va a verificar:** Node.js fijado en la misma versión que São Paulo (con la versión exacta en
   `--node-version <versión>`, el instalador la instala y la retiene con `apt-mark hold`), la
   prueba `xmachine` pasada contra São Paulo con el checkout actual (`nodes/scripts/xmachine.mjs`;
   `VPS-SAO-PAULO.md`, "Ventana de mantenimiento") y la misma release que el canal estable. Solo
   así verifica las ranked de los otros nodos de confianza, y ellos las suyas.
6. **La protección contra ataques de denegación:** la del proveedor, encendida para la máquina. El
   nodo no tiene otra delante.
7. **D19 y D20** (`VPS-SAO-PAULO.md`, "Instalar el nodo"):
   - `<tope-gb>`: el tope de egreso deja que dos meses UTC parciales entren en la transferencia
     mensual del plan;
   - `<n>`: `floor(cpu × 0,6 / 2)` con el `cpu` más conservador del benchmark, o `auto`.

## Instalar desde el panel

Desde una PC o un teléfono, nunca desde una TV: PERFIL › CUENTA DEL PROYECTO › CONTROL DE NODOS ›
AGREGAR SERVIDOR DEL PROYECTO. El orden es el de siempre: la contraseña, el token y el comando.

1. **Los datos:** el preset (`frankfurt-1` en EU, `kuala-lumpur-1` en AS: solo nombre y región), el
   nombre DNS de las notas privadas, los roles (`host,verify`), `<n>` y `<tope-gb>`. El panel
   muestra los lugares de confianza libres y no pide un token sin lugar: retira antes el que sobre
   (el registro "Ubuntu" de São Paulo, por ejemplo).
2. **La lista de chequeo:** cada línea de "Antes de instalar", marcada.
3. **La contraseña:** el panel la pide siempre, aunque la sesión sea reciente, para que el
   seguimiento tenga sus 15 minutos enteros. Cada confirmación manda un `ALERT` al canal del equipo.
4. **El token y el comando:** el servidor arma el comando con cada valor comprobado y el panel lo
   muestra solo si coincide con lo pedido. COPIAR, y por SSH, como root, dentro de la hora:

```bash
curl -fsSL https://turbo-gol.com/nodes/releases/install.sh | sudo bash -s -- --control https://turbo-gol.com \
  --token <tgn1_...> --name <nombre> --roles host,verify --transport wss --public-host <host> \
  --matches <n> --egress-cap-gb <tope-gb>
```

   El token sirve una sola vez y solo para `<host>`: un registro con otro nombre o con una IP se
   rechaza sin gastarlo. Si en la máquina hay un Caddyfile que no escribió el instalador, el
   instalador se detiene antes de gastar el token: apártalo primero. Para un verificador, agrega
   al final `--node-version <versión>` (la de São Paulo, exacta): el panel no lo pone. Al
   terminar, el instalador muestra la dirección de Mis servidores (`/#servers`) y la guía del
   operador; este nodo se sigue en el panel (paso 5).
5. **El seguimiento:** el panel sigue el token y el nodo nuevo hasta `active`. Si queda `pending`,
   muestra el error de la última prueba y qué revisar: el DNS, los puertos 80 y 443, un Caddyfile
   previo o el certificado. Si el token vence, pide otro.

## Después

- `systemctl status turbogol-node caddy`, y en el log `status active`.
- `apt-mark hold nodejs caddy`: cambian solo en la ventana de mantenimiento.
- **Respaldo:** `/var/lib/turbogol-node/node.json` (la identidad del nodo, con su clave privada) al
  gestor de contraseñas, sin dejar una copia en el disco de la PC, y una instantánea de la máquina en
  el panel del proveedor.
- **Una ranked de prueba** en la región, con dos cuentas de prueba que no sean del proyecto: en una
  partida donde juega el operador, el scheduler no usa su nodo.

## Mantenimiento e interruptores

- La ventana de mantenimiento, el drenaje y el apagado son los de `VPS-SAO-PAULO.md`
  ("Operación"). Desde el panel: DRENAR (de ida: vuelve con `systemctl restart turbogol-node`),
  VOLVER A PROBAR y RETIRAR (solo desconectado, o drenado y sin partidas).
- `vm_disabled` manda todas las partidas nuevas a los servidores de Cloudflare sin tocar las
  máquinas, y `nodes_off` apaga el plano de control. El panel los muestra; se cambian con wrangler
  y tardan un minuto o dos.
