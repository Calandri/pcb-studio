import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Studio } from "@/components/Studio";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return (
    <Studio
      user={{
        email: session.user.email ?? "",
        name: session.user.name ?? null,
      }}
    />
  );
}
