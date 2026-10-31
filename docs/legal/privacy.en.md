# Turbogol Privacy Policy

> **Informative translation.** The official text is the Spanish one, *Política de privacidad*
> (`privacidad.es.md`). If the two differ, the Spanish text prevails.
>
> **DRAFT for the owner and a lawyer. Not for publication as is.**
>
> - Version `[VERSIÓN]`. In force from `[FECHA DE VIGENCIA]`.
> - Built from the code on `main` `4fe7593` (read only), the sign-in design spec (the owner's
>   answers of 2026-10-29) and the studies `data-inventory.md`, `law-latam.md` and `law-intl.md`.
> - **Revision 2 (2026-10-30):** applies `review-legal.md` and `review-accuracy.md`. What was not
>   accepted, and why, is at the end of `preguntas-abogado.md` ("Revisión").
>
> **Draft markers. Resolve and remove them before publishing:**
>
> - `[IN BRACKETS]`: an owner fact that is missing. Never invented. The placeholders keep their
>   Spanish names so one find-and-replace fills both versions.
> - **[TO CONFIRM]**: a proposal. The owner and the lawyer decide.
> - **[LAWYER Dn]**: decision n in `preguntas-abogado.md`.
> - **[CODE Pn]**: the sentence is true only once the game has change n in `preguntas-abogado.md`.
>   **It is not published before.** If the change is not made, the replacement text in that row of
>   §3 of `preguntas-abogado.md` is used.
> - **[VERIFY Vn]**: a fact the owner must check in a dashboard or on a machine.

---

## Summary

- **Turbogol is a free game.** There are no payments, purchases or ads. We do not sell your data.
- **To play as a guest we ask you for nothing.** We use your IP address, what happens in the match
  and the browser signals the anti-bot check reviews.
- **For an account we use your email,** the name you choose and a hash of your password. Your
  password, as you type it, never reaches our servers.
- **Some things are public:** your name on the leaderboard, in the lobby list if you create a
  public lobby and, for 30 days, the replays of matches on community servers. You can hide your
  name (section 4.5).
- **In P2P matches, the other players receive your IP address,** even if the match ends up going
  through a relay. If you do not want that, choose "Server".
- **Whoever operates a community server sees your IP address** and the match.
- **Your data is stored outside Argentina:** at Cloudflare (including the United States) and on
  the project's server in Brazil.
- **You can ask us for a copy of your data, to correct it or to delete it** by writing to
  `[CORREO DE PRIVACIDAD]`. We answer within 10 calendar days at most.

---

## 1. Who is responsible for your data

| | |
|---|---|
| **Controller** | `[RESPONSABLE: nombre o razón social]` |
| **ID** | `[CUIT/DNI]` |
| **Address** | `[DOMICILIO]`, Argentina **[LAWYER D18]** |
| **Email for privacy matters** | `[CORREO DE PRIVACIDAD]` (proposal: `privacidad@turbo-gol.com`) |
| **Database registration** | National Registry of Databases of the AAIP, no. `[N.º DE INSCRIPCIÓN]` **[LAWYER D2]** |
| **Representative in the European Union** | `[REPRESENTANTE UE]` **[LAWYER D4: if none is appointed, the row is deleted]** |
| **Representative in the United Kingdom** | `[REPRESENTANTE UK]` **[LAWYER D4: if none is appointed, the row is deleted]** |
| **Representative in Brazil** | `[REPRESENTANTE EN BRASIL]` **[LAWYER D4, D15: if none is appointed, the row is deleted]** |

- Turbogol is made by one person, not a company **[TO CONFIRM]**. It is played at turbo-gol.com.
- **Data protection officer.** We have not appointed a data protection officer (GDPR) or an
  *encarregado* (LGPD). As a small processing agent, our channel for you is
  `[CORREO DE PRIVACIDAD]` **[TO CONFIRM — LAWYER D3]**.
- **General help** (questions about the game, bugs) is on our Discord server. **Requests about your
  data go by email** to `[CORREO DE PRIVACIDAD]`: you do not need Discord to exercise your rights.
- **`no-reply@turbo-gol.com`** is the address that sends the game's emails. It does not read
  replies.

---

## 2. What data we use and why

### 2.1 The table

