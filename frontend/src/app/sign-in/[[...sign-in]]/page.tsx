import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

async function resolveSafeReturnPath(redirectUrl: string | undefined): Promise<string> {
  if (!redirectUrl?.trim()) {
    return "/";
  }

  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") ?? headersList.get("host");
  const proto = headersList.get("x-forwarded-proto") ?? "http";
  if (!host) {
    return "/";
  }

  const origin = `${proto}://${host}`;

  try {
    const target = new URL(redirectUrl);
    if (target.origin !== origin) {
      return "/";
    }
    const path = `${target.pathname}${target.search}${target.hash}`;
    return path || "/";
  } catch {
    if (redirectUrl.startsWith("/") && !redirectUrl.startsWith("//")) {
      return redirectUrl;
    }
    return "/";
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const { userId } = await auth();
  const params = await searchParams;
  const returnPath = await resolveSafeReturnPath(params.redirect_url);

  if (userId) {
    redirect(returnPath);
  }

  return (
    <main className="container authContainer">
      <section className="panel authPanel">
        <p className="eyebrow">Acesso restrito</p>
        <h1>Entrar no Cost Dashboard</h1>
        <p className="muted">
          Use sua conta Google do domínio <strong>hypr.mobi</strong>.
        </p>
        <div className="clerkWrap">
          <SignIn path="/sign-in" routing="path" forceRedirectUrl={returnPath} />
        </div>
      </section>
    </main>
  );
}
