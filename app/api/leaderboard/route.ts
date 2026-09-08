import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface LeaderboardEntry {
  username: string;
  displayName: string;
  userId: number;
  avatarUrl: string;
  score: number;
}

const KV_CONFIGURED = Boolean(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

// In-memory fallback so the game still works before KV is connected.
// NOTE: this resets whenever the serverless function cold-starts, so
// connect Vercel KV (see README) for a real, persistent leaderboard.
const memoryStore = new Map<string, LeaderboardEntry>();

async function getKv() {
  const { kv } = await import("@vercel/kv");
  return kv;
}

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 10, 1), 50);

  if (!KV_CONFIGURED) {
    const entries = Array.from(memoryStore.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return NextResponse.json({ entries, persistent: false });
  }

  try {
    const kv = await getKv();
    const top = await kv.zrange<string[]>("leaderboard", 0, limit - 1, {
      rev: true,
    });

    const entries: LeaderboardEntry[] = [];
    for (const username of top) {
      const player = await kv.hgetall<Omit<LeaderboardEntry, "username" | "score">>(
        `player:${username}`
      );
      const score = await kv.zscore("leaderboard", username);
      if (player && score != null) {
        entries.push({ username, score, ...player } as LeaderboardEntry);
      }
    }

    return NextResponse.json({ entries, persistent: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not load the leaderboard." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: Partial<LeaderboardEntry>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { username, displayName, userId, avatarUrl, score } = body;

  if (
    !username ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0
  ) {
    return NextResponse.json(
      { error: "username and a valid non-negative score are required." },
      { status: 400 }
    );
  }

  const roundedScore = Math.floor(score);

  if (!KV_CONFIGURED) {
    const existing = memoryStore.get(username);
    const isNewBest = !existing || roundedScore > existing.score;
    if (isNewBest) {
      memoryStore.set(username, {
        username,
        displayName: displayName || username,
        userId: userId || 0,
        avatarUrl: avatarUrl || "",
        score: roundedScore,
      });
    }
    return NextResponse.json({
      saved: isNewBest,
      bestScore: isNewBest ? roundedScore : existing?.score ?? roundedScore,
      persistent: false,
    });
  }

  try {
    const kv = await getKv();
    const currentBest = await kv.zscore("leaderboard", username);
    const isNewBest = currentBest == null || roundedScore > currentBest;

    if (isNewBest) {
      await kv.hset(`player:${username}`, {
        displayName: displayName || username,
        userId: userId || 0,
        avatarUrl: avatarUrl || "",
      });
      await kv.zadd("leaderboard", { score: roundedScore, member: username });
    }

    return NextResponse.json({
      saved: isNewBest,
      bestScore: isNewBest ? roundedScore : currentBest,
      persistent: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not save the score." },
      { status: 500 }
    );
  }
}
