# Política de privacidad de Turbogol

> **BORRADOR para el dueño y un abogado. No se publica así.**
>
> - Versión `[VERSIÓN]`. Vigente desde `[FECHA DE VIGENCIA]`.
> - Este texto en español es el oficial. La traducción al inglés (`privacy.en.md`) es informativa.
> - Hecho a partir del código de `main` `4fe7593` (solo lectura), de la especificación del inicio de
>   sesión (respuestas del dueño del 29/10/2026) y de los estudios `data-inventory.md`,
>   `law-latam.md` y `law-intl.md`.
> - **Revisión 2 (30/10/2026):** incorpora `review-legal.md` y `review-accuracy.md`. Lo que no se
>   aceptó, y por qué, está al final de `preguntas-abogado.md` («Revisión»).
>
> **Marcas del borrador. Hay que resolverlas y borrarlas antes de publicar:**
>
> - `[ENTRE CORCHETES]`: un dato del responsable que falta. Nunca se inventa.
> - **[A CONFIRMAR]**: una propuesta. La deciden el dueño y el abogado.
> - **[ABOGADO Dn]**: la decisión n de `preguntas-abogado.md`.
> - **[CÓDIGO Pn]**: la frase es cierta solo cuando el juego tenga el cambio n de
>   `preguntas-abogado.md`. **No se publica antes.** Si el cambio no se hace, se usa el texto de
>   reemplazo que da esa fila de la §3 de `preguntas-abogado.md`.
> - **[VERIFICAR Vn]**: un dato que el dueño tiene que mirar en un panel o en una máquina.

---

## Resumen

- **Turbogol es un juego gratis.** No hay pagos, compras ni publicidad. No vendemos tus datos.
- **Para jugar como invitado no te pedimos nada.** Usamos tu dirección IP, lo que pasa en la
  partida y las señales del navegador que revisa el control contra bots.
- **Para una cuenta usamos tu correo,** el nombre que elijas y una huella de tu contraseña. Tu
  contraseña, tal como la escribes, nunca llega a nuestros servidores.
- **Algunas cosas son públicas:** tu nombre en la clasificación, en la lista de salas si creas una
  sala pública y, durante 30 días, las repeticiones de las partidas en servidores de la comunidad.
  Puedes ocultar tu nombre (sección 4.5).
- **En las partidas P2P, los otros jugadores reciben tu dirección IP,** aunque la partida termine
  pasando por un relé. Si no quieres eso, elige «Servidor».
- **Quien opera un servidor de la comunidad ve tu dirección IP** y la partida.
- **Tus datos se guardan fuera de Argentina:** en Cloudflare (incluido Estados Unidos) y en el
  servidor del proyecto en Brasil.
- **Puedes pedirnos una copia de tus datos, corregirlos o borrarlos** escribiendo a
  `[CORREO DE PRIVACIDAD]`. Te respondemos en 10 días corridos como máximo.

---

## 1. Quién es responsable de tus datos

| | |
|---|---|
| **Responsable** | `[RESPONSABLE: nombre o razón social]` |
| **Documento** | `[CUIT/DNI]` |
| **Domicilio** | `[DOMICILIO]`, Argentina **[ABOGADO D18]** |
| **Correo para temas de privacidad** | `[CORREO DE PRIVACIDAD]` (propuesta: `privacidad@turbo-gol.com`) |
| **Inscripción de la base de datos** | Registro Nacional de Bases de Datos de la AAIP, n.º `[N.º DE INSCRIPCIÓN]` **[ABOGADO D2]** |
| **Representante en la Unión Europea** | `[REPRESENTANTE UE]` **[ABOGADO D4: si no se designa, se borra la fila]** |
| **Representante en el Reino Unido** | `[REPRESENTANTE UK]` **[ABOGADO D4: si no se designa, se borra la fila]** |
| **Representante en Brasil** | `[REPRESENTANTE EN BRASIL]` **[ABOGADO D4, D15: si no se designa, se borra la fila]** |

- Turbogol lo hace una persona, no una empresa **[A CONFIRMAR]**. Se juega en turbo-gol.com.
- **Delegado de protección de datos.** No designamos un delegado (RGPD) ni un *encarregado*
  (LGPD). Como agente de tratamiento de pequeño porte, nuestro canal para ti es
  `[CORREO DE PRIVACIDAD]` **[A CONFIRMAR — ABOGADO D3]**.
- **La ayuda general** (dudas del juego, errores) va por nuestro servidor de Discord. **Los
  pedidos sobre tus datos van por correo** a `[CORREO DE PRIVACIDAD]`: no necesitas Discord para
  ejercer tus derechos.
- **`no-reply@turbo-gol.com`** es la dirección que manda los correos del juego. No lee respuestas.

---

## 2. Qué datos usamos y para qué

### 2.1 La tabla

