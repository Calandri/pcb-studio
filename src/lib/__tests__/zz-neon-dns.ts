// BANCO LOCALE (non committare): il resolver del Mac non risolve api.c-7.eu-central-1.aws.neon.tech (nslookup si'),
// quindi il driver parla con l'host dell'endpoint, che espone lo stesso /sql.
import { neonConfig } from "@neondatabase/serverless";
neonConfig.fetchEndpoint = (host: string) => `https://${host}/sql`;
