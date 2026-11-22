# Picnic MCP

Maakt je Picnic-account bereikbaar voor Claude (zoeken, aanbiedingen, prijzen, winkelmandje).
Gebaseerd op [mcp-picnic](https://github.com/ivo-toby/mcp-picnic) (onofficiële Picnic-API, MIT).

## Instellingen

| Optie | Uitleg |
|---|---|
| `picnic_username` | E-mailadres van je Picnic-account |
| `picnic_password` | Wachtwoord van je Picnic-account |
| `country_code` | `NL` |
| `auth_token` | Leeg laten: de add-on maakt zelf een sterk token en zet het in het log |
| `blocked_tools` | Tools die Claude niet mag gebruiken (standaard: bezorging annuleren, bezorgslot kiezen, mandje leegmaken, betaal-/walletgegevens, factuur mailen, recepten opslaan) |

## Beveiliging

- Alleen `/health` en `/mcp` zijn bereikbaar; `/mcp` vereist het token.
- Token meesturen kan op drie manieren: `Authorization: Bearer <token>`, `x-api-key: <token>`, of in het pad: `https://<host>/<token>/mcp`.
- mcp-picnic zelf draait alleen op 127.0.0.1 in de container.
- Inlogsessie en device-id staan in `/data` en blijven bewaard bij herstarts.

## Koppelen aan Claude

1. Start de add-on en kopieer het connector-pad uit het **Log**-tabblad.
2. Voeg in de Cloudflared-add-on een extra host toe die naar `http://<hostname-van-deze-add-on>:8099` wijst
   (de hostname staat op het **Info**-tabblad van deze add-on).
3. Claude → Instellingen → Connectors → Eigen connector toevoegen → URL `https://<jouw-host>/<token>/mcp`.
4. Eerste keer: vraag Claude om in te loggen bij Picnic; bij een sms-code roept Claude
   `picnic_generate_2fa_code` en daarna `picnic_verify_2fa_code` aan.

## Token vervangen

Verwijder `/data/auth_token` (of vul zelf een `auth_token` in) en herstart de add-on.
