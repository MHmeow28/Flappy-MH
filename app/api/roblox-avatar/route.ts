import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface RobloxUserLookup {
  data: Array<{
    requestedUsername: string;
    hasVerifiedBadge: boolean;
    id: number;
    name: string;
    displayName: string;
  }>;
}

interface RobloxThumbnailResponse {
  data: Array<{
    targetId: number;
    state: string;
    imageUrl: string;
  }>;
}

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim();

  if (!username) {
    return NextResponse.json(
      { error: "Missing 'username' query param." },
      { status: 400 }
    );
  }

  try {
    // Step 1: resolve username -> Roblox userId
    const lookupRes = await fetch(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: true,
        }),
        cache: "no-store",
      }
    );

    if (!lookupRes.ok) {
      return NextResponse.json(
        { error: "Roblox lookup service unavailable." },
        { status: 502 }
      );
    }

    const lookupData = (await lookupRes.json()) as RobloxUserLookup;

    if (!lookupData.data || lookupData.data.length === 0) {
      return NextResponse.json(
        { error: `No Roblox player found named "${username}".` },
        { status: 404 }
      );
    }

    const user = lookupData.data[0];

    // Step 2: fetch the circular headshot (used as the in-game bird) and the
    // full-body render (used on the shareable score card), in parallel.
    const [headshotRes, fullBodyRes] = await Promise.all([
      fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png&isCircular=true`,
        { cache: "no-store" }
      ),
      fetch(
        `https://thumbnails.roblox.com/v1/users/avatar?userIds=${user.id}&size=420x420&format=Png&isCircular=false`,
        { cache: "no-store" }
      ),
    ]);

    if (!headshotRes.ok) {
      return NextResponse.json(
        { error: "Roblox thumbnail service unavailable." },
        { status: 502 }
      );
    }

    const headshotData = (await headshotRes.json()) as RobloxThumbnailResponse;
    const headshot = headshotData.data?.[0];

    if (!headshot || headshot.state !== "Completed" || !headshot.imageUrl) {
      return NextResponse.json(
        { error: "Avatar image isn't ready yet, try again in a moment." },
        { status: 502 }
      );
    }

    // Full-body render is a nice-to-have for the share card — if it fails
    // for any reason, we just fall back to the headshot everywhere.
    let fullBodyUrl: string | null = null;
    if (fullBodyRes.ok) {
      const fullBodyData = (await fullBodyRes.json()) as RobloxThumbnailResponse;
      const fullBody = fullBodyData.data?.[0];
      if (fullBody && fullBody.state === "Completed" && fullBody.imageUrl) {
        fullBodyUrl = fullBody.imageUrl;
      }
    }

    return NextResponse.json({
      userId: user.id,
      username: user.name,
      displayName: user.displayName,
      avatarUrl: headshot.imageUrl,
      fullBodyUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Something went wrong reaching Roblox." },
      { status: 500 }
    );
  }
}
