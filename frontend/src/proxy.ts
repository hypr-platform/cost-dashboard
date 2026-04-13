import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sso-callback(.*)",
  "/unauthorized(.*)",
]);

function shouldSkipClerk(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/favicon.ico" || path === "/robots.txt" || path === "/sitemap.xml") {
    return true;
  }
  if (path.startsWith("/_next/static") || path.startsWith("/_next/image")) {
    return true;
  }
  return false;
}

function appendClerkCookieDeletes(res: NextResponse, req: NextRequest) {
  for (const { name } of req.cookies.getAll()) {
    if (name.startsWith("__clerk") || name.startsWith("__session") || name === "__client_uat") {
      res.cookies.delete(name);
    }
  }
}

export default clerkMiddleware(async (auth, req) => {
  if (shouldSkipClerk(req)) {
    return NextResponse.next();
  }

  if (isPublicRoute(req)) {
    return;
  }

  try {
    const { userId } = await auth();
    if (!userId) {
      const signInUrl = new URL("/sign-in", req.url);
      signInUrl.searchParams.set("redirect_url", req.url);
      return NextResponse.redirect(signInUrl);
    }
  } catch (error) {
    console.error("[clerk proxy] auth() failed, clearing session cookies", error);
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", req.url);
    const res = NextResponse.redirect(signInUrl);
    appendClerkCookieDeletes(res, req);
    return res;
  }
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|[^?]*\\.(?:html?|css|js(?!on)|jpg|jpeg|png|gif|svg|ttf|woff2?|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
