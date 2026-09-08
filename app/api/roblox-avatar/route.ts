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

    // Step 2: fetch the circular headshot thumbnail
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png&isCircular=true`,
      { cache: "no-store" }
    );

    if (!thumbRes.ok) {
      return NextResponse.json(
        { error: "Roblox thumbnail service unavailable." },
        { status: 502 }
      );
    }

    const thumbData = (await thumbRes.json()) as RobloxThumbnailResponse;
    const thumb = thumbData.data?.[0];

    if (!thumb || thumb.state !== "Completed" || !thumb.imageUrl) {
      return NextResponse.json(
        { error: "Avatar image isn't ready yet, try again in a moment." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      userId: user.id,
      username: user.name,
      displayName: user.displayName,
      avatarUrl: thumb.imageUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Something went wrong reaching Roblox." },
      { status: 500 }
    );
  }
}
