# Accesso via MCP

PCB Studio espone i propri strumenti di progettazione via MCP: un agente esterno
(Claude Code, un connettore, uno script) puo' progettare schede con il proprio
modello, usando lo stesso motore dell'app.

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
| `library_list` | componenti riusabili in libreria |
| `export_urls` | link a gerber, distinta, pick & place |

Il Circuit JSON **non** e' una superficie di scrittura: la verita' e' il codice
tscircuit, e ogni modifica passa da `write_file` + `compile`. Un agente che
manipolasse il JSON vedrebbe il proprio lavoro sparire alla compilazione dopo.

## Token

Nell'app: sezione **Team** -> *Accesso da agenti esterni (MCP)* -> **Genera token**.
Il token si vede una volta sola (nel database resta solo il suo hash) e vale
quanto il tuo utente: stessa ACL, stessi progetti, niente scorciatoie.

## Configurazione in Claude Code

```bash
claude mcp add --transport http pcb-studio http://localhost:3111/api/mcp/mcp \
  --header "Authorization: Bearer pcbs_iltuotoken"
```

In produzione l'URL e' `https://pcb-studio-3bee.vercel.app/api/mcp/mcp`, ma
finche' e' attiva la **Deployment Protection** di Vercel le richieste vengono
intercettate dal suo SSO prima di arrivare all'app. Due modi per aprirla:

1. **Protection Bypass for Automation** (consigliato): genera un secret nelle
   impostazioni del progetto e passalo come header `x-vercel-protection-bypass`.
   I browser restano protetti dall'SSO, gli agenti passano.
2. **Disattivare la Deployment Protection**: l'app resta comunque protetta dalla
   propria autenticazione (login con link via email + ACL per progetto).

## Esempio di sessione

> «Apri il progetto bat-bs, guarda i problemi di piazzamento e sistemali:
> sposta i componenti che si sovrappongono, ricompila e dimmi quante
> connessioni restano non instradate.»
