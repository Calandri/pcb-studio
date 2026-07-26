import { redirect } from "next/navigation";

// compat: i progetti stanno un livello sopra, nell'organizzazione
export default function Projects() {
  redirect("/org");
}