| Cuándo | Qué datos | Para qué |
|---|---|---|
| **Juegas como invitado** | Un identificador al azar. El nombre «Invitado NNNN», que sale de ese identificador: no lo eliges. Una sesión que vale 24 horas. Tu dirección IP | Darte un lugar en la partida. Evitar abusos (sección 10) |
| **Creas una cuenta** | Tu correo, confirmado con un código de 6 dígitos. El nombre de usuario que eliges. Una huella de tu contraseña. Tu idioma y tu zona horaria. La fecha de alta y la de tu último ingreso | Que entres a tu cuenta. Mandarte los códigos y los avisos de seguridad en tu idioma y con tu hora |
| **Tu cuenta es antigua** | Si se creó con códigos de recuperación, la huella de esos códigos, hasta la fecha de corte (sección 2.5) | Que puedas recuperar tu cuenta hasta esa fecha |
| **Entras con Discord** | Discord nos manda los datos básicos de tu perfil (por ejemplo, tu nombre de Discord y tu foto) y tu correo. **Solo leemos y guardamos tu identificador de Discord y tu correo.** El resto no lo guardamos ni lo usamos | Encontrar tu cuenta o crearla. El correo de Discord queda como una pista hasta que lo confirmas con un código: antes de eso no te escribimos ahí |
| **Entras con Google** (cuando esté disponible) | Tu identificador de Google y tu correo. Ni tu nombre ni tu foto | Lo mismo que con Discord |
| **Mantienes la sesión abierta** | Una cookie de sesión | Que no tengas que entrar cada vez |
| **Cada dispositivo con tu sesión** | El tipo (navegador o TV), las fechas, el método con que entraste y el **país y la ciudad aproximados**, que Cloudflare deduce de tu IP | Mostrarte en PERFIL dónde está abierta tu sesión, para que cierres la que no reconozcas |
| **Juegas una partida** | Tu nombre, tu auto, tu equipo y tus controles (cada tecla o movimiento). En una partida P2P, tu dirección IP | Jugar la partida. Mostrar el resultado |
| **Juegas COMPETITIVO** | Tu puntaje (rating), tus partidas, victorias y derrotas, tu mejor puntaje, tus abandonos y tus bloqueos de la cola | Emparejarte con rivales parejos. La clasificación. Las sanciones por abandonar |
| **Usas una sala personalizada** | El código de la sala, su título, su contraseña (guardamos solo una huella), los miembros y sus nombres. Si la creas tú y tu conexión usa IPv6, el prefijo de tu red. Las salas nuevas son privadas y P2P | Hacer funcionar la sala. Limitar cuántas salas abre una misma red |
| **Juegas en un servidor de la comunidad** | Tu nombre, tu identificador de jugador, tu equipo, tus controles y tu dirección IP. Cuánto tiempo jugaste y, si tienes cuenta, cuántos días tiene. Después, la repetición de la partida | Jugar la partida. Verificar que el resultado sea limpio. Calcular los puntos del anfitrión (30 días). Publicar la repetición |
| **Conectas una TV con tu teléfono** | El código de la TV. El país, la ciudad, la red y el nombre del proveedor de internet aproximados de la TV. La dirección IP de la TV y la de tu teléfono, solo en memoria mientras vive el código | Que tu teléfono te muestre qué TV vas a conectar y si está en tu misma red, para que nadie te engañe con un código ajeno. Frenar los intentos fallidos |
| **Cambias tus opciones** | Tus ajustes de física experimentales (con sus nombres), tus récords de entrenamiento, el interruptor de funciones experimentales, tu auto, «Ocultar mi nombre en repeticiones públicas» y «Novedades por correo» | Que tus opciones te sigan en cualquier dispositivo |
| **Hospedas un servidor de la comunidad** | Ver la sección 4.4 | Hacer funcionar la red de servidores |
| **Usas el sitio** | En los registros técnicos de Cloudflare: la dirección que pides, la hora, la respuesta y lo que Cloudflare agrega a cada pedido, como tu dirección IP, tu navegador y tu país y ciudad aproximados **[VERIFICAR V1]** | Hacer funcionar el servicio y encontrar errores |
| **Empiezas como invitado, conectas una TV o entras** | Las señales del navegador que lee Cloudflare Turnstile, el control contra bots: tu IP, tu navegador y datos de la conexión | Frenar bots |
| **Abres una página** | Si sigue activa, Cloudflare Web Analytics: la página, de qué sitio vienes, tu navegador, tu sistema, el tipo de dispositivo, tu país aproximado y cuánto tarda en cargar **[A CONFIRMAR — ABOGADO D5, CÓDIGO P13: si se apaga, se borra esta fila]**. Los reportes de errores de red (sección 9.4) | Medir visitas y velocidad. Encontrar fallas de la red |
| **Pides novedades** | Tu elección (sí o no), la versión del texto que aceptaste, de dónde vino (alta, PERFIL, un enlace de baja o un pedido de borrado) y la fecha | Mandarte novedades solo si las pediste, y poder probarlo |
| **Nos escribes** | Tu mensaje, tu correo y nuestra respuesta, en el buzón de `[PROVEEDOR DEL BUZÓN]` | Responderte y probar que respondimos a tiempo |

### 2.2 Lo que no pedimos

- Tu nombre real, tu fecha de nacimiento, tu teléfono, tu documento ni datos de pago.
- Tus contactos, tu ubicación exacta, tu cámara ni tu micrófono. La página le pide al navegador
  que bloquee la cámara, el micrófono y la ubicación.
- **No hay chat** de texto, de voz ni de video entre jugadores.

### 2.3 De dónde salen los datos

- **De ti:** lo que escribes y lo que haces en el juego.
- **De Discord o de Google,** si entras con ellos: tu identificador y tu correo. Discord también nos
  manda los datos básicos de tu perfil, que no guardamos.
- **De Cloudflare:** el país y la ciudad aproximados que deduce de tu dirección IP.
- **De los servidores de la comunidad:** la repetición de la partida.

### 2.4 Qué pasa si no das un dato o si das uno equivocado

- Sin correo (o sin Discord o Google) no hay cuenta. **Siempre puedes jugar como invitado.**
- Las novedades son opcionales. Decir que no, no cambia nada del juego.
- Sin tu dirección IP no hay conexión a internet: es necesaria para jugar en línea.
- Si escribes mal tu correo, no te llegan los códigos ni los avisos, y no podemos recuperar tu
  cuenta por correo.

### 2.5 Cuentas antiguas

Algunas cuentas viejas solo tienen nombre de usuario y contraseña, sin correo. Las guardamos igual
y te pedimos que agregues un correo o vincules Discord o Google. Desde la fecha de corte
`[FECHA DE CORTE]`, una cuenta sin correo confirmado ya no puede entrar con la contraseña. Te
avisamos al menos 30 días antes.

---

## 3. Bases legales

Cada ley pide decir en qué se apoya cada uso. Esta tabla las resume.

| Uso | Argentina (Ley 25.326) | Brasil (LGPD, Lei 13.709/2018) | Unión Europea y Reino Unido (RGPD) |
|---|---|---|---|
| Jugar, tu cuenta, las partidas, COMPETITIVO, la clasificación, la TV, los correos de tu cuenta y los avisos de seguridad | La relación que crean los Términos: art. 5.2.d | Ejecución del contrato: art. 7 V | Ejecución del contrato: art. 6.1.b |
| Seguridad, freno a bots y abusos, sanciones y marcas de sanción | La relación de los Términos (art. 5.2.d) y el deber de seguridad (art. 9) **[ABOGADO D8]** | Interés legítimo: art. 7 IX | Interés legítimo: art. 6.1.f |
| Cloudflare mejora Turnstile con tus señales, por su cuenta | **[ABOGADO D33]** | Interés legítimo de un tercero: art. 7 IX | Interés legítimo: art. 6.1.f |
| Publicar tu nombre en la clasificación, en la lista de salas públicas y en las repeticiones | La relación de los Términos: arts. 5.2.d y 11.3.b **[ABOGADO D9]** | Contrato o interés legítimo: art. 7 V y IX | Contrato (clasificación) e interés legítimo (repeticiones): art. 6.1.b y f |
| Novedades por correo | Tu consentimiento: arts. 5.1 y 27 | Tu consentimiento: art. 7 I | Tu consentimiento: art. 6.1.a |
| Guardar el registro de lo que aceptaste | La relación de los Términos: art. 5.2.d | Ejercicio de derechos: art. 7 VI | Deber de probar el consentimiento: arts. 6.1.c y 7.1 |
| Responder tus pedidos y guardar la prueba | Cumplir la ley: arts. 5.2.b, 14 y 16 **[ABOGADO D39]** | Obligación legal: art. 7 II | Obligación legal: art. 6.1.c |
| Medir visitas (Web Analytics), si sigue activa | **[A CONFIRMAR — ABOGADO D5]** | Interés legítimo: art. 7 IX | Tu consentimiento, por la directiva ePrivacy, art. 5.3 |
| Guardar tus datos fuera de Argentina | **[A CONFIRMAR — ABOGADO D7]**: tu consentimiento expreso (Decreto 1558/2001, art. 12) o cláusulas contractuales | Necesario para el contrato: art. 33 IX | Ver la sección 5 |

**Interés legítimo** (fuera de Argentina) quiere decir: que el juego sea seguro y justo para todos.
Usamos lo mínimo. Los contadores contra abusos que duran guardan huellas con clave secreta, no tu
correo ni tu IP. Los que duran segundos, minutos o lo que dura una partida o una sala usan tu IP (o
el prefijo de tu red IPv6) tal cual, y después se borran.