| When | What data | Why |
|---|---|---|
| **You play as a guest** | A random identifier. The name "Guest NNNN", which comes from that identifier: you do not choose it. A session that lasts 24 hours. Your IP address | Give you a seat in the match. Prevent abuse (section 10) |
| **You create an account** | Your email, confirmed with a 6-digit code. The username you choose. A hash of your password. Your language and your time zone. The date you joined and the date of your last sign-in | Let you into your account. Send you the codes and security notices in your language and with your time |
| **Your account is an old one** | If it was created with recovery codes, the hash of those codes, until the cutoff date (section 2.5) | Let you recover your account until that date |
| **You sign in with Discord** | Discord sends us your basic profile data (for example, your Discord name and your picture) and your email. **We only read and keep your Discord identifier and your email.** We do not keep or use the rest | Find your account or create it. The Discord email stays as a hint until you confirm it with a code: before that we do not write to it |
| **You sign in with Google** (when available) | Your Google identifier and your email. Not your name or your picture | The same as with Discord |
| **You stay signed in** | A session cookie | So you do not have to sign in each time |
| **Each device with your session** | The type (browser or TV), the dates, the method you signed in with, and the **approximate country and city**, which Cloudflare derives from your IP | Show you in PROFILE where you are signed in, so you can sign out any device you do not recognise |
| **You play a match** | Your name, your car, your team and your controls (each key or movement). In a P2P match, your IP address | Play the match. Show the result |
| **You play COMPETITIVE** | Your rating, your matches, wins and losses, your peak rating, your abandons and your queue blocks | Match you with even opponents. The leaderboard. The penalties for abandoning |
| **You use a custom lobby** | The lobby's code, its title, its password (we keep only a hash), the members and their names. If you create it and your connection uses IPv6, your network prefix. New lobbies are private and P2P | Run the lobby. Limit how many lobbies one network opens |
| **You play on a community server** | Your name, your player identifier, your team, your controls and your IP address. How long you played and, if you have an account, how many days old it is. Afterwards, the match replay | Play the match. Check that the result is clean. Compute the host's points (30 days). Publish the replay |
| **You connect a TV with your phone** | The TV's code. The TV's approximate country, city, network and internet provider name. The IP address of the TV and of your phone, in memory only while the code lives | Let your phone show you which TV you are about to connect and whether it is on your network, so nobody tricks you with someone else's code. Stop failed attempts |
| **You change your options** | Your experimental physics presets (with their names), your training records, the experimental features switch, your car, "Hide my name in public replays" and "News by email" | Have your options follow you to any device |
| **You host a community server** | See section 4.4 | Run the server network |
| **You use the site** | In Cloudflare's technical logs: the address you request, the time, the response and what Cloudflare adds to each request, such as your IP address, your browser and your approximate country and city **[VERIFY V1]** | Run the service and find bugs |
| **You start as a guest, connect a TV or sign in** | The browser signals read by Cloudflare Turnstile, the anti-bot check: your IP, your browser and connection data | Stop bots |
| **You open a page** | If it stays on, Cloudflare Web Analytics: the page, the site you came from, your browser, your system, the device type, your approximate country and how long the page takes to load **[TO CONFIRM — LAWYER D5, CODE P13: if it is turned off, this row is deleted]**. The network error reports (section 9.4) | Measure visits and speed. Find network failures |
| **You ask for news** | Your choice (yes or no), the version of the text you accepted, where it came from (sign-up, PROFILE, an unsubscribe link or a deletion request) and the date | Send you news only if you asked for it, and be able to prove it |
| **You write to us** | Your message, your email and our answer, in the mailbox of `[PROVEEDOR DEL BUZÓN]` | Answer you and prove we answered in time |

### 2.2 What we do not ask for

- Your real name, your date of birth, your phone number, your ID document or payment data.
- Your contacts, your exact location, your camera or your microphone. The page asks the browser to
  block the camera, the microphone and location.
- **There is no chat** between players: no text, voice or video.

### 2.3 Where the data comes from

- **From you:** what you type and what you do in the game.
- **From Discord or Google,** if you sign in with them: your identifier and your email. Discord
  also sends us your basic profile data, which we do not keep.
- **From Cloudflare:** the approximate country and city it derives from your IP address.
- **From community servers:** the match replay.

### 2.4 What happens if you do not give a piece of data, or give a wrong one

- Without an email (or without Discord or Google) there is no account. **You can always play as a
  guest.**
- News is optional. Saying no changes nothing in the game.
- Without your IP address there is no internet connection: it is needed to play online.
- If you mistype your email, the codes and notices do not reach you, and we cannot recover your
  account by email.

### 2.5 Old accounts

Some old accounts have only a username and a password, with no email. We keep them all the same and
ask you to add an email or link Discord or Google. From the cutoff date `[FECHA DE CORTE]`, an
account without a confirmed email can no longer sign in with the password. We tell you at least 30
days ahead.

---

## 3. Legal bases

Each law asks us to say what each use rests on. This table sums them up.

| Use | Argentina (Ley 25.326) | Brazil (LGPD, Lei 13.709/2018) | European Union and United Kingdom (GDPR) |
|---|---|---|---|
| Playing, your account, matches, COMPETITIVE, the leaderboard, the TV, your account's emails and security notices | The relationship the Terms create: art. 5.2.d | Performance of the contract: art. 7 V | Performance of the contract: art. 6(1)(b) |
| Security, stopping bots and abuse, sanctions and sanction marks | The relationship of the Terms (art. 5.2.d) and the duty of security (art. 9) **[LAWYER D8]** | Legitimate interest: art. 7 IX | Legitimate interest: art. 6(1)(f) |
| Cloudflare improves Turnstile with your signals, on its own account | **[LAWYER D33]** | Legitimate interest of a third party: art. 7 IX | Legitimate interest: art. 6(1)(f) |
| Publishing your name on the leaderboard, in the public lobby list and in replays | The relationship of the Terms: arts. 5.2.d and 11.3.b **[LAWYER D9]** | Contract or legitimate interest: art. 7 V and IX | Contract (leaderboard) and legitimate interest (replays): art. 6(1)(b) and (f) |
| News by email | Your consent: arts. 5.1 and 27 | Your consent: art. 7 I | Your consent: art. 6(1)(a) |
| Keeping the record of what you accepted | The relationship of the Terms: art. 5.2.d | Exercise of rights: art. 7 VI | Duty to prove consent: arts. 6(1)(c) and 7(1) |
| Answering your requests and keeping the proof | Complying with the law: arts. 5.2.b, 14 and 16 **[LAWYER D39]** | Legal obligation: art. 7 II | Legal obligation: art. 6(1)(c) |
| Measuring visits (Web Analytics), if it stays on | **[TO CONFIRM — LAWYER D5]** | Legitimate interest: art. 7 IX | Your consent, under the ePrivacy Directive, art. 5(3) |
| Storing your data outside Argentina | **[TO CONFIRM — LAWYER D7]**: your express consent (Decreto 1558/2001, art. 12) or contractual clauses | Necessary for the contract: art. 33 IX | See section 5 |

