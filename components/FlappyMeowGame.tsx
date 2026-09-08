"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSoundEngine } from "@/lib/sounds";

type Screen = "menu" | "loading" | "ready" | "playing" | "gameover";

interface AvatarInfo {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
}

interface LeaderboardEntry {
  username: string;
  displayName: string;
  userId: number;
  avatarUrl: string;
  score: number;
}

const CANVAS_W = 400;
const CANVAS_H = 600;
const GRAVITY = 1500; // px/s^2
const FLAP_VELOCITY = -430; // px/s
const BIRD_X = 100;
const BIRD_RADIUS = 22;
const PIPE_WIDTH = 68;
const PIPE_GAP = 168;
const BASE_PIPE_SPEED = 165; // px/s at score 0
const MAX_PIPE_SPEED = 320; // px/s cap so it never gets unfair
const SPEED_RAMP_PER_POINT = 6; // px/s added per point scored
const PIPE_INTERVAL_PX = 230; // horizontal spacing between pipes
const GROUND_HEIGHT = 90;

function pipeSpeedForScore(score: number): number {
  return Math.min(MAX_PIPE_SPEED, BASE_PIPE_SPEED + score * SPEED_RAMP_PER_POINT);
}

const LAST_USERNAME_KEY = "flappyMeow:lastUsername";

interface Pipe {
  x: number;
  gapY: number; // center of gap
  passed: boolean;
}

interface PhysicsState {
  birdY: number;
  velocity: number;
  pipes: Pipe[];
  score: number;
  distanceSinceLastPipe: number;
  running: boolean;
}

function freshPhysics(): PhysicsState {
  return {
    birdY: CANVAS_H / 2,
    velocity: 0,
    pipes: [],
    score: 0,
    distanceSinceLastPipe: 999,
    running: true,
  };
}

