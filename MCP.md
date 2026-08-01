# Accesso via MCP

PCB Studio espone i propri strumenti di progettazione via MCP: un agente
esterno (Claude Code, un connettore, uno script) puo' progettare schede con
il proprio modello, usando lo stesso motore dell'app.

**Perche' conviene**: l'agente lo paghi gia' tu. Il modello che usi ogni
giorno (Claude Code, o qualsiasi altro client MCP) si collega al server MCP
di PCB Studio e lavora coi suoi strumenti — nessuna chiave API aggiuntiva da
mantenere, nessun costo per token lato app.

## Strumenti

| Strumento | Cosa fa |
|---|---|
| `list_projects` | progetti accessibili al token |
| `read_project` | legge i file tscircuit (il codice E' il progetto) |
| `write_file` | scrive un file (contenuto completo, niente diff) |
| `compile` | instrada il PCB, esegue il DRC, restituisce errori e geometria |
| `inspect_board` | problemi con posizione + componenti con coordinate e reti |
| `search_parts` | componenti reali a magazzino su JLCPCB |
| `import_component_from_lcsc` | footprint e simbolo reali di un part LCSC |
| `library_list` / `library_read` / `library_save` | componenti riusabili in libreria |
| `list_datasheets` / `read_datasheet` / `fetch_datasheet_url` | datasheet del progetto |
| `simulate` | simulazione SPICE di un sottocircuito |
| `pick_variant` | sceglie una variante di routing per sezione |
| `export_urls` | link a gerber, distinta, pick & place |

Il Circuit JSON **non** e' una superficie di scrittura: la verita' e' il
codice tscircuit, e ogni modifica passa da `write_file` + `compile`. Un
agente che manipolasse il JSON vedrebbe il proprio lavoro sparire alla
compilazione dopo.

## Collegamento in 2 passi

1. **Genera un token personale**: nell'app, sezione **Team** → *Accesso da
   agenti esterni (MCP)* → **Genera token**. Il token si vede una volta sola
   (nel database resta solo il suo hash) e vale quanto il tuo utente: stessa
   ACL, stessi progetti, niente scorciatoie.
2. **Registra il server** nel tuo client MCP. Con Claude Code:

   ```bash
   claude mcp add --transport http pcb-studio https://pcb-studio.vercel.app/api/mcp/mcp \
     --header "Authorization: Bearer pcbs_iltuotoken"
   ```

   Con qualsiasi altro client MCP: stesso URL, header
   `Authorization: Bearer pcbs_...` — il transport e' HTTP (streamable).
   Self-hosting? Usa l'origin del tuo deployment, il resto non cambia.

L'autenticazione e' il solo cancello: niente SSO Vercel davanti, il token
personale basta.

## Esempio di sessione

> «Apri il progetto bat-bs, guarda i problemi di piazzamento e sistemali:
> sposta i componenti che si sovrappongono, ricompila e dimmi quante
> connessioni restano non instradate.»
