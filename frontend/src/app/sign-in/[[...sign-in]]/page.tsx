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
    <main className="authContainer authSignInContainer">
      <div className="authSignInGlow" aria-hidden="true" />
      <section className="authSignInShell">
        <div className="clerkWrap authSignInClerkWrap">
          <SignIn
            path="/sign-in"
            routing="path"
            forceRedirectUrl={returnPath}
            appearance={{
              variables: {
                colorBackground: "#0b1220",
                colorNeutral: "#111827",
                colorPrimary: "#3b82f6",
                colorText: "#f8fafc",
                colorTextSecondary: "#94a3b8",
                colorInputBackground: "#0f172a",
                colorInputText: "#f8fafc",
                borderRadius: "12px",
              },
              elements: {
                rootBox: "authClerkRootBox",
                cardBox: "authClerkCard",
                card: "authClerkCardInner",
                headerTitle: "authClerkHeaderTitle",
                headerSubtitle: "authClerkHeaderSubtitle",
                footerActionText: "authClerkFooterText",
                footerActionLink: "authClerkFooterLink",
                socialButtonsBlockButton: "authClerkSocialButton",
                socialButtonsBlockButtonText: "authClerkSocialButtonText",
                formButtonPrimary: "authClerkPrimaryButton",
                dividerText: "authClerkDividerText",
              },
            }}
          />
        </div>
      </section>
    </main>
  );
}