**Legitimate interest** (outside Argentina) means: that the game be safe and fair for everyone. We
use the minimum. The abuse counters that last keep keyed hashes, not your email or your IP. The
ones that last seconds, minutes, or as long as a match or a lobby use your IP (or your IPv6 network
prefix) as it is, and are then deleted.

> **You can object** to any use we make on legitimate interest. Write to `[CORREO DE PRIVACIDAD]`
> and we stop, unless we have a stronger legitimate reason, which we explain to you.

**If you withdraw a consent**, it applies from that moment. What we did before stays valid.

---

## 4. Who else sees or receives your data

### 4.1 Providers who work for us

These providers process your data to provide their service to us. **There is one exception:**
Cloudflare also uses the Turnstile signals (your IP, your browser and connection data) on its own
account, as a controller, to improve its bot detection. Its [Turnstile privacy
addendum](https://www.cloudflare.com/turnstile-privacy-policy/) governs that. Cloudflare also uses
the network error reports to look after its own network **[VERIFY V10]**.

| Provider | Country | What it does | What data it sees |
|---|---|---|---|
| **Cloudflare, Inc.** | United States, with a worldwide network | See the list below | Everything we store, the IP address of each request and the emails we send you |
| **`[PROVEEDOR DEL VPS]`** **[VERIFY V4]** | Brazil | The machine of the project's server in São Paulo | Your IP address and the match, when you play on that server |
| **`[PROVEEDOR DEL BUZÓN]`** **[VERIFY V7]** | `[PAÍS DEL BUZÓN]` | The mailbox where we read and answer what you write to `[CORREO DE PRIVACIDAD]` | Your message and your email |
| **Discord, Inc.** | United States | The internal channel where the team receives technical alerts | See the list below. **Never a player's email or IP** |
| **`[PROVEEDOR DE NOVEDADES]`** | `[PAÍS DEL PROVEEDOR DE NOVEDADES]` | Sending the news, when we start | Your email and your language, only if you asked for news **[CODE P14]** |

**What Cloudflare does** (the technical names are in the annex):

- hosts the game and its data;
- sends the game's emails and receives the ones you write to us;
- helps connect P2P matches and, if the direct connection fails, acts as a relay;
- stops bots (Turnstile);
- measures visits and speed (Web Analytics), if it stays on **[TO CONFIRM — LAWYER D5, CODE P13]**;
- keeps technical logs and network error reports.

**What reaches the team's Discord channel:** the hosts' usernames, their servers and each one's
address, the country of a team sign-in, the identifier of an account the team grants or removes an
item on, match identifiers, and the reason the team types when it takes a replay down or blocks a
server. That reason may name a player.

Cloudflare's list of sub-processors is at <https://www.cloudflare.com/gdpr/subprocessors/>.

### 4.2 Discord and Google, if you sign in with them

- You start the sign-in on Discord's or Google's page. They know you used Turbogol, under their own
  policies.
- From Discord and Google we keep only your identifier and your email. We do not send them your
  game data.
- Turbogol's use and transfer to any other app of information received from Google APIs will adhere
  to the [Google API Services User Data
  Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited
  Use requirements.
- **Turbogol's Discord server:** what you write there is handled by Discord under its own policy.
  Our bot `[QUÉ LEE Y QUÉ GUARDA EL BOT]` **[VERIFY V12]**: that we handle ourselves, and this
  policy applies.

### 4.3 Other players

- **In each match** they see your name, your car and your team. In a lobby, the other members see
  your name.
- **In a P2P match,** your device connects directly to the other players' devices, even if you do
  not know them. **Each of them receives your public IP address.** From it one can roughly tell
  your city and your internet provider.
  - **When it is P2P:** in CASUAL with the "Auto" connection (the preselected one) or "P2P", and in
    P2P lobbies. New lobbies come with P2P selected. If you play alone, "Auto" gives you a server
    with bots.
  - **How to avoid it:** choose "Server" as the CASUAL connection, or switch your lobby to
    "Server". COMPETITIVE always uses a server.
  - If the direct connection fails, the game may route the match through a Cloudflare relay.
    **That does not hide your IP:** the game sends it while it tries the direct connection, before
    it uses the relay. The only way to keep it from them is to choose "Server".
  - We will tell you before each P2P match **[CODE P9]**.

### 4.4 Community servers and their hosts

- Some matches are played on community servers ("nodes"). Today **the only one is the project's
  own, in São Paulo (Brazil)**, on a machine of `[PROVEEDOR DEL VPS]`. It receives server matches
  and COMPETITIVE matches when it can take them **[VERIFY V14]**.
- **Later, community members will be able to run their own server.** Whoever operates it sees your
  name, your player identifier (the same in all your matches), your controls, what happens in the
  match and your IP address. The host rules (section 12 of the Terms) forbid them to keep or use
  that data for anything else **[LAWYER D14]**.
- **About hosts** we keep their username, each server's data (name, region, public address, which
  may be an IP, capacity, version and machine data), the IP addresses their servers sign in from
  (30 days) and their points.
- **Public:** the host's username next to their servers, and their points of the last 30 days. If
  the host does not choose a name for their server, the server's name contains their username.

### 4.5 The public

Anyone, without an account, can see:

| What | With what data | For how long | How to avoid it |
|---|---|---|---|
| **The leaderboard** of each mode | The top 100 with at least 5 matches in the season: name, rating (MMR), tier, matches and wins. Suspended accounts and accounts pending deletion do not appear | While you have an account | Turn on PROFILE > PRIVACY > "Hide my name on the leaderboard": your place then shows "Anonymous player" **[CODE P25 — LAWYER D9]** |
| **The public lobby list** | The lobby's title and its creator's name | While the lobby is open | New lobbies are private. Leave yours that way |
| **Public replays** | Matches on community servers: mode, region, result, length, whether it was COMPETITIVE, the rounded hour, each player's team and name, and **the whole match, with each player's every control, so it can be watched again**. Never your identifier or your IP. Published 1 to 2 hours after the match | 30 days | "Hide my name in public replays" comes **on**: your seat shows "Player N", in earlier matches too. Your name shows only if you turn it off in PROFILE > PRIVACY **[CODE P8 — TO CONFIRM, LAWYER D9]**. You can also ask us to take a replay down |
| **The community server list** | Each server's name, its host's username, the region, the status, the capacity and the points of 30 days | While the server exists. If the host deletes their account, their username stops showing **[CODE P26 — LAWYER D24]** | Concerns hosts only |

- A change to "Hide my name" reaches the list within a few minutes and copies already viewed within
  3 hours.
- Guests appear as "Guest NNNN".
- When you ask for your account's deletion, your name stops showing in replays, older ones included
  **[CODE P25]**.
- We ask search engines not to index replays. But someone can copy what is public while it shows,
  and we cannot undo that.

### 4.6 Authorities

We give data to an authority only when the law requires us to, with a formal request
**[TO CONFIRM]**.

### 4.7 What we never do

- We do not sell your data or share it for advertising.
- We do not show ads or build advertising profiles.
- We do not track what you do on other sites. That is why your browser's "Do Not Track" signal
  changes nothing here.

---

## 5. Data that leaves Argentina

| Where to | What | Why |
|---|---|---|
| **The United States and Cloudflare's network** | Everything we store. The match servers were measured in Miami **[VERIFY V2]**. Replays are stored in Cloudflare storage that has no South American region. Each request goes through the Cloudflare location nearest to you | Hosting the game |
| **The United States (Cloudflare, on its own account)** | The Turnstile signals | Improving its bot detection **[LAWYER D33]** |
| **Brazil** | Your IP and the match, on the project's server in São Paulo | Playing with low lag in South America |
| **The United States** | Your identifier and your email, if you sign in with Discord or Google | Your sign-in |
| **`[PAÍS DEL BUZÓN]`** | What you write to us | Reading and answering your requests **[VERIFY V7]** |
| **Each player's country** | Your IP, in P2P matches | The direct connection |
| **Each host's country** | Your IP and the match, once third-party servers open | Playing the match |

**For Argentina:** neither the United States nor Brazil is on the AAIP's list of countries with
adequate protection (Disposición DNPDP 60-E/2016, with Resolución AAIP 34/2019). So we rely on
`[TO CONFIRM — LAWYER D7: your express consent when you create the account, Cloudflare's data
processing agreement filed with the AAIP, or the AAIP's model clauses]`. **[CODE P17]** if it is
consent.

> **Draft note (delete when publishing):** this section **is not published** with the marker above
> unresolved. Without a mechanism, the Policy is exposed to art. 12 of Ley 25.326 and to Disp.
> SSDCyLC 377/2026, item ñ (see D7 and D30).

**For the European Union and the United Kingdom:** Argentina has an adequacy decision of the
European Commission (Decision 2003/490/EC), which the United Kingdom keeps. Cloudflare is in the
EU-US Data Privacy Framework and its agreement includes standard contractual clauses **[VERIFY
V8]**. Brazil has had EU adequacy since January 2026. You can ask us for a copy of these safeguards
at `[CORREO DE PRIVACIDAD]`.

**For Brazil:** the transfers rest on their being necessary for the contract (LGPD, art. 33 IX)
**[LAWYER D16]**.

---

## 6. How long we keep data

**Sessions and devices**

| Data | How long |
|---|---|
| Guest session | Valid for 24 hours. It stays in your browser until you start another one or clear the site's data |
| Account session | 1 hour. It renews itself while you play |
| Session cookie and each device's record (with approximate country and city) | 30 days from the last use. On a TV, 30 days from when you connected it, used or not |
| Device limit | 10 browsers and 5 TVs per account. Beyond that, the oldest session is signed out |
| When they are deleted sooner | When you sign out, sign out on every device or ask for the account's deletion. Changing the password deletes those of your other devices |
| "Known browser" cookie | 180 days. **It stays even if you sign out** |
| Discord or Google sign-in cookies | 10 minutes and 30 minutes |

**Codes, emails and security**

| Data | How long |
|---|---|
| Codes and links by email | Until they expire: the sign-up code, 15 minutes (60 at most if you ask for another); "confirm it's you", 10 minutes; the sign-up link, 24 hours; forgotten password, 30 minutes; undoing an email change, 7 days; cancelling a deletion, until the day of the deletion. We delete them one day later |
| An email someone started an account with and did not finish | About 2 days. This happens even if the email belongs to someone else: that is why the code always goes to that email |
| Your previous email, after you change it | 7 days, so you can undo the change |
| Abuse counters that last (keyed hashes) | From 1 minute to 1 day. Deleted the next day |
| Pauses after failed attempts | 15 minutes to 1 hour for signing in with a password. 1 day for the codes of an email with many errors |
| Short counters with your IP (or your IPv6 network prefix) | Seconds to minutes, in memory. A TV code's, as long as the code lives |
| Your IPv6 network prefix, if your connection uses IPv6 | While your server match as a guest, or the lobby you created, lasts. It limits how many one network opens |
| Code to connect a TV | In memory only. 4 minutes unused, up to about 28 minutes with renewals, and 5 more minutes |

**Matches, lobbies and COMPETITIVE**

| Data | How long |
|---|---|
| Data of a match in progress | As long as the match lasts. A server deletes it at the end, at most 10 minutes after the playing time. A P2P room lasts 20 minutes at most |
| Custom lobbies | They close after 2 minutes with nobody connected, or after 6 hours. Their place in the list is deleted when they close (15 minutes later, if they closed because of a failure) |
| Abandons in COMPETITIVE | 24 hours |
| Queue blocks | Until they end: from 5 minutes to 24 hours |
| Results of each COMPETITIVE match | 30 days |
| Rating, stats, training, options, car, host points and items, "Hide my name" and the news record | While your account exists |
| Public replays and their data | 30 days from the match |

**Hosts**

| Data | How long |
|---|---|
| Points of each match for the host (with each player's time) | 30 days. The notes against repeated matches to farm points, 24 hours |
| Each host's points total | No limit, also after the account is deleted **[LAWYER D24]** |
| Each community server's record | No limit, also after the account is deleted: the server stays blocked **[LAWYER D24]** |
| IP addresses community servers sign in from | 30 days |

**Logs and copies**

| Data | How long |
|---|---|
| Cloudflare's technical logs | `[3 o 7]` days, depending on the Cloudflare plan **[VERIFY V1]** |
| Cloudflare's email sending log (to whom, when, and whether it arrived) | Up to 30 days, also after the account is deleted **[VERIFY V3: message preview off]** |
| Logs of the São Paulo machine (may hold IP addresses) | `[7 días]` **[CODE P29]**. The backups of `[PROVEEDOR DEL VPS]`: `[N DÍAS]` **[VERIFY V4]** |
| Turnstile signals Cloudflare uses on its own account | Set by Cloudflare. Its addendum gives no period |
| Network error reports and, if it stays on, Web Analytics | Set by Cloudflare **[VERIFY V10]** |
| Technical alerts to the team on Discord | `[TO CONFIRM: 90 days]` **[CODE P16 — LAWYER D24]** |
| Cloudflare backups | The database can be restored to any moment of the last 30 days. Something deleted may remain in those copies for up to 30 days. We use them only to repair a failure **[TO CONFIRM — LAWYER D11]** |
| Your requests about your data and our answers | `[2 años]` from the answer, to prove we answered **[LAWYER D39]** |
| What you write to `[CORREO DE PRIVACIDAD]`, in the mailbox of `[PROVEEDOR DEL BUZÓN]` | The same as your requests |

**Deletion**

| Data | How long |
|---|---|
| An account deletion request | 14 days. Then the account is deleted |
| Sanction marks | Until the sanction ends, 1 year at most (section 12.4) |
| The identifier of a deleted account | No limit: only the random number and the date, with no name or email, so it is never handed out again **[LAWYER D24]** |
| Your browser's storage | Until you clear it. The tab's, until you close it (section 9) |

---

## 7. Your rights and how to use them

### 7.1 What you can ask for

- **Access:** a copy of your data. **Always free.** We can refuse only a clearly abusive request,
  and we tell you why.
- **Correction and update:** that we fix a wrong or outdated piece of data.
- **Deletion:** that we delete your data (section 12).
- **Blocking or restriction:** that we stop using a piece of data while we review a complaint of
  yours, or that we keep it without using it instead of deleting it, if you prefer.
- **Confidentiality:** that a piece of data stops being shown or shared.
- **Objection:** that we stop using data we use on legitimate interest, or for news.
- **Portability:** your data in a readable file (JSON) **[CODE P20]**.
- **Withdrawing your consent** to news, whenever you want.
- **Review of an automated decision** and an explanation of its logic (section 7.4).
- **Knowing** whom we share your data with and what happens if you do not give it.

### 7.2 How to ask

- **Write to `[CORREO DE PRIVACIDAD]` from your account's email.** That way we know it is you. If
  you write from another email, we send a code to your account's email, or ask you to sign in to
  your account to confirm it.
- **If your account has no email,** sign in to the game and add one, or write to us with your
  username and we tell you how to confirm it is yours **[TO CONFIRM]**.
- **If you played as a guest,** we do not keep your name or your email. Your guest number is not
  enough to know it is you: there are 9,000 numbers and they repeat. Your session lives in your
  browser and expires after 24 hours. What may remain under "Guest NNNN" is replays (30 days) and
  technical logs (`[3 o 7]` days). **If you give us the number, the date and the approximate time,
  we can take those replays down.** We cannot give you a copy of data we cannot confirm is yours.
- **We never ask for your ID document** or your password.

### 7.3 Deadlines

- **We answer within 10 calendar days at most.**
- **We correct or delete within 5 business days.**
- Those deadlines meet Argentine law (Ley 25.326, arts. 14 and 16). They also meet the GDPR's month
  (art. 12(3)) and the LGPD's 15 days for a full answer (art. 19).
- It is free. We can refuse a request only when the law allows it, for example so as not to harm
  another person's rights. If we refuse, we explain why.

### 7.4 Automated decisions

The game takes these decisions on its own, without a person:

- **Abandoning in COMPETITIVE:** if you leave a match or do not show up, you cannot search for a
  COMPETITIVE match for 5 minutes the first time, 15 the second, 1 hour the third and 24 hours from
  the fourth, within 24 hours.
- **Not showing up in P2P:** if you take 3 seats in P2P rooms without connecting within 10 minutes,
  you cannot search for P2P matches for 5 minutes. Server matches stay open.
- **Unverified matches:** a COMPETITIVE match on a community server that fails the automatic
  verification does not count.
- **Community servers:** if a match on your server fails verification, the system suspends the
  server and pauses your redemptions until a person reviews it.
- **Sanction marks:** if an account uses an email or a Discord or Google account with a sanction
  mark, it gets what was left of the sanction (section 12.4).
- **Sign-in pauses:** many failed attempts pause signing in with a password or the codes of an
  email (section 6).
- **Turnstile:** it decides whether your browser looks like a bot. If it rejects you, you cannot
  start as a guest or sign in. If that happens, write to us.

Matchmaking also uses your rating to choose opponents. The rules are in the source code. **You can
ask us to explain the logic of these decisions, and for a person to review a sanction,** by writing
to `[CORREO DE PRIVACIDAD]` **[LAWYER D20]**.

### 7.5 What you can do yourself in the game

- Change your name (once every 30 days), your email and your password.
- See your devices, with their approximate country and city, and sign out of one or all of them.
- Hide or show your name in public replays.
- Hide your name on the leaderboard **[CODE P25]**.
- Turn news by email on or off.
- Delete your account (section 12) **[CODE P5]**.

### 7.6 If you are not satisfied

You can complain to the authority of your country:

- **Argentina:** the Agencia de Acceso a la Información Pública (AAIP),
  <https://www.argentina.gob.ar/aaip/datospersonales>. See section 16.
- **Brazil:** the Autoridade Nacional de Proteção de Dados (ANPD), <https://www.gov.br/anpd>.
- **European Union:** your country's data protection authority,
  <https://www.edpb.europa.eu/about-edpb/about-edpb/members_en>.
- **United Kingdom:** the Information Commissioner's Office (ICO), <https://ico.org.uk>.
- **Chile:** the Agencia de Protección de Datos Personales, from 1 December 2026
  **[VERIFY — LAWYER D19]**.
- **Colombia:** the Superintendencia de Industria y Comercio (SIC), <https://www.sic.gov.co>.
- **Mexico:** the Secretaría Anticorrupción y Buen Gobierno **[LAWYER D19]**.

---

## 8. Minors

- **We do not ask for your age or your date of birth** **[CODE P3: if the question is added, this
  sentence changes]**.
- **To create an account you must be `[EDAD MÍNIMA: 13]` or older** **[TO CONFIRM —
  LAWYER D1]**. If you are under 18, ask your mother, father or guardian for permission and show
  them this policy.
- **To play as a guest you need no account.** We ask you for no data. If you are a minor, play with
  a responsible adult's permission.
- **News by email:** only from age `[16]`. The box asks about it **[TO CONFIRM — LAWYER D1,
  CODE P23, P28]**.
- **If we learn that an account belongs to someone under `[13]`, we delete it** and keep no
  sanction mark **[CODE P31]**. If you are a mother, father or guardian and think your child gave us
  data, write to `[CORREO DE PRIVACIDAD]`. You do not need an account.
- **What the game does not have,** with younger players in mind: ads, advertising profiles,
  purchases, random reward boxes or chat.
- **Tip:** if you are a minor, use a name that is not your real name, leave "Hide my name in public
  replays" on and choose "Server" so as not to show your IP **[CODE P8]**.

> **If you are between 13 and 17, what matters:**
> - We use your email, your username, your IP address, the approximate country and city of your
>   devices, and what you do in matches. **We do not ask for** your real name, your age, your phone
>   number or your exact location.
> - Your name shows on the leaderboard if you are in the top 100. In replays it does not show,
>   unless you turn it on **[CODE P8, P25]**.
> - In P2P other players can see your IP. Choose "Server" if you do not want that.
> - You can ask us to delete everything. Ask an adult for help if you need it.

---

## 9. Cookies and storage in your browser

We use no advertising cookies and no cross-site tracking. Everything in this section is needed for
the game to work, for security or to remember your options. That is why we show no cookie notice
**[TO CONFIRM — LAWYER D5; CODE P13: true only with Web Analytics off. If it stays, the P13
replacement text is used and a notice is needed]**.

### 9.1 Cookies

None can be read by the page's code: they only travel to our server.

| Cookie | Why | How long |
|---|---|---|
| `__Host-tg_rt` | Keep you signed in | 30 days from the last use |
| `__Host-tg_dv` | Remember that this browser has signed in to your account with your password before. It carries your account identifier. If someone tries to guess your password from elsewhere, you can still sign in | 180 days. **It stays even if you sign out** |
| `__Host-tg_oa` | Protect the round trip to Discord or Google | 10 minutes |
| `__Host-tg_pend` | Hold a Discord or Google sign-in while you choose to create or link an account. It carries your identifier and your email from that service, signed so nobody can change them | 30 minutes |
| Cloudflare cookies (`__cf_bm`, `cf_clearance`) **[VERIFY V6]** | Cloudflare sets them if it detects bot traffic | Set by Cloudflare |

### 9.2 Local storage (stays until you clear it)

| What | Why | When it is deleted |
|---|---|---|
| Your guest session (`turbogol.guest`) | Stay the same guest | When you clear the site's data |
| "Continue as…" (`turbogol.lastSignIn`): your username and the method you signed in with. **Never your email** | Offer you "Continue as…" | **It stays after you sign out** |
| "This browser signed in as…" (`turbogol.account`): your name and your account identifier | Know who signed in on this browser | When you sign out |
| Your experimental features and physics presets (`turbogol.experimental.v1.` plus your account identifier) | Use them offline | They stay after you sign out |
| Your training records as a guest | Show them to you | When you clear the site's data |
| Your options: language, graphics, controls, region, mode, connection, car, tips seen | Remember them | When you clear the site's data |
| The graphics level that failed on this graphics card | Not use it again | When you clear the site's data |

### 9.3 Tab storage (deleted when you close the tab)

| What | Why | How long |
|---|---|---|
| The sign-up code step, **with the email you typed** | Not lose the sign-up if you reload | 30 minutes |
| The link you opened from an email | Finish that request | Up to 60 minutes |
| The language, the open window and the sign-in button you pressed | Return to the same place after Discord or Google | 10 minutes |
| "You came here to sign in" and the TV marker | Return to the screen you were on | 30 minutes |
| The match or lobby you were in, **with the lobby's password** | Get back in if you reload | From 90 seconds to 2 hours |
| Graphics recovery data | Recover from a failure | Until you close the tab |

### 9.4 Other technologies

- **Stadium textures** stored in the browser (`turbogol-world`). They hold no data about you.
- **Cloudflare Turnstile** reads signals from your browser (your IP, the browser version and
  connection data) to tell whether you are a person. It runs when you start as a guest, when you
  connect a TV and on each sign-in, sign-up or request for a new password.
- **Cloudflare Web Analytics** counts visits and measures how long each page takes to load: the
  page's address, the site you came from, your browser, your system, the device type and your
  approximate country. It uses no cookies. Cloudflare says it does not follow anyone across sites
  **[TO CONFIRM — LAWYER D5, VERIFY V10, CODE P13: if it is turned off, delete this line]**.
- **Network error reports:** our site asks your browser to store a rule to tell Cloudflare when a
  request to turbo-gol.com fails (the address and the type of error) **[LAWYER D5, VERIFY V10]**.

**How to clear it:** in your browser's settings, clear the site data for turbo-gol.com. You are
signed out and go back to the default options.

---

## 10. Security

- **Your password, as you type it, does not reach our servers.** Your browser turns it into a key.
  We keep only a hash of that key, with a salt. On accounts that have signed in since
  `[FECHA DEL PR 4]`, the hash also carries a secret that is not in the database **[VERIFY V15]**.
- **Session cookies** travel encrypted over HTTPS and the page's code cannot read them.
- **The abuse counters that last** keep keyed hashes, which cannot be reversed, not your email,
  your name or your IP. The very short ones use your IP and delete themselves (section 6).
- **We tell you by email** every time your password or your email changes, or when you link or
  unlink Discord or Google. An email change can be undone for 7 days.
- **Our emails have no images,** tracking pixels or tracked links.
- **Technical logs never keep your password** or the body of what you send to the server (what you
  type in forms).
- **Technical logs keep the addresses requested.** Some carry an identifier: the single-use code
  from Discord or Google, a lobby's code, a match's, and the identifier of the news unsubscribe
  link, which does not change until you unsubscribe **[LAWYER D25, CODE P21]**.
- **Team sign-ins** raise an alert on an internal channel, with the name, the method and the
  country, never the IP or the email.

No system is perfect. **If something happens that may affect you, we tell you** and we report it
to the authority when the law requires it **[LAWYER D29]**. If you find a security flaw, write to
`[CORREO DE PRIVACIDAD]` or follow the instructions at turbo-gol.com/seguridad **[CODE P34]**.

---

## 11. News by email and how to unsubscribe

- **Only if you ask for it.** There is a separate, unticked box when you create the account and
  when you confirm a Discord or Google sign-in. You can also turn it on in PROFILE > "News by
  email" (you need a confirmed email).
- **What it is:** only Turbogol's (new features, events and tournaments), at most `[2]` a month.
  Never from other companies **[TO CONFIRM]**.
- **Today we send no news.** When we start, `[PROVEEDOR DE NOVEDADES]` will send it, and we will
  add it to section 4.1 before the first mailing **[CODE P14]**.
- **Unsubscribing takes one click:**
  - the link at the foot of each news email, which works without signing in;
  - your email program's unsubscribe button;
  - or the switch in PROFILE.
- Each unsubscribe through the link or your email program's button changes the link's identifier:
  an old email's link no longer does anything.
- **We keep a record** of each opt-in and each opt-out: what you chose, the version of the text,
  where it came from and the date. It is so we can prove what you asked for. **That record is
  deleted with your account** **[LAWYER D13]**.
- **Your account's emails are not news.** Codes, links and security notices reach you even if you
  do not ask for news. They carry no advertising.

---

## 12. Account deletion and sanction marks

### 12.1 How to ask for it

- **From PROFILE** **[CODE P5]**: you type your username and confirm it is you.
- **By email** to `[CORREO DE PRIVACIDAD]`, from your account's email **[CODE P4]**.
- **If your account is suspended,** you cannot sign in: ask by email **[CODE P4]**.
- **If your account has no email,** you can ask too. We tell you how to confirm it is yours.
- **We send you a confirmation of the request within 72 hours at most:** by email, if your account
  has one, or on the screen, if you ask from PROFILE **[CODE P4, P5 — LAWYER D34]**.

### 12.2 What happens

1. **At once:**
   - you are signed out on every device;
   - you leave the leaderboard;
   - your name stops showing in public replays **[CODE P25]**;
   - your news is cancelled;
   - if you ask from this browser, we delete "Continue as…", your experimental settings and the
     "known browser" cookie here **[CODE P32]**;
   - if your account has an email, we send you an email with a link to cancel the deletion.
2. **You have 14 days to cancel the deletion.** Sign in to your account and choose to cancel, or use
   the link in the email.
3. **After 14 days we delete the account** and everything it holds: your email, your name, your
   password, your links to Discord and Google, your devices, your rating, your stats, your
   options, your points and items, and your news record.
4. **If you do not want to wait 14 days,** write to us and we delete it within 5 business days
   **[CODE P4 — LAWYER D11]**.

### 12.3 What remains afterwards

- **The account's identifier** (a random number), with no name or email, so it is never handed out
  again.
- **Copies that expire on their own:**
  - the replays and host points of your matches, up to 30 days, with your name hidden;
  - the technical logs (`[3 o 7]` days);
  - the email sending log (up to 30 days);
  - Cloudflare's backups (up to 30 days).
- **If you were a host:** your points total and your servers' records, which stay blocked. **Your
  username stops showing in the public server list and in the hosts' table**
  **[CODE P26 — LAWYER D24]**.
- **In other browsers:** the "known browser" cookie (up to 180 days, with your account
  identifier), "Continue as…" with your username and, if you used experimental features, their
  settings. Clear them from that browser (section 9).
- **What you wrote to us** and our answers, for the period in section 6.
- **Sanction marks** (below).

### 12.4 Sanction marks

If you delete an account that has an active sanction (a suspension, a queue block, abandons of the
last 24 hours that still count, or an unfinished COMPETITIVE match):

- we keep a **keyed hash** (HMAC), which cannot be reversed, of its email, of the previous email if
  you changed it less than 7 days before, of the Discord email we held as a hint and of its Discord
  and Google identifiers **[LAWYER D12]**;
- **we do not keep the email or the identifiers** themselves;
- the hash lasts **until the sanction ends, and 1 year at most**. A suspension with no end date
  counts as 1 year;
- if that email, that Discord account or that Google account is later used on a Turbogol account
  (when it is created, when its email is added or changed, or when Discord or Google is linked),
  **that account gets what was left of the sanction:** it cannot play COMPETITIVE until the date the
  suspension, the block or the unfinished match would have ended, and the abandons that still
  counted count again. The rest of the game stays open;
- today we do not tell you at that moment **[LAWYER D12; CODE P30: if the notice is added, "we tell
  you in PROFILE"]**;
- **if we delete an account because it belongs to someone under 13, we keep no hash**
  **[CODE P31]**.

It is so that nobody deletes their account and comes back with a clean record. It is pseudonymised
data: with the key, we can compare it **[LAWYER D12]**.

### 12.5 If you unlink Discord or Google

We delete your identifier for that service. The Discord email we keep as a hint is deleted when you
confirm it, when another account confirms that address or when you delete your account **[CODE P6:
when it is also deleted on unlink, this sentence changes]**.

---

## 13. If Turbogol closes or changes hands

- **If we close Turbogol,** we tell you at least 30 days ahead and delete the accounts' data within
  the `[30]` days after the closure. The code stays available under its licence.
- **If Turbogol passes to another person or organisation,** we tell you at least 30 days ahead,
  with their name and contact. You can delete your account before the change. Your data passes only
  as the law allows **[LAWYER D40]**.

---

## 14. Changes to this policy

- If we change something important, we tell you **at least 30 days ahead** on turbo-gol.com and,
  if you have a confirmed email, by email **[CODE P15]**.
- If a change needs your consent, we ask you for it again.
- The version and the date are always at the top. We keep earlier versions at `[ENLACE A VERSIONES
  ANTERIORES]`.

---

## 15. Contact

- **Privacy, your data, deletion, complaints, sanctions:** `[CORREO DE PRIVACIDAD]`.
- **Help with the game:** our Discord server.
- **Security flaws:** `[CORREO DE PRIVACIDAD]` or turbo-gol.com/seguridad **[CODE P34]**.
- **By post:** `[DIRECCIÓN POSTAL]` **[LAWYER D18]**.

---

## 16. Supervisory authority in Argentina

If you think we do not comply, you can also complain to the Argentine authority:

> THE AGENCY OF ACCESS TO PUBLIC INFORMATION, in its capacity as Supervisory Body of Law No. 25,326,
> has the power to handle the complaints and claims filed by those whose rights are affected by
> non-compliance with the rules in force on the protection of personal data.

The AAIP's site: <https://www.argentina.gob.ar/aaip/datospersonales>.

> *(Translator's note: the Spanish text of this legend, in `privacidad.es.md`, is the one set by
> Resolución AAIP 14/2018, art. 3. The English above is an informative translation of it.)*
>
> **Draft note (delete when publishing):** the legend is that of Resolución AAIP 14/2018, art. 3,
> which repealed Disposición DNPDP 10/2008. The Spanish is copied verbatim. Art. 2 of that
> resolution requires this information to be shown before data is collected: a short notice with a
> link goes on the sign-up form and at the guest start **[CODE P2, P33]**.

---

## Annex: technical details

For anyone who wants to know what lies behind this policy's plain words.

| In this policy | Technical name |
|---|---|
| Cloudflare's hosting | Cloudflare Workers, Durable Objects, KV and cache |
| Where replays are stored | Cloudflare R2 |
| The game's emails | Cloudflare Email Service, from `no-reply@turbo-gol.com` |
| The emails you write to us | Cloudflare Email Routing, which forwards to the mailbox of `[PROVEEDOR DEL BUZÓN]` |
| Connecting P2P matches and the relay | WebRTC, with Cloudflare's STUN and TURN |
| The anti-bot check | Cloudflare Turnstile |
| Measuring visits | Cloudflare Web Analytics (the RUM beacon) |
| Technical logs | Cloudflare Workers Logs |
| Network error reports | Network Error Logging (the `NEL` and `Report-To` headers) |
| Textures stored in the browser | IndexedDB |
| Your password's hash | PBKDF2-SHA256, 100,000 rounds, with a salt and, since `[FECHA DEL PR 4]`, a secret (HMAC) |
| Keyed hash | HMAC-SHA256 |
| Your IPv6 network prefix | The first 64 bits of your IPv6 address (/64) |