> **Puedes oponerte** a cualquier uso que hacemos por interés legítimo. Escríbenos a
> `[CORREO DE PRIVACIDAD]` y dejamos de hacerlo, salvo que tengamos un motivo legítimo más fuerte,
> que te explicamos.

**Si retiras un consentimiento**, vale desde ese momento. Lo que hicimos antes sigue siendo válido.

---

## 4. Quién más ve o recibe tus datos

### 4.1 Proveedores que trabajan para nosotros

Estos proveedores tratan tus datos para darnos su servicio. **Hay una excepción:** Cloudflare
también usa por su cuenta, como responsable, las señales de Turnstile (tu IP, tu navegador y datos
de la conexión) para mejorar su detección de bots. Para eso rige su [anexo de privacidad de
Turnstile](https://www.cloudflare.com/turnstile-privacy-policy/). Cloudflare también usa los
reportes de errores de red para cuidar su propia red **[VERIFICAR V10]**.

| Proveedor | País | Qué hace | Qué datos ve |
|---|---|---|---|
| **Cloudflare, Inc.** | Estados Unidos, con una red en todo el mundo | Ver la lista de abajo | Todo lo que guardamos, la dirección IP de cada pedido y los correos que te mandamos |
| **`[PROVEEDOR DEL VPS]`** **[VERIFICAR V4]** | Brasil | La máquina del servidor del proyecto en São Paulo | Tu dirección IP y la partida, cuando juegas en ese servidor |
| **`[PROVEEDOR DEL BUZÓN]`** **[VERIFICAR V7]** | `[PAÍS DEL BUZÓN]` | El buzón donde leemos y respondemos lo que escribes a `[CORREO DE PRIVACIDAD]` | Tu mensaje y tu correo |
| **Discord, Inc.** | Estados Unidos | El canal interno donde el equipo recibe avisos técnicos | Ver la lista de abajo. **Nunca el correo ni la IP de un jugador** |
| **`[PROVEEDOR DE NOVEDADES]`** | `[PAÍS DEL PROVEEDOR DE NOVEDADES]` | Mandar las novedades, cuando empecemos | Tu correo y tu idioma, solo si pediste novedades **[CÓDIGO P14]** |

**Lo que hace Cloudflare** (los nombres técnicos están en el anexo):

- aloja el juego y sus datos;
- manda los correos del juego y recibe los que nos escribes;
- ayuda a conectar las partidas P2P y, si la conexión directa falla, hace de relé;
- frena bots (Turnstile);
- mide visitas y velocidad (Web Analytics), si sigue activa **[A CONFIRMAR — ABOGADO D5, CÓDIGO
  P13]**;
- guarda registros técnicos y reportes de errores de red.

**Lo que llega al canal del equipo en Discord:** los nombres de usuario de los anfitriones, sus
servidores y la dirección de cada uno, el país de un ingreso del equipo, el identificador de una
cuenta a la que el equipo le da o le quita un ítem, los identificadores de partidas y el motivo que
escribe el equipo cuando saca una repetición o bloquea un servidor. Ese motivo puede nombrar a un
jugador.

La lista de proveedores de Cloudflare está en <https://www.cloudflare.com/gdpr/subprocessors/>.

### 4.2 Discord y Google, si entras con ellos

- Tú empiezas el inicio de sesión en la página de Discord o de Google. Ellos saben que usaste
  Turbogol, según sus propias políticas.
- De Discord y de Google guardamos solo tu identificador y tu correo. No les mandamos tus datos de
  juego.
- El uso que Turbogol hace de la información recibida de las API de Google, y su transferencia a
  cualquier otra aplicación, se ajusta a la [Política de datos del usuario de los servicios de API
  de Google](https://developers.google.com/terms/api-services-user-data-policy), incluidos los
  requisitos de uso limitado.
- **El servidor de Discord de Turbogol:** lo que escribes allí lo trata Discord según su propia
  política. Nuestro bot `[QUÉ LEE Y QUÉ GUARDA EL BOT]` **[VERIFICAR V12]**: eso lo tratamos
  nosotros, y vale esta política.

### 4.3 Otros jugadores

- **En cada partida** ven tu nombre, tu auto y tu equipo. En una sala, los demás miembros ven tu
  nombre.
- **En una partida P2P,** tu dispositivo se conecta directo con el de los otros jugadores, aunque
  no los conozcas. **Cada uno recibe tu dirección IP pública.** Con ella se puede saber, más o
  menos, tu ciudad y tu proveedor de internet.
  - **Cuándo es P2P:** en CASUAL con la conexión «Auto» (la que viene elegida) o «P2P», y en las
    salas P2P. Las salas nuevas vienen con P2P elegido. Si juegas solo, «Auto» te da un servidor
    con bots.
  - **Cómo evitarlo:** elige «Servidor» en la conexión de CASUAL, o cambia tu sala a «Servidor».
    COMPETITIVO siempre usa un servidor.
  - Si la conexión directa falla, el juego puede pasar la partida por un relé de Cloudflare.
    **Eso no oculta tu IP:** el juego la manda cuando intenta la conexión directa, antes de usar el
    relé. La única forma de que no la vean es elegir «Servidor».
  - Te avisaremos antes de cada partida P2P **[CÓDIGO P9]**.

### 4.4 Los servidores de la comunidad y sus anfitriones

- Algunas partidas se juegan en servidores de la comunidad («nodos»). Hoy **el único es el del
  proyecto, en São Paulo (Brasil)**, en una máquina de `[PROVEEDOR DEL VPS]`. Le llegan las
  partidas por servidor y las de COMPETITIVO cuando puede tomarlas **[VERIFICAR V14]**.
- **Más adelante, personas de la comunidad van a poder poner su propio servidor.** Quien lo opera
  ve tu nombre, tu identificador de jugador (el mismo en todas tus partidas), tus controles, lo que
  pasa en la partida y tu dirección IP. Las condiciones para anfitriones (sección 12 de los
  Términos) les prohíben guardar o usar esos datos para otra cosa **[ABOGADO D14]**.
- **De los anfitriones** guardamos su nombre de usuario, los datos de cada servidor (nombre,
  región, dirección pública, que puede ser una IP, capacidad, versión y datos de la máquina), las
  direcciones IP desde las que entran sus servidores (30 días) y sus puntos.
- **Es público:** el nombre de usuario del anfitrión junto a sus servidores, y sus puntos de los
  últimos 30 días. Si el anfitrión no elige un nombre para su servidor, el nombre del servidor lleva
  su nombre de usuario.

### 4.5 El público

Cualquiera, sin cuenta, puede ver:

| Qué | Con qué datos | Por cuánto tiempo | Cómo evitarlo |
|---|---|---|---|
| **La clasificación** de cada modo | Los 100 mejores con al menos 5 partidas en la temporada: nombre, puntaje (MMR), rango, partidas y victorias. No aparecen las cuentas suspendidas ni las que pidieron el borrado | Mientras tengas cuenta | Activa PERFIL > PRIVACIDAD > «Ocultar mi nombre en la clasificación»: en tu lugar se ve «Jugador anónimo» **[CÓDIGO P25 — ABOGADO D9]** |
| **La lista de salas públicas** | El título de la sala y el nombre de quien la creó | Mientras la sala esté abierta | Las salas nuevas son privadas. Déjala así |
| **Las repeticiones públicas** | Las partidas en servidores de la comunidad: modo, región, resultado, duración, si fue de COMPETITIVO, la hora redondeada, el equipo y el nombre de cada jugador, y **la partida entera, con cada control de cada jugador, para volver a verla**. Nunca tu identificador ni tu IP. Se publican de 1 a 2 horas después de la partida | 30 días | «Ocultar mi nombre en repeticiones públicas» viene **activado**: en tu lugar se ve «Jugador N», también en las partidas anteriores. Tu nombre se ve solo si lo apagas en PERFIL > PRIVACIDAD **[CÓDIGO P8 — A CONFIRMAR, ABOGADO D9]**. También puedes pedirnos que saquemos una repetición |
| **La lista de servidores de la comunidad** | El nombre de cada servidor, el nombre de usuario de su anfitrión, la región, el estado, la capacidad y los puntos de 30 días | Mientras el servidor exista. Si el anfitrión borra su cuenta, su nombre de usuario deja de verse **[CÓDIGO P26 — ABOGADO D24]** | Solo afecta a los anfitriones |

- Un cambio de «Ocultar mi nombre» llega a la lista en unos minutos y a las copias ya vistas en
  3 horas.
- Los invitados se ven como «Invitado NNNN».
- Cuando pides el borrado de tu cuenta, tu nombre deja de verse en las repeticiones, también en
  las más viejas **[CÓDIGO P25]**.
- Pedimos a los buscadores que no indexen las repeticiones. Pero alguien puede copiar lo que es
  público mientras se ve, y eso no lo podemos deshacer.

### 4.6 Autoridades

Damos datos a una autoridad solo cuando la ley nos obliga, con un pedido formal **[A CONFIRMAR]**.

### 4.7 Lo que nunca hacemos

- No vendemos tus datos ni los compartimos para publicidad.
- No mostramos anuncios ni armamos perfiles para publicidad.
- No rastreamos lo que haces en otros sitios. Por eso la señal «Do Not Track» de tu navegador no
  cambia nada aquí.

---

## 5. Datos que salen de Argentina

| Adónde | Qué | Por qué |
|---|---|---|
| **Estados Unidos y la red de Cloudflare** | Todo lo que guardamos. Los servidores de las partidas se midieron en Miami **[VERIFICAR V2]**. Las repeticiones se guardan en un almacenamiento de Cloudflare que no tiene región en Sudamérica. Cada pedido pasa por el centro de Cloudflare más cercano a ti | Alojar el juego |
| **Estados Unidos (Cloudflare, por su cuenta)** | Las señales de Turnstile | Mejorar su detección de bots **[ABOGADO D33]** |
| **Brasil** | Tu IP y la partida, en el servidor del proyecto en São Paulo | Jugar con poco retraso en Sudamérica |
| **Estados Unidos** | Tu identificador y tu correo, si entras con Discord o Google | Tu inicio de sesión |
| **`[PAÍS DEL BUZÓN]`** | Lo que nos escribes | Leer y responder tus pedidos **[VERIFICAR V7]** |
| **El país de cada jugador** | Tu IP, en las partidas P2P | La conexión directa |
| **El país de cada anfitrión** | Tu IP y la partida, cuando se abran los servidores de terceros | Jugar la partida |

**Para Argentina:** ni Estados Unidos ni Brasil están en la lista de países con protección
adecuada de la AAIP (Disposición DNPDP 60-E/2016, con la Resolución AAIP 34/2019). Por eso nos
apoyamos en `[A CONFIRMAR — ABOGADO D7: tu consentimiento expreso al crear la cuenta, el contrato
de tratamiento de datos de Cloudflare presentado a la AAIP, o las cláusulas modelo de la AAIP]`.
**[CÓDIGO P17]** si es el consentimiento.

> **Nota para el borrador (borrar al publicar):** esta sección **no se publica** con la marca de
> arriba sin resolver. Sin un mecanismo, la Política queda expuesta al art. 12 de la Ley 25.326 y a
> la Disp. SSDCyLC 377/2026, inc. ñ (ver D7 y D30).

**Para la Unión Europea y el Reino Unido:** Argentina tiene una decisión de adecuación de la
Comisión Europea (Decisión 2003/490/CE), que el Reino Unido mantiene. Cloudflare está en el Marco
de Privacidad de Datos UE-EE. UU. y su contrato incluye cláusulas contractuales tipo **[VERIFICAR
V8]**. Brasil tiene adecuación de la UE desde enero de 2026. Puedes pedirnos una copia de estas
garantías a `[CORREO DE PRIVACIDAD]`.

**Para Brasil:** las transferencias se apoyan en que son necesarias para el contrato (LGPD,
art. 33 IX) **[ABOGADO D16]**.

---

## 6. Cuánto tiempo guardamos los datos

**Sesiones y dispositivos**

| Dato | Cuánto |
|---|---|
| Sesión de invitado | Vale 24 horas. Queda en tu navegador hasta que empiezas otra o borras los datos del sitio |
| Sesión de cuenta | 1 hora. Se renueva sola mientras juegas |
| Cookie de sesión y registro de cada dispositivo (con país y ciudad aproximados) | 30 días desde el último uso. En una TV, 30 días desde que la conectaste, la uses o no |
| Límite de dispositivos | 10 navegadores y 5 TV por cuenta. Después, se cierra la sesión más vieja |
| Cuándo se borran antes | Al cerrar sesión, al cerrar sesión en todos los dispositivos y al pedir el borrado de la cuenta. Al cambiar la contraseña se borran los de tus otros dispositivos |
| Cookie de «navegador conocido» | 180 días. **Queda aunque cierres sesión** |
| Cookies del inicio con Discord o Google | 10 minutos y 30 minutos |

**Códigos, correos y seguridad**

| Dato | Cuánto |
|---|---|
| Códigos y enlaces por correo | Hasta que vencen: el código de alta, 15 minutos (60 como máximo si pides otro); «confirma que eres tú», 10 minutos; el enlace de alta, 24 horas; la contraseña olvidada, 30 minutos; deshacer un cambio de correo, 7 días; cancelar un borrado, hasta el día del borrado. Los borramos un día después |
| Un correo con el que alguien empezó una cuenta y no la terminó | Unos 2 días. Pasa aunque el correo sea de otra persona: por eso el código va siempre a ese correo |
| Tu correo anterior, después de cambiarlo | 7 días, para que puedas deshacer el cambio |
| Contadores contra abusos que duran (huellas con clave secreta) | De 1 minuto a 1 día. Se borran al día siguiente |
| Pausas por intentos fallidos | De 15 minutos a 1 hora para entrar con contraseña. 1 día para los códigos de un correo con muchos errores |
| Contadores cortos con tu IP (o el prefijo de tu red IPv6) | De segundos a minutos, en memoria. El del código de una TV, lo que vive el código |
| El prefijo de tu red IPv6, si tu conexión usa IPv6 | Mientras dura tu partida por servidor como invitado o la sala que creaste. Sirve para limitar cuántas abre una misma red |
| Código para conectar una TV | Solo en memoria. 4 minutos sin usar, hasta unos 28 minutos con renovaciones, y 5 minutos más |

**Partidas, salas y COMPETITIVO**

| Dato | Cuánto |
|---|---|
| Datos de una partida en curso | Lo que dura la partida. Un servidor los borra al terminar, como máximo 10 minutos después del tiempo de juego. Una sala P2P dura 20 minutos como máximo |
| Salas personalizadas | Se cierran a los 2 minutos sin nadie conectado, o a las 6 horas. Su lugar en la lista se borra al cerrarse (15 minutos después, si se cerró por una falla) |
| Abandonos en COMPETITIVO | 24 horas |
| Bloqueos de la cola | Hasta que terminan: de 5 minutos a 24 horas |
| Resultados de cada partida de COMPETITIVO | 30 días |
| Puntaje, estadísticas, entrenamiento, opciones, auto, puntos e ítems de anfitrión, «Ocultar mi nombre» y el registro de novedades | Mientras exista tu cuenta |
| Repeticiones públicas y sus datos | 30 días desde la partida |

**Anfitriones**

| Dato | Cuánto |
|---|---|
| Puntos de cada partida para el anfitrión (con el tiempo de cada jugador) | 30 días. Las notas contra las partidas repetidas para juntar puntos, 24 horas |
| Total de puntos de cada anfitrión | Sin plazo, también después de borrar la cuenta **[ABOGADO D24]** |
| Ficha de cada servidor de la comunidad | Sin plazo, también después de borrar la cuenta: el servidor queda bloqueado **[ABOGADO D24]** |
| Direcciones IP desde las que entran los servidores de la comunidad | 30 días |

**Registros y copias**

| Dato | Cuánto |
|---|---|
| Registros técnicos de Cloudflare | `[3 o 7]` días, según el plan de Cloudflare **[VERIFICAR V1]** |
| Registro de envíos de correo de Cloudflare (a quién, cuándo y si llegó) | Hasta 30 días, también después de borrar la cuenta **[VERIFICAR V3: la vista previa de mensajes, apagada]** |
| Registros de la máquina de São Paulo (pueden tener direcciones IP) | `[7 días]` **[CÓDIGO P29]**. Las copias de seguridad de `[PROVEEDOR DEL VPS]`: `[N DÍAS]` **[VERIFICAR V4]** |
| Señales de Turnstile que Cloudflare usa por su cuenta | Las fija Cloudflare. Su anexo no da un plazo |
| Reportes de errores de red y, si sigue, Web Analytics | Los fija Cloudflare **[VERIFICAR V10]** |
| Avisos técnicos al equipo en Discord | `[A CONFIRMAR: 90 días]` **[CÓDIGO P16 — ABOGADO D24]** |
| Copias de seguridad de Cloudflare | La base de datos se puede volver a cualquier momento de los últimos 30 días. Algo borrado puede seguir en esas copias hasta 30 días. Solo las usamos para reparar una falla **[A CONFIRMAR — ABOGADO D11]** |
| Tus pedidos sobre tus datos y nuestras respuestas | `[2 años]` desde la respuesta, para probar que respondimos **[ABOGADO D39]** |
| Lo que escribes a `[CORREO DE PRIVACIDAD]`, en el buzón de `[PROVEEDOR DEL BUZÓN]` | Lo mismo que tus pedidos |

**Borrado**

| Dato | Cuánto |
|---|---|
| Un pedido de borrado de la cuenta | 14 días. Después se borra la cuenta |
| Marcas de sanción | Hasta que termina la sanción, 1 año como máximo (sección 12.4) |
| El identificador de una cuenta borrada | Sin plazo: solo el número al azar y la fecha, sin nombre ni correo, para no volver a darlo **[ABOGADO D24]** |
| El almacenamiento de tu navegador | Hasta que lo borras. El de la pestaña, hasta que la cierras (sección 9) |

---

## 7. Tus derechos y cómo usarlos

### 7.1 Qué puedes pedir

- **Acceso:** una copia de tus datos. **Siempre gratis.** Solo podemos negarnos a un pedido
  claramente abusivo, y te decimos por qué.
- **Corrección y actualización:** que arreglemos un dato equivocado o viejo.
- **Borrado:** que borremos tus datos (sección 12).
- **Bloqueo o limitación:** que dejemos de usar un dato mientras revisamos un reclamo tuyo, o que
  lo guardemos sin usarlo en lugar de borrarlo, si lo prefieres.
- **Confidencialidad:** que un dato deje de mostrarse o de compartirse.
- **Oposición:** que dejemos de usar un dato que usamos por interés legítimo, o para novedades.
- **Portabilidad:** tus datos en un archivo que se pueda leer (JSON) **[CÓDIGO P20]**.
- **Retirar tu consentimiento** a las novedades, cuando quieras.
- **Revisión de una decisión automática** y una explicación de su lógica (sección 7.4).
- **Saber** con quién compartimos tus datos y qué pasa si no los das.

### 7.2 Cómo pedirlo

- **Escríbenos a `[CORREO DE PRIVACIDAD]` desde el correo de tu cuenta.** Así sabemos que eres
  tú. Si escribes desde otro correo, te mandamos un código al correo de tu cuenta, o te pedimos que
  entres a tu cuenta para confirmarlo.
- **Si tu cuenta no tiene correo,** entra al juego y agrega uno, o escríbenos con tu nombre de
  usuario y te decimos cómo confirmar que es tuya **[A CONFIRMAR]**.
- **Si jugaste como invitado,** no guardamos tu nombre ni tu correo. Tu número de invitado no
  alcanza para saber que eres tú: hay 9000 números y se repiten. Tu sesión vive en tu navegador y
  vence a las 24 horas. Lo que puede quedar con «Invitado NNNN» son repeticiones (30 días) y
  registros técnicos (`[3 o 7]` días). **Si nos das el número, la fecha y la hora aproximada,
  podemos sacar esas repeticiones.** No podemos darte una copia de datos que no podemos confirmar
  que son tuyos.
- **Nunca te pedimos tu documento** ni tu contraseña.

### 7.3 Plazos

- **Te respondemos en 10 días corridos como máximo.**
- **Corregimos o borramos en 5 días hábiles.**
- Esos plazos cumplen la ley argentina (Ley 25.326, arts. 14 y 16). También cumplen el mes del
  RGPD (art. 12.3) y los 15 días de la LGPD para una respuesta completa (art. 19).
- Es gratis. Solo podemos negar un pedido cuando la ley lo permite, por ejemplo para no dañar los
  derechos de otra persona. Si lo negamos, te explicamos por qué.

### 7.4 Decisiones automáticas

Estas decisiones las toma el juego solo, sin una persona:

- **Abandonar en COMPETITIVO:** si sales de una partida o no te presentas, no puedes buscar
  partida de COMPETITIVO por 5 minutos la primera vez, 15 la segunda, 1 hora la tercera y 24 horas
  desde la cuarta, dentro de 24 horas.
- **No presentarse en P2P:** si tomas 3 lugares en salas P2P sin conectarte en 10 minutos, no
  puedes buscar partidas P2P por 5 minutos. Las partidas por servidor siguen abiertas.
- **Partidas no verificadas:** una partida de COMPETITIVO en un servidor de la comunidad que no
  pasa la verificación automática no cuenta.
- **Servidores de la comunidad:** si una partida de tu servidor no pasa la verificación, el
  sistema suspende el servidor y pausa tus canjes hasta que una persona lo revise.
- **Marcas de sanción:** si una cuenta usa un correo o una cuenta de Discord o Google con una marca
  de sanción, recibe lo que quedaba de la sanción (sección 12.4).
- **Pausas al entrar:** muchos intentos fallidos pausan la entrada con contraseña o los códigos de
  un correo (sección 6).
- **Turnstile:** decide si tu navegador parece un bot. Si te rechaza, no puedes empezar como
  invitado ni entrar. Si te pasa, escríbenos.

El emparejamiento también usa tu puntaje para elegir rivales. Las reglas están en el código
fuente. **Puedes pedirnos que te expliquemos la lógica de estas decisiones, y que una persona
revise una sanción,** escribiendo a `[CORREO DE PRIVACIDAD]` **[ABOGADO D20]**.

### 7.5 Lo que puedes hacer tú mismo en el juego

- Cambiar tu nombre (una vez cada 30 días), tu correo y tu contraseña.
- Ver tus dispositivos, con su país y ciudad aproximados, y cerrar sesión en uno o en todos.
- Ocultar o mostrar tu nombre en las repeticiones públicas.
- Ocultar tu nombre en la clasificación **[CÓDIGO P25]**.
- Activar o apagar las novedades por correo.
- Borrar tu cuenta (sección 12) **[CÓDIGO P5]**.

### 7.6 Si no estás conforme

Puedes reclamar ante la autoridad de tu país:

- **Argentina:** la Agencia de Acceso a la Información Pública (AAIP),
  <https://www.argentina.gob.ar/aaip/datospersonales>. Ver la sección 16.
- **Brasil:** la Autoridade Nacional de Proteção de Dados (ANPD), <https://www.gov.br/anpd>.
- **Unión Europea:** la autoridad de protección de datos de tu país,
  <https://www.edpb.europa.eu/about-edpb/about-edpb/members_es>.
- **Reino Unido:** la Information Commissioner's Office (ICO), <https://ico.org.uk>.
- **Chile:** la Agencia de Protección de Datos Personales, desde el 1 de diciembre de 2026
  **[VERIFICAR — ABOGADO D19]**.
- **Colombia:** la Superintendencia de Industria y Comercio (SIC), <https://www.sic.gov.co>.
- **México:** la Secretaría Anticorrupción y Buen Gobierno **[ABOGADO D19]**.

---

## 8. Menores de edad

- **No te pedimos tu edad ni tu fecha de nacimiento** **[CÓDIGO P3: si se agrega la pregunta,
  cambia esta frase]**.
- **Para crear una cuenta tienes que tener `[EDAD MÍNIMA: 13]` años o más** **[A CONFIRMAR —
  ABOGADO D1]**. Si eres menor de 18, pide permiso a tu madre, padre o tutor y muéstrale esta
  política.
- **Para jugar como invitado no hace falta cuenta.** No te pedimos ningún dato. Si eres menor de
  edad, juega con permiso de un adulto responsable.
- **Novedades por correo:** solo desde los `[16]` años. La casilla lo pregunta **[A CONFIRMAR —
  ABOGADO D1, CÓDIGO P23, P28]**.
- **Si sabemos que una cuenta es de alguien menor de `[13]` años, la borramos** y no guardamos
  ninguna marca de sanción **[CÓDIGO P31]**. Si eres madre, padre o tutor y crees que tu hijo o
  hija nos dio datos, escríbenos a `[CORREO DE PRIVACIDAD]`. No hace falta que tengas cuenta.
- **Lo que el juego no tiene,** pensando en los más jóvenes: publicidad, perfiles para publicidad,
  compras, cajas de recompensas al azar ni chat.
- **Consejo:** si eres menor, usa un nombre que no sea tu nombre real, deja activado «Ocultar mi
  nombre en repeticiones públicas» y elige «Servidor» para no mostrar tu IP **[CÓDIGO P8]**.

> **Si tienes entre 13 y 17 años, lo importante:**
> - Usamos tu correo, tu nombre de usuario, tu dirección IP, el país y la ciudad aproximados de
>   tus dispositivos, y lo que haces en las partidas. **No te pedimos** tu nombre real, tu edad,
>   tu teléfono ni tu ubicación exacta.
> - Tu nombre se ve en la clasificación si estás entre los 100 mejores. En las repeticiones no se
>   ve, salvo que lo actives **[CÓDIGO P8, P25]**.
> - En P2P otros jugadores pueden ver tu IP. Elige «Servidor» si no quieres.
> - Puedes pedirnos que borremos todo. Pídele ayuda a un adulto si lo necesitas.

---

## 9. Cookies y almacenamiento en tu navegador

No usamos cookies de publicidad ni de rastreo entre sitios. Todo lo de esta sección es necesario
para que el juego funcione, para la seguridad o para recordar tus opciones. Por eso no mostramos
un aviso de cookies **[A CONFIRMAR — ABOGADO D5; CÓDIGO P13: es cierto solo con Web Analytics
apagado. Si se deja, se usa el texto de reemplazo de P13 y hace falta un aviso]**.

### 9.1 Cookies

Ninguna la puede leer el código de la página: solo viajan a nuestro servidor.

| Cookie | Para qué | Cuánto dura |
|---|---|---|
| `__Host-tg_rt` | Mantener tu sesión abierta | 30 días desde el último uso |
| `__Host-tg_dv` | Recordar que este navegador ya entró a tu cuenta con tu contraseña. Lleva el identificador de tu cuenta. Si alguien intenta adivinar tu contraseña desde otro lado, tú puedes seguir entrando | 180 días. **Queda aunque cierres sesión** |
| `__Host-tg_oa` | Proteger el ida y vuelta a Discord o Google | 10 minutos |
| `__Host-tg_pend` | Guardar un inicio con Discord o Google mientras eliges crear o vincular una cuenta. Lleva tu identificador y tu correo de ese servicio, firmados para que nadie los cambie | 30 minutos |
| Cookies de Cloudflare (`__cf_bm`, `cf_clearance`) **[VERIFICAR V6]** | Cloudflare las pone si detecta tráfico de bots | Las fija Cloudflare |

### 9.2 Almacenamiento local (queda hasta que lo borras)

| Qué | Para qué | Cuándo se borra |
|---|---|---|
| Tu sesión de invitado (`turbogol.guest`) | Seguir como el mismo invitado | Cuando borras los datos del sitio |
| «Continuar como…» (`turbogol.lastSignIn`): tu nombre de usuario y el método con que entraste. **Nunca tu correo** | Ofrecerte «Continuar como…» | **Queda después de cerrar sesión** |
| «Este navegador entró como…» (`turbogol.account`): tu nombre y tu identificador de cuenta | Saber quién entró en este navegador | Al cerrar sesión |
| Tus funciones experimentales y ajustes de física (`turbogol.experimental.v1.` y el identificador de tu cuenta) | Usarlos sin conexión | Quedan después de cerrar sesión |
| Tus récords de entrenamiento como invitado | Mostrártelos | Cuando borras los datos del sitio |
| Tus opciones: idioma, gráficos, controles, región, modo, conexión, auto, ayudas vistas | Recordarlas | Cuando borras los datos del sitio |
| El nivel de gráficos que falló en esta placa de video | No volver a usarlo | Cuando borras los datos del sitio |

### 9.3 Almacenamiento de la pestaña (se borra al cerrarla)

| Qué | Para qué | Cuánto |
|---|---|---|
| El paso del código de alta, **con el correo que escribiste** | No perder el alta si recargas | 30 minutos |
| El enlace que abriste desde un correo | Terminar ese pedido | Hasta 60 minutos |
| El idioma, la ventana abierta y el botón de inicio que tocaste | Volver al mismo lugar después de Discord o Google | 10 minutos |
| «Viniste a iniciar sesión» y la marca de la TV | Volver a la pantalla de antes | 30 minutos |
| La partida o la sala en la que estabas, **con la contraseña de la sala** | Volver a entrar si recargas | De 90 segundos a 2 horas |
| Datos para recuperar los gráficos | Recuperarse de un fallo | Hasta cerrar la pestaña |

### 9.4 Otras tecnologías

- **Texturas del estadio** guardadas en el navegador (`turbogol-world`). No tienen datos tuyos.
- **Cloudflare Turnstile** lee señales de tu navegador (tu IP, la versión del navegador y datos de
  la conexión) para saber si eres una persona. Corre al empezar como invitado, al conectar una TV
  y en cada inicio de sesión, alta o pedido de contraseña nueva.
- **Cloudflare Web Analytics** cuenta las visitas y mide cuánto tarda en cargar cada página: la
  dirección de la página, de qué sitio vienes, tu navegador, tu sistema, el tipo de dispositivo y
  tu país aproximado. No usa cookies. Cloudflare dice que no sigue a nadie entre sitios
  **[A CONFIRMAR — ABOGADO D5, VERIFICAR V10, CÓDIGO P13: si se apaga, se borra esta línea]**.
- **Reportes de errores de red:** nuestro sitio le pide a tu navegador que guarde una regla para
  avisarle a Cloudflare cuando un pedido a turbo-gol.com falla (la dirección y el tipo de error)
  **[ABOGADO D5, VERIFICAR V10]**.

**Cómo borrarlo:** en las opciones de tu navegador, borra los datos del sitio turbo-gol.com. Se
cierra tu sesión y vuelves a las opciones de fábrica.

---

## 10. Seguridad

- **Tu contraseña, tal como la escribes, no llega a nuestros servidores.** Tu navegador la
  transforma en una clave. Guardamos solo una huella de esa clave, con sal. En las cuentas que
  entraron desde `[FECHA DEL PR 4]`, la huella lleva además un secreto que no está en la base de
  datos **[VERIFICAR V15]**.
- **Las cookies de sesión** van cifradas por HTTPS y el código de la página no las puede leer.
- **Los contadores contra abusos que duran** guardan huellas con clave secreta, que no se pueden
  revertir, no tu correo, tu nombre ni tu IP. Los muy cortos usan tu IP y se borran solos
  (sección 6).
- **Te avisamos por correo** cada vez que cambia tu contraseña o tu correo, o cuando vinculas o
  desvinculas Discord o Google. Un cambio de correo se puede deshacer durante 7 días.
- **Los correos no tienen imágenes,** píxeles de seguimiento ni enlaces rastreados.
- **Los registros técnicos nunca guardan tu contraseña** ni el cuerpo de lo que envías al servidor
  (lo que escribes en los formularios).
- **Los registros técnicos guardan las direcciones pedidas.** Algunas llevan un identificador: el
  código de un solo uso de Discord o Google, el código de una sala, el de una partida y el
  identificador del enlace de baja de novedades, que no cambia hasta que te das de baja
  **[ABOGADO D25, CÓDIGO P21]**.
- **Los ingresos del equipo** generan un aviso en un canal interno, con el nombre, el método y el
  país, nunca la IP ni el correo.

Ningún sistema es perfecto. **Si pasa algo que pueda afectarte, te avisamos** y lo informamos a la
autoridad cuando la ley lo pida **[ABOGADO D29]**. Si encuentras una falla de seguridad, escríbenos
a `[CORREO DE PRIVACIDAD]` o sigue las instrucciones de turbo-gol.com/seguridad **[CÓDIGO P34]**.

---

## 11. Novedades por correo y cómo darte de baja

- **Solo si las pides.** Hay una casilla aparte, desmarcada, al crear la cuenta y al confirmar un
  inicio con Discord o Google. También puedes activarlas en PERFIL > «Novedades por correo»
  (necesitas un correo confirmado).
- **Qué son:** solo de Turbogol (funciones nuevas, eventos y torneos), como mucho `[2]` por mes.
  Nunca de otras empresas **[A CONFIRMAR]**.
- **Hoy no mandamos novedades.** Cuando empecemos, las mandará `[PROVEEDOR DE NOVEDADES]`, que
  agregaremos a la sección 4.1 antes del primer envío **[CÓDIGO P14]**.
- **Darte de baja es un clic:**
  - el enlace al pie de cada correo de novedades, que funciona sin entrar a tu cuenta;
  - el botón de baja de tu programa de correo;
  - o el interruptor de PERFIL.
- Cada baja por el enlace o por el botón de tu programa de correo cambia el identificador del
  enlace: el enlace de un correo viejo ya no hace nada.
- **Guardamos un registro** de cada alta y cada baja: qué elegiste, la versión del texto, de dónde
  vino y la fecha. Es para poder probar lo que pediste. **Ese registro se borra con tu cuenta**
  **[ABOGADO D13]**.
- **Los correos de tu cuenta no son novedades.** Los códigos, los enlaces y los avisos de
  seguridad te llegan aunque no pidas novedades. No llevan publicidad.

---

## 12. Borrado de la cuenta y marcas de sanción

### 12.1 Cómo pedirlo

- **Desde PERFIL** **[CÓDIGO P5]**: escribes tu nombre de usuario y confirmas que eres tú.
- **Por correo** a `[CORREO DE PRIVACIDAD]`, desde el correo de tu cuenta **[CÓDIGO P4]**.
- **Si tu cuenta está suspendida,** no puedes entrar: pídelo por correo **[CÓDIGO P4]**.
- **Si tu cuenta no tiene correo,** también puedes pedirlo. Te decimos cómo confirmar que es tuya.
- **Te mandamos una constancia del pedido en 72 horas como máximo:** por correo, si tu cuenta tiene
  uno, o en la pantalla, si lo pides desde PERFIL **[CÓDIGO P4, P5 — ABOGADO D34]**.

### 12.2 Qué pasa

1. **En el momento:**
   - se cierra tu sesión en todos los dispositivos;
   - sales de la clasificación;
   - tu nombre deja de verse en las repeticiones públicas **[CÓDIGO P25]**;
   - se cancelan tus novedades;
   - si lo pides desde este navegador, borramos aquí «Continuar como…», tus ajustes experimentales
     y la cookie de «navegador conocido» **[CÓDIGO P32]**;
   - si tu cuenta tiene correo, te mandamos un correo con un enlace para cancelar el borrado.
2. **Tienes 14 días para cancelar el borrado.** Entra a tu cuenta y elige cancelar, o usa el enlace
   del correo.
3. **A los 14 días borramos la cuenta** y todo lo que guarda: tu correo, tu nombre, tu contraseña,
   tus vínculos con Discord y Google, tus dispositivos, tu puntaje, tus estadísticas, tus opciones,
   tus puntos e ítems y tu registro de novedades.
4. **Si no quieres esperar los 14 días,** escríbenos y la borramos en 5 días hábiles
   **[CÓDIGO P4 — ABOGADO D11]**.

### 12.3 Lo que queda después

- **El identificador de la cuenta** (un número al azar), sin nombre ni correo, para no volver a
  darlo nunca.
- **Copias que vencen solas:**
  - las repeticiones y los puntos de anfitrión de tus partidas, hasta 30 días, con tu nombre
    oculto;
  - los registros técnicos (`[3 o 7]` días);
  - el registro de envíos de correo (hasta 30 días);
  - las copias de seguridad de Cloudflare (hasta 30 días).
- **Si eras anfitrión:** el total de tus puntos y la ficha de tus servidores, que quedan
  bloqueados. **Tu nombre de usuario deja de verse en la lista pública de servidores y en la tabla
  de anfitriones** **[CÓDIGO P26 — ABOGADO D24]**.
- **En otros navegadores:** la cookie de «navegador conocido» (hasta 180 días, con el
  identificador de tu cuenta), «Continuar como…» con tu nombre de usuario y, si usaste funciones
  experimentales, sus ajustes. Bórralos desde ese navegador (sección 9).
- **Lo que nos escribiste** y nuestras respuestas, por el plazo de la sección 6.
- **Las marcas de sanción** (abajo).

### 12.4 Marcas de sanción

Si borras una cuenta que tiene una sanción activa (una suspensión, un bloqueo de la cola, abandonos
de las últimas 24 horas que todavía cuentan o una partida de COMPETITIVO sin terminar):

- guardamos una **huella con clave secreta** (HMAC), que no se puede revertir, de su correo, del
  correo anterior si lo cambiaste hace menos de 7 días, del correo de Discord que teníamos como
  pista y de sus identificadores de Discord y Google **[ABOGADO D12]**;
- **no guardamos el correo ni los identificadores** en sí;
- la huella dura **hasta que termina la sanción, y 1 año como máximo**. Una suspensión sin fecha
  de fin cuenta como 1 año;
- si después ese correo, esa cuenta de Discord o esa cuenta de Google se usa en una cuenta de
  Turbogol (al crearla, al agregar o cambiar su correo, o al vincular Discord o Google), **esa
  cuenta recibe lo que quedaba de la sanción:** no puede jugar COMPETITIVO hasta la fecha en que
  terminaba la suspensión, el bloqueo o la partida sin terminar, y los abandonos que todavía
  contaban vuelven a contar. El resto del juego sigue abierto;
- hoy no te avisamos en ese momento **[ABOGADO D12; CÓDIGO P30: si se agrega el aviso, «te lo
  avisamos en PERFIL»]**;
- **si borramos una cuenta porque es de alguien menor de 13 años, no guardamos ninguna huella**
  **[CÓDIGO P31]**.

Es para que nadie borre su cuenta y vuelva con el historial limpio. Es un dato seudonimizado: con
la clave, nosotros podemos compararlo **[ABOGADO D12]**.

### 12.5 Si desvinculas Discord o Google

Borramos tu identificador de ese servicio. El correo de Discord que guardamos como pista se borra
cuando lo confirmas, cuando otra cuenta confirma esa dirección o cuando borras tu cuenta
**[CÓDIGO P6: cuando se borre también al desvincular, cambia esta frase]**.

---

## 13. Si Turbogol cierra o cambia de manos

- **Si cerramos Turbogol,** te avisamos al menos 30 días antes y borramos los datos de las cuentas
  en los `[30]` días siguientes al cierre. El código sigue disponible según su licencia.
- **Si Turbogol pasa a otra persona u organización,** te avisamos al menos 30 días antes, con su
  nombre y su contacto. Puedes borrar tu cuenta antes del cambio. Tus datos pasan solo como lo
  permita la ley **[ABOGADO D40]**.

---

## 14. Cambios en esta política

- Si cambiamos algo importante, te avisamos **al menos 30 días antes** en turbo-gol.com y, si
  tienes un correo confirmado, por correo **[CÓDIGO P15]**.
- Si un cambio necesita tu consentimiento, te lo pedimos de nuevo.
- Arriba siempre está la versión y la fecha. Guardamos las versiones anteriores en `[ENLACE A
  VERSIONES ANTERIORES]`.

---

## 15. Contacto

- **Privacidad, tus datos, borrado, reclamos, sanciones:** `[CORREO DE PRIVACIDAD]`.
- **Ayuda con el juego:** nuestro servidor de Discord.
- **Fallas de seguridad:** `[CORREO DE PRIVACIDAD]` o turbo-gol.com/seguridad **[CÓDIGO P34]**.
- **Por correo postal:** `[DIRECCIÓN POSTAL]` **[ABOGADO D18]**.

---

## 16. Autoridad de control en Argentina

Si crees que no cumplimos, también puedes reclamar ante la autoridad argentina:

> LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley
> N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes
> resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de
> protección de datos personales.

Sitio de la AAIP: <https://www.argentina.gob.ar/aaip/datospersonales>.

> **Nota para el borrador (borrar al publicar):** la leyenda es la de la Resolución AAIP 14/2018,
> art. 3, que derogó la Disposición DNPDP 10/2008. Se copia sin cambios. El art. 2 de esa
> resolución pide mostrar esta información antes de recolectar datos: va un aviso corto, con
> enlace, en el alta y al empezar como invitado **[CÓDIGO P2, P33]**.

---

## Anexo: detalles técnicos

Para quien quiera saber qué hay detrás de las palabras simples de esta política.

| En esta política | Nombre técnico |
|---|---|
| El alojamiento de Cloudflare | Cloudflare Workers, Durable Objects, KV y caché |
| El almacenamiento de las repeticiones | Cloudflare R2 |
| Los correos del juego | Cloudflare Email Service, desde `no-reply@turbo-gol.com` |
| Los correos que nos escribes | Cloudflare Email Routing, que reenvía al buzón de `[PROVEEDOR DEL BUZÓN]` |
| Conectar las partidas P2P y el relé | WebRTC, con STUN y TURN de Cloudflare |
| El control contra bots | Cloudflare Turnstile |
| La medición de visitas | Cloudflare Web Analytics (el *beacon* de RUM) |
| Los registros técnicos | Cloudflare Workers Logs |
| Los reportes de errores de red | Network Error Logging (encabezados `NEL` y `Report-To`) |
| Las texturas guardadas en el navegador | IndexedDB |
| La huella de tu contraseña | PBKDF2-SHA256, 100.000 vueltas, con sal y, desde `[FECHA DEL PR 4]`, un secreto (HMAC) |
| Huella con clave secreta | HMAC-SHA256 |
| El prefijo de tu red IPv6 | Los primeros 64 bits de tu dirección IPv6 (/64) |
