import NeonAdapter from "@auth/neon-adapter";
import { Pool } from "@neondatabase/serverless";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import { ensureUserOrganization } from "@/lib/org-store";

// Mittente vincolato alle identita' verificate su questo account SES.
const MAIL_FROM = process.env.MAIL_FROM ?? "noreply@ai-council.io";
const SES_REGION = process.env.AWS_SES_REGION ?? "eu-west-3";

/**
 * Magic link via AWS SES. Auth.js gestisce token, scadenza e sessione:
 * qui si manda solo la mail.
 */
async function sendMagicLink({
  identifier,
  url,
}: {
  identifier: string;
  url: string;
}): Promise<void> {
  const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
  const host = new URL(url).host;

  // in sviluppo il link e' anche a console, per non dover aprire la mail
  if (process.env.NODE_ENV !== "production") {
    console.log(`[auth] magic link per ${identifier}: ${url}`);
  }

  const client = new SESClient({
    region: SES_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    },
  });

  await client.send(
    new SendEmailCommand({
      Source: `PCB Studio <${MAIL_FROM}>`,
      Destination: { ToAddresses: [identifier] },
      Message: {
        Subject: { Data: "Accedi a PCB Studio", Charset: "UTF-8" },
        Body: {
          Text: {
            Charset: "UTF-8",
            Data: `Apri questo link per accedere a PCB Studio (${host}):\n\n${url}\n\nIl link scade tra 24 ore. Se non hai richiesto l'accesso, ignora questa email.`,
          },
          Html: {
            Charset: "UTF-8",
            Data: `<div style="font-family:system-ui,sans-serif;max-width:480px">
              <h2 style="margin:0 0 16px">PCB Studio</h2>
              <p>Clicca per accedere:</p>
              <p><a href="${url}" style="display:inline-block;background:#059669;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Accedi</a></p>
              <p style="color:#666;font-size:13px">Il link scade tra 24 ore. Se non hai richiesto l'accesso, ignora questa email.</p>
            </div>`,
          },
        },
      },
    }),
  );
}

const emailProvider: Provider = {
  id: "email",
  type: "email",
  name: "Email",
  from: MAIL_FROM,
  maxAge: 24 * 60 * 60,
  options: {},
  sendVerificationRequest: sendMagicLink,
};

const providers: Provider[] = [emailProvider];
// Google resta opzionale: si attiva quando arrivano le credenziali.
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return {
    adapter: NeonAdapter(pool),
    providers,
    pages: { signIn: "/login", verifyRequest: "/login?sent=1" },
    session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },
    callbacks: {
      async session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },
    events: {
      // ogni nuovo utente ottiene subito un'organizzazione personale
      async createUser({ user }) {
        if (user.id && user.email) {
          await ensureUserOrganization(user.id, user.email).catch(() => {});
        }
      },
    },
  };
});