export default function FlappyMeowGame() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [usernameInput, setUsernameInput] = useState("");
  const [avatar, setAvatar] = useState<AvatarInfo | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [isNewHigh, setIsNewHigh] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardPersistent, setLeaderboardPersistent] = useState(true);
  const [muted, setMuted] = useState(false);
  const [shareStatus, setShareStatus] = useState<
    "idle" | "copied" | "shared" | "saved" | "unavailable"
  >("idle");
  const [challenge, setChallenge] = useState<{ name: string; score: number } | null>(null);
  const avatarExportableRef = useRef(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const physicsRef = useRef<PhysicsState>(freshPhysics());
  const avatarImgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const cloudsRef = useRef(
    Array.from({ length: 5 }, (_, i) => ({
      x: (i * 130) % CANVAS_W,
      y: 40 + (i * 70) % 220,
      scale: 0.6 + (i % 3) * 0.25,
    }))
  );
  const groundOffsetRef = useRef(0);

  const sound = typeof window !== "undefined" ? getSoundEngine() : null;

  // ---------- Local high score (per browser, per Roblox username) ----------
  const highScoreKey = avatar ? `flappyMeow:highscore:${avatar.username}` : null;

  useEffect(() => {
    if (highScoreKey) {
      const stored = Number(localStorage.getItem(highScoreKey) || 0);
      setHighScore(stored);
    }
  }, [highScoreKey]);

  // ---------- Leaderboard ----------
  const refreshLeaderboard = useCallback(async () => {
    try {
      const res = await fetch("/api/leaderboard?limit=10", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setLeaderboard(data.entries || []);
        setLeaderboardPersistent(data.persistent !== false);
      }
    } catch {
      // silent — leaderboard is a nice-to-have, not blocking
    }
  }, []);

  useEffect(() => {
    refreshLeaderboard();
  }, [refreshLeaderboard]);

  // ---------- Read an incoming "beat my score" share link ----------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawScore = params.get("challengeScore");
    const rawName = params.get("challengeName");
    const parsedScore = Number(rawScore);
    if (rawName && rawScore && Number.isFinite(parsedScore) && parsedScore >= 0) {
      setChallenge({ name: rawName, score: Math.floor(parsedScore) });
    }
  }, []);

  // ---------- Fetch Roblox avatar ----------
  const fetchAvatar = useCallback(async (name: string) => {
    setScreen("loading");
    setAvatarError(null);
    try {
      const res = await fetch(`/api/roblox-avatar?username=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) {
        setAvatarError(data.error || "Couldn't find that player.");
        setScreen("menu");
        return;
      }
      const loadImage = (useCors: boolean) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          if (useCors) img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image failed to load"));
          img.src = data.avatarUrl;
        });

      let img: HTMLImageElement;
      let exportable = true;
      try {
        img = await loadImage(true);
      } catch {
        exportable = false;
        try {
          img = await loadImage(false);
        } catch {
          setAvatarError("Got the player, but couldn't load their avatar image.");
          setScreen("menu");
          return;
        }
      }

      avatarImgRef.current = img;
      avatarExportableRef.current = exportable;
      setAvatar(data);
      setScreen("ready");
      try {
        localStorage.setItem(LAST_USERNAME_KEY, data.username);
      } catch {
        // localStorage unavailable (private browsing etc.) — not critical
      }
    } catch {
      setAvatarError("Network error reaching Roblox. Try again.");
      setScreen("menu");
    }
  }, []);

  // One-time auto-load: if this device already has a remembered Roblox
  // profile from a previous visit, jump straight to it instead of asking
  // for the username again.
  const triedAutoLoad = useRef(false);
  useEffect(() => {
    if (triedAutoLoad.current) return;
    triedAutoLoad.current = true;
    try {
      const remembered = localStorage.getItem(LAST_USERNAME_KEY);
      if (remembered) {
        setUsernameInput(remembered);
        fetchAvatar(remembered);
      }
    } catch {
      // localStorage unavailable — just show the normal menu
    }
  }, [fetchAvatar]);

  const handleSubmitUsername = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = usernameInput.trim();
    if (!trimmed) return;
    sound?.tap();
    fetchAvatar(trimmed);
  };

  // ---------- Game control ----------
  const startGame = useCallback(() => {
    physicsRef.current = freshPhysics();
    setScore(0);
    setIsNewHigh(false);
    setScreen("playing");
    sound?.tap();
  }, [sound]);

  const flap = useCallback(() => {
    if (screen !== "playing") return;
    physicsRef.current.velocity = FLAP_VELOCITY;
    sound?.flap();
  }, [screen, sound]);

  const endGame = useCallback(
    async (finalScore: number) => {
      physicsRef.current.running = false;
      setScreen("gameover");

      let newHigh = false;
      if (avatar) {
        const key = `flappyMeow:highscore:${avatar.username}`;
        const prevBest = Number(localStorage.getItem(key) || 0);
        if (finalScore > prevBest) {
          localStorage.setItem(key, String(finalScore));
          setHighScore(finalScore);
          newHigh = true;
        }
      }
      setIsNewHigh(newHigh);
      sound?.[newHigh ? "newHighScore" : "gameOver"]();

      if (avatar) {
        try {
          await fetch("/api/leaderboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: avatar.username,
              displayName: avatar.displayName,
              userId: avatar.userId,
              avatarUrl: avatar.avatarUrl,
              score: finalScore,
            }),
          });
          refreshLeaderboard();
        } catch {
          // leaderboard submission failing shouldn't break the UI
        }
      }
    },
    [avatar, sound, refreshLeaderboard]
  );

  const handleShare = useCallback(async () => {
    if (!avatar) return;
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("challengeScore", String(score));
    url.searchParams.set("challengeName", avatar.displayName);
    const shareUrl = url.toString();
    const text = `I scored ${score} in Flappy Meow flying as ${avatar.displayName}! Think you can beat me?`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "Flappy Meow", text, url: shareUrl });
        setShareStatus("shared");
      } catch {
        // user cancelled the native share sheet — not an error
      }
    } else {
      try {
        await navigator.clipboard.writeText(`${text} ${shareUrl}`);
        setShareStatus("copied");
      } catch {
        setShareStatus("idle");
      }
    }
    setTimeout(() => setShareStatus("idle"), 2500);
  }, [avatar, score]);

  // ---------- Shareable image card (avatar + score + Meow Hikers badge look) ----------
  const buildShareCardBlob = useCallback(async (): Promise<Blob | null> => {
    if (!avatar) return null;
    const W = 1080;
    const H = 1920;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    try {
      await document.fonts?.ready;
    } catch {
      // font loading API unavailable — canvas will just use fallback fonts
    }

    try {
      // background
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#1b2a12");
      bg.addColorStop(1, "#05060a");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // mountain ridge
      ctx.fillStyle = "rgba(95, 156, 49, 0.28)";
      ctx.beginPath();
      ctx.moveTo(0, 620);
      ctx.lineTo(140, 420);
      ctx.lineTo(250, 520);
      ctx.lineTo(420, 260);
      ctx.lineTo(560, 460);
      ctx.lineTo(700, 320);
      ctx.lineTo(840, 500);
      ctx.lineTo(980, 380);
      ctx.lineTo(W, 560);
      ctx.lineTo(W, 760);
      ctx.lineTo(0, 760);
      ctx.closePath();
      ctx.fill();

      // pine trees
      const drawPineBig = (x: number, y: number, scale: number) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.fillStyle = "rgba(95, 156, 49, 0.4)";
        ctx.beginPath();
        ctx.moveTo(0, -70);
        ctx.lineTo(28, -20);
        ctx.lineTo(14, -20);
        ctx.lineTo(36, 16);
        ctx.lineTo(18, 16);
        ctx.lineTo(40, 52);
        ctx.lineTo(-40, 52);
        ctx.lineTo(-18, 16);
        ctx.lineTo(-36, 16);
        ctx.lineTo(-14, -20);
        ctx.lineTo(-28, -20);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(-8, 52, 16, 16);
        ctx.restore();
      };
      [
        [120, 1560, 1.1],
        [960, 1580, 1.3],
        [280, 1620, 0.9],
        [820, 1640, 1.0],
      ].forEach(([x, y, s]) => drawPineBig(x, y, s));

      // badge ring + avatar
      const cx = W / 2;
      const cy = 560;
      const ringRadius = 300;
      ctx.save();
      ctx.strokeStyle = "#6fae2e";
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const avatarRadius = 260;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, avatarRadius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = "#0d0f0a";
      ctx.fillRect(cx - avatarRadius, cy - avatarRadius, avatarRadius * 2, avatarRadius * 2);
      const avatarImg = avatarImgRef.current;
      if (avatarImg) {
        ctx.drawImage(avatarImg, cx - avatarRadius, cy - avatarRadius, avatarRadius * 2, avatarRadius * 2);
      }
      ctx.restore();

      ctx.textAlign = "center";

      // title
      ctx.fillStyle = "#8fc656";
      ctx.font = "64px Bungee, sans-serif";
      ctx.fillText("FLAPPY MEOW", cx, 190);

      ctx.fillStyle = "#eef4e6";
      ctx.font = "700 28px Baloo 2, sans-serif";
      ctx.fillText("MEOW HIKERS EDITION", cx, 236);

      // player name
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 46px Baloo 2, sans-serif";
      ctx.fillText(avatar.displayName, cx, 950);

      // score
      ctx.fillStyle = "#ffce54";
      ctx.font = "160px Bungee, sans-serif";
      ctx.fillText(String(score), cx, 1090);

      ctx.fillStyle = "#eef4e6";
      ctx.font = "700 38px Baloo 2, sans-serif";
      ctx.fillText("PIPES CLEARED", cx, 1140);

      if (isNewHigh) {
        ctx.fillStyle = "#ffce54";
        ctx.font = "700 36px Baloo 2, sans-serif";
        ctx.fillText("🏆 NEW ALL-TIME HIGH!", cx, 1200);
      }

      // footer CTA
      ctx.fillStyle = "#b9c9ab";
      ctx.font = "700 32px Baloo 2, sans-serif";
      ctx.fillText("Think you can beat me?", cx, 1780);
      ctx.fillStyle = "#8fc656";
      ctx.font = "700 36px Baloo 2, sans-serif";
      ctx.fillText(window.location.host, cx, 1832);

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/png");
      });
    } catch {
      // most likely a tainted-canvas SecurityError from a non-CORS avatar image
      return null;
    }
  }, [avatar, score, isNewHigh]);

  const handleSaveImage = useCallback(async () => {
    if (!avatarExportableRef.current) {
      setShareStatus("unavailable");
      setTimeout(() => setShareStatus("idle"), 2500);
      return;
    }
    const blob = await buildShareCardBlob();
    if (!blob) {
      setShareStatus("unavailable");
      setTimeout(() => setShareStatus("idle"), 2500);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flappy-meow-${avatar?.username ?? "score"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setShareStatus("saved");
    setTimeout(() => setShareStatus("idle"), 2500);
  }, [avatar, buildShareCardBlob]);

  const handleShareImage = useCallback(async () => {
    if (!avatar) return;
    if (!avatarExportableRef.current) {
      // this player's avatar couldn't be loaded with CORS, so we can't draw
      // it onto an exportable canvas — fall back to the plain link share.
      await handleShare();
      return;
    }
    const blob = await buildShareCardBlob();
    if (!blob) {
      setShareStatus("unavailable");
      setTimeout(() => setShareStatus("idle"), 2500);
      return;
    }
    const file = new File([blob], "flappy-meow-score.png", { type: "image/png" });
    const text = `I scored ${score} in Flappy Meow flying as ${avatar.displayName}! Think you can beat me?`;

    const canShareFiles =
      typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

    if (canShareFiles) {
      try {
        await navigator.share({ files: [file], title: "Flappy Meow", text });
        setShareStatus("shared");
      } catch {
        // user cancelled the native share sheet — not an error
      }
    } else {
      // no file-sharing support in this browser (common on desktop) —
      // just download the image instead so it's still usable.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flappy-meow-${avatar.username}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setShareStatus("saved");
    }
    setTimeout(() => setShareStatus("idle"), 2500);
  }, [avatar, score, buildShareCardBlob, handleShare]);

  // ---------- Input handling ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (screen === "ready") startGame();
        else if (screen === "playing") flap();
        else if (screen === "gameover") startGame();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, flap, startGame]);

  const handleCanvasPress = () => {
    if (screen === "ready") startGame();
    else if (screen === "playing") flap();
    else if (screen === "gameover") startGame();
  };

  // ---------- Draw helpers ----------
  const drawPine = (ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = "rgba(95, 156, 49, 0.35)";
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(14, -10);
    ctx.lineTo(7, -10);
    ctx.lineTo(18, 8);
    ctx.lineTo(9, 8);
    ctx.lineTo(20, 26);
    ctx.lineTo(-20, 26);
    ctx.lineTo(-9, 8);
    ctx.lineTo(-18, 8);
    ctx.lineTo(-7, -10);
    ctx.lineTo(-14, -10);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-4, 26, 8, 8);
    ctx.restore();
  };

  const drawMountains = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = "rgba(95, 156, 49, 0.25)";
    ctx.beginPath();
    ctx.moveTo(0, 210);
    ctx.lineTo(50, 140);
    ctx.lineTo(90, 180);
    ctx.lineTo(150, 90);
    ctx.lineTo(200, 160);
    ctx.lineTo(250, 110);
    ctx.lineTo(300, 175);
    ctx.lineTo(350, 130);
    ctx.lineTo(CANVAS_W, 200);
    ctx.lineTo(CANVAS_W, 260);
    ctx.lineTo(0, 260);
    ctx.closePath();
    ctx.fill();
  };

  const drawPipe = (ctx: CanvasRenderingContext2D, pipe: Pipe) => {
    const topH = pipe.gapY - PIPE_GAP / 2;
    const bottomY = pipe.gapY + PIPE_GAP / 2;
    const bottomH = CANVAS_H - GROUND_HEIGHT - bottomY;

    const grad = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_WIDTH, 0);
    grad.addColorStop(0, "#8fc656");
    grad.addColorStop(1, "#4a7a26");

    // top pipe
    ctx.fillStyle = grad;
    ctx.fillRect(pipe.x, 0, PIPE_WIDTH, topH);
    ctx.fillStyle = "#3d2b1a";
    ctx.fillRect(pipe.x, Math.max(0, topH - 18), PIPE_WIDTH, 18);

    // bottom pipe
    ctx.fillStyle = grad;
    ctx.fillRect(pipe.x, bottomY, PIPE_WIDTH, bottomH);
    ctx.fillStyle = "#3d2b1a";
    ctx.fillRect(pipe.x, bottomY, PIPE_WIDTH, 18);
  };

  const drawGround = (ctx: CanvasRenderingContext2D, offset: number) => {
    const y = CANVAS_H - GROUND_HEIGHT;
    ctx.fillStyle = "#5b4227";
    ctx.fillRect(0, y, CANVAS_W, GROUND_HEIGHT);
    ctx.fillStyle = "#71542f";
    const stripeW = 40;
    for (let x = -stripeW + (offset % stripeW); x < CANVAS_W; x += stripeW) {
      ctx.fillRect(x, y, stripeW / 2, 14);
    }
  };

  const drawBird = (ctx: CanvasRenderingContext2D, y: number, velocity: number) => {
    const img = avatarImgRef.current;
    const angle = Math.max(-0.4, Math.min(0.9, velocity / 700));
    ctx.save();
    ctx.translate(BIRD_X, y);
    ctx.rotate(angle);

    // little wing flap circle behind avatar for flair
    ctx.fillStyle = "#ffce54";
    ctx.beginPath();
    ctx.ellipse(-6, 8, 10, 6, angle, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_RADIUS, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      ctx.drawImage(img, -BIRD_RADIUS, -BIRD_RADIUS, BIRD_RADIUS * 2, BIRD_RADIUS * 2);
    } else {
      ctx.fillStyle = "#ffce54";
      ctx.fillRect(-BIRD_RADIUS, -BIRD_RADIUS, BIRD_RADIUS * 2, BIRD_RADIUS * 2);
    }
    ctx.restore();

    ctx.lineWidth = 3;
    ctx.strokeStyle = "#8fc656";
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  };

  // ---------- Game loop ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = Math.min((ts - lastTsRef.current) / 1000, 0.033);
      lastTsRef.current = ts;

      const state = physicsRef.current;
      const isPlaying = screen === "playing" && state.running;

      const speed = pipeSpeedForScore(state.score);

      if (isPlaying) {
        state.velocity += GRAVITY * dt;
        state.birdY += state.velocity * dt;

        state.distanceSinceLastPipe += speed * dt;
        if (state.distanceSinceLastPipe >= PIPE_INTERVAL_PX) {
          state.distanceSinceLastPipe = 0;
          const margin = 70;
          const gapY =
            margin + PIPE_GAP / 2 + Math.random() * (CANVAS_H - GROUND_HEIGHT - PIPE_GAP - margin * 2);
          state.pipes.push({ x: CANVAS_W + PIPE_WIDTH, gapY, passed: false });
        }

        for (const pipe of state.pipes) {
          pipe.x -= speed * dt;
          if (!pipe.passed && pipe.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
            pipe.passed = true;
            state.score += 1;
            setScore(state.score);
            sound?.score();
          }
        }
        state.pipes = state.pipes.filter((p) => p.x > -PIPE_WIDTH);

        // collisions: ground / ceiling
        if (state.birdY + BIRD_RADIUS >= CANVAS_H - GROUND_HEIGHT || state.birdY - BIRD_RADIUS <= 0) {
          state.birdY = Math.max(BIRD_RADIUS, Math.min(state.birdY, CANVAS_H - GROUND_HEIGHT - BIRD_RADIUS));
          endGame(state.score);
        }

        // collisions: pipes (circle vs rect)
        for (const pipe of state.pipes) {
          const withinX = BIRD_X + BIRD_RADIUS > pipe.x && BIRD_X - BIRD_RADIUS < pipe.x + PIPE_WIDTH;
          if (!withinX) continue;
          const topH = pipe.gapY - PIPE_GAP / 2;
          const bottomY = pipe.gapY + PIPE_GAP / 2;
          if (state.birdY - BIRD_RADIUS < topH || state.birdY + BIRD_RADIUS > bottomY) {
            endGame(state.score);
            break;
          }
        }

        groundOffsetRef.current -= speed * dt;
      }

      // ---- draw ----
      const bgGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
      bgGrad.addColorStop(0, "#1b2a12");
      bgGrad.addColorStop(1, "#0a0d08");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      drawMountains(ctx);

      cloudsRef.current.forEach((c) => {
        if (isPlaying) {
          c.x -= speed * 0.3 * dt;
          if (c.x < -50) c.x = CANVAS_W + 50;
        }
        drawPine(ctx, c.x, c.y, c.scale);
      });

      state.pipes.forEach((p) => drawPipe(ctx, p));
      drawGround(ctx, groundOffsetRef.current);

      if (screen !== "menu" && screen !== "loading") {
        drawBird(ctx, state.birdY, state.velocity);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, endGame, sound]);

  // reset bird position when entering "ready" so preview looks right
  useEffect(() => {
    if (screen === "ready") {
      physicsRef.current = freshPhysics();
      physicsRef.current.running = false;
    }
  }, [screen]);

  // ---------- Mute toggle ----------
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sound?.setMuted(next);
    if (!next) sound?.startAmbient();
    else sound?.stopAmbient();
  };

  useEffect(() => {
    // start soft ambient hum once the player has interacted (browser autoplay rules)
    const startOnce = () => {
      if (!muted) sound?.startAmbient();
      window.removeEventListener("pointerdown", startOnce);
    };
    window.addEventListener("pointerdown", startOnce);
    return () => window.removeEventListener("pointerdown", startOnce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="game-shell">
      <div className="game-column">
        <div className="titlebar">
          <h1 className="title">Flappy Meow</h1>
          <button className="icon-btn" onClick={toggleMute} aria-label="Toggle sound">
            {muted ? "🔇" : "🔊"}
          </button>
        </div>

        <div
          className="canvas-wrap"
          role="button"
          tabIndex={0}
          aria-label="Game area — tap or press space to flap"
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="game-canvas"
            onPointerDown={handleCanvasPress}
          />

          {screen !== "playing" && (
            <div className="hud-score">Score {screen === "gameover" ? score : ""}</div>
          )}
          {screen === "playing" && <div className="hud-score">{score}</div>}

          {screen === "menu" && (
            <div className="overlay">
              {challenge && (
                <p className="challenge-banner">
                  🐱 {challenge.name} scored {challenge.score} — think you can beat them?
                </p>
              )}
              <p className="overlay-lede">Flap in as your Roblox avatar!</p>
              <form onSubmit={handleSubmitUsername} className="username-form">
                <input
                  className="text-input"
                  placeholder="Roblox username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  maxLength={20}
                  autoFocus
                />
                <button type="submit" className="primary-btn">
                  Fetch avatar
                </button>
              </form>
              {avatarError && <p className="error-text">{avatarError}</p>}
            </div>
          )}

          {screen === "loading" && (
            <div className="overlay">
              <p className="overlay-lede">Fetching your avatar…</p>
              <div className="spinner" />
            </div>
          )}

          {screen === "ready" && avatar && (
            <div className="overlay">
              <p className="overlay-lede">Hi, {avatar.displayName}!</p>
              <ol className="instructions">
                <li>Tap, click, or press Space to flap.</li>
                <li>Weave through the pipe gaps.</li>
                <li>Each pipe you clear = +1 point.</li>
                <li>Touching a pipe or the ground ends the run.</li>
              </ol>
              <button className="primary-btn" onClick={startGame}>
                Start flapping
              </button>
              <button
                className="link-btn"
                onClick={() => {
                  try {
                    localStorage.removeItem(LAST_USERNAME_KEY);
                  } catch {
                    // ignore
                  }
                  setUsernameInput("");
                  setScreen("menu");
                  setAvatar(null);
                }}
              >
                Use a different player
              </button>
            </div>
          )}

          {screen === "gameover" && avatar && (
            <div className="overlay">
              <p className="overlay-lede">{isNewHigh ? "New all-time high! 🎉" : "Game over"}</p>
              <p className="score-line">
                Score: <strong>{score}</strong> &nbsp;·&nbsp; Best: <strong>{highScore}</strong>
              </p>
              <button className="primary-btn" onClick={startGame}>
                Play again
              </button>
              <div className="share-row">
                <button className="secondary-btn" onClick={handleShareImage}>
                  {shareStatus === "shared"
                    ? "Shared!"
                    : shareStatus === "saved"
                    ? "Saved!"
                    : shareStatus === "unavailable"
                    ? "Try link below"
                    : "Share image"}
                </button>
                <button className="secondary-btn secondary-btn-alt" onClick={handleSaveImage}>
                  {shareStatus === "saved" ? "Saved!" : "Save image"}
                </button>
              </div>
              <button className="link-btn" onClick={handleShare}>
                {shareStatus === "copied" ? "Link copied!" : "Copy score link instead"}
              </button>
              <button
                className="link-btn"
                onClick={() => {
                  try {
                    localStorage.removeItem(LAST_USERNAME_KEY);
                  } catch {
                    // ignore
                  }
                  setUsernameInput("");
                  setScreen("menu");
                  setAvatar(null);
                }}
              >
                Switch player
              </button>
            </div>
          )}
        </div>

        <p className="hint-text">
          {screen === "playing"
            ? "Space / tap to flap"
            : "Your headshot becomes the bird — sourced live from Roblox."}
        </p>
      </div>

      <aside className="leaderboard">
        <h2 className="leaderboard-title">Top Flappers</h2>
        {!leaderboardPersistent && (
          <p className="leaderboard-note">
            Demo mode — connect Vercel KV for a leaderboard that persists (see README).
          </p>
        )}
        {leaderboard.length === 0 ? (
          <p className="leaderboard-empty">No scores yet. Be the first!</p>
        ) : (
          <ol className="leaderboard-list">
            {leaderboard.map((entry, i) => (
              <li key={entry.username} className="leaderboard-row">
                <span className="rank">{i + 1}</span>
                {entry.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.avatarUrl} alt="" className="mini-avatar" />
                ) : (
                  <span className="mini-avatar mini-avatar-blank" />
                )}
                <span className="lb-name">{entry.displayName || entry.username}</span>
                <span className="lb-score">{entry.score}</span>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
