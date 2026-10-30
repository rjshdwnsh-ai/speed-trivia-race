import { getStore } from "@netlify/blobs";
import { randomInt } from "node:crypto";

const store = getStore({ name: "speed-trivia-rooms", consistency: "strong" });
const MAX_PLAYERS = 8;
const ROUND_MS = 15000;
const questions = [
  { q: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Mercury"], answer: 1, category: "SPACE" },
  { q: "What is the capital of Japan?", options: ["Seoul", "Beijing", "Tokyo", "Bangkok"], answer: 2, category: "GEOGRAPHY" },
  { q: "How many sides does a hexagon have?", options: ["Five", "Six", "Seven", "Eight"], answer: 1, category: "MATH" }
];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const cleanName = value => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 20);
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 5 }, () => codeChars[randomInt(codeChars.length)]).join("");

function publicRoom(room) {
  const question = room.status === "playing" || room.status === "between" ? questions[room.round] : null;
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: room.players,
    round: room.round,
    questionCount: questions.length,
    question: question ? {
      q: question.q,
      options: question.options,
      category: question.category,
      index: room.round,
      endsAt: room.endsAt
    } : null,
    lastResult: room.lastResult,
    winnerId: room.winnerId
  };
}

const roomKey = code => `room-${code}`;
const readRoom = code => store.getWithMetadata(roomKey(code), { consistency: "strong", type: "json" });

async function updateRoom(code, mutate, create = false) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readRoom(code);
    if (create) {
      if (current) return { error: "That room code already exists." };
      const next = mutate(null);
      const result = await store.setJSON(roomKey(code), next, { onlyIfNew: true });
      if (result.modified) return { room: next };
    } else {
      if (!current) return { error: "Room not found. Check the code." };
      const next = mutate(structuredClone(current.data));
      if (next?.error) return { error: next.error };
      const result = await store.setJSON(roomKey(code), next, { onlyIfMatch: current.etag });
      if (result.modified) return { room: next };
    }
  }
  return { error: "The room is busy. Please try again." };
}

async function createRoom(name, playerId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const room = {
      code, status: "lobby", hostId: playerId,
      players: [{ id: playerId, name, score: 0, online: true, answered: false }],
      round: 0, endsAt: null, lastResult: null, winnerId: null
    };
    const result = await updateRoom(code, () => room, true);
    if (result.room) return result;
  }
  return { error: "Could not create a room. Please try again." };
}

function finishRound(room) {
  const question = questions[room.round];
  room.lastResult = {
    correctIndex: question.answer,
    correctText: question.options[question.answer],
    at: Date.now()
  };
  room.status = "between";
  room.endsAt = Date.now() + 2500;
  return room;
}

export default async request => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }});
  }
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  let input;
  try { input = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON." }, 400); }

  const action = String(input.action ?? "");
  const playerId = String(input.playerId ?? "").slice(0, 80);
  const code = String(input.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const name = cleanName(input.name);
  if (!playerId) return json({ ok: false, error: "Missing player identity." }, 400);

  try {
    if (action === "create") {
      if (!name) return json({ ok: false, error: "Enter your name first." }, 400);
      const result = await createRoom(name, playerId);
      return result.room
        ? json({ ok: true, room: publicRoom(result.room) })
        : json({ ok: false, error: result.error }, 409);
    }

    if (!code) return json({ ok: false, error: "Enter a room code." }, 400);

    if (action === "state") {
      let current = await readRoom(code);
      if (!current) return json({ ok: false, error: "Room not found. Check the code." }, 404);
      let room = current.data;

      if (room.status === "playing" && Date.now() >= room.endsAt) {
        const timedOut = await updateRoom(code, old => {
          if (old.status !== "playing" || Date.now() < old.endsAt) return old;
          return finishRound(old);
        });
        if (timedOut.room) return json({ ok: true, room: publicRoom(timedOut.room) });
        current = await readRoom(code);
        if (current) room = current.data;
      }

      if (room.status === "between" && Date.now() >= room.endsAt) {
        const advanced = await updateRoom(code, old => {
          if (old.status !== "between" || Date.now() < old.endsAt) return old;
          old.round += 1;
          if (old.round >= questions.length) {
            old.status = "finished";
            old.winnerId = [...old.players].sort((a, b) => b.score - a.score)[0]?.id ?? null;
            old.endsAt = null;
            return old;
          }
          old.status = "playing";
          old.endsAt = Date.now() + ROUND_MS;
          old.lastResult = null;
          old.players.forEach(player => { player.answered = false; });
          return old;
        });
        if (advanced.room) room = advanced.room;
      }
      return json({ ok: true, room: publicRoom(room) });
    }

    if (action === "join") {
      if (!name) return json({ ok: false, error: "Enter your name first." }, 400);
      const result = await updateRoom(code, room => {
        if (!["lobby", "finished"].includes(room.status)) return { error: "This game has already started." };
        if (room.players.some(player => player.id !== playerId && player.name.toLowerCase() === name.toLowerCase())) {
          return { error: "That player name is already used in this room." };
        }
        let player = room.players.find(item => item.id === playerId);
        if (!player) {
          if (room.players.length >= MAX_PLAYERS) return { error: "This room is full (8 players maximum)." };
          player = { id: playerId, name, score: 0, online: true, answered: false };
          room.players.push(player);
        }
        player.name = name;
        player.online = true;
        if (room.status === "finished") {
          room.status = "lobby";
          room.round = 0;
          room.winnerId = null;
          room.lastResult = null;
          room.players.forEach(item => { item.score = 0; item.answered = false; });
        }
        return room;
      });
      return result.room
        ? json({ ok: true, room: publicRoom(result.room) })
        : json({ ok: false, error: result.error }, 409);
    }

    if (action === "start") {
      const result = await updateRoom(code, room => {
        if (room.hostId !== playerId) return { error: "Only the host can start the game." };
        if (room.status !== "lobby") return { error: "The game is not in the lobby." };
        if (room.players.filter(player => player.online).length < 2) {
          return { error: "At least two players must be connected." };
        }
        room.status = "playing";
        room.round = 0;
        room.endsAt = Date.now() + ROUND_MS;
        room.lastResult = null;
        room.winnerId = null;
        room.players.forEach(player => { player.score = 0; player.answered = false; });
        return room;
      });
      return result.room
        ? json({ ok: true, room: publicRoom(result.room) })
        : json({ ok: false, error: result.error }, 409);
    }

    if (action === "answer") {
      const index = Number(input.answer);
      if (!Number.isInteger(index) || index < 0 || index > 3) {
        return json({ ok: false, error: "Invalid answer." }, 400);
      }
      let answerResult = null;
      const result = await updateRoom(code, room => {
        if (room.status !== "playing") return { error: "There is no active question." };
        if (Date.now() >= room.endsAt) return { error: "Time is up." };
        const player = room.players.find(item => item.id === playerId);
        if (!player) return { error: "You are not in this room." };
        if (player.answered) return { error: "Your answer is already locked." };
        player.answered = true;
        const correct = index === questions[room.round].answer;
        const remaining = Math.max(0, room.endsAt - Date.now());
        const gained = correct ? 100 + Math.round(50 * remaining / ROUND_MS) : 0;
        player.score += gained;
        answerResult = { correct, gained };
        if (room.players.filter(item => item.online).every(item => item.answered)) finishRound(room);
        return room;
      });
      return result.room
        ? json({ ok: true, ...answerResult, room: publicRoom(result.room) })
        : json({ ok: false, error: result.error }, 409);
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (error) {
    console.error("game function error", error);
    return json({ ok: false, error: "A server error occurred. Please retry." }, 500);
  }
};
