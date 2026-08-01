import { redirect } from "next/navigation";

// compat: projects live one level up, in the organization
export default function Projects() {
  redirect("/org");
}
