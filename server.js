require("dotenv").config();

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── Paquetes ──
const COIN_PACKAGES = [
  { id: "pkg_500",  coins: 500,  bonus: 0,    price: 1000  },
  { id: "pkg_1200", coins: 1200, bonus: 200,  price: 2000  },
  { id: "pkg_3000", coins: 3000, bonus: 600,  price: 4000  },
  { id: "pkg_8000", coins: 8000, bonus: 2000, price: 10000 },
];

let playerCoins = {};

app.post("/api/buy-coins", async (req, res) => {
  try {
    const packageId  = req.body?.packageId;
    const playerId   = req.body?.playerId   || "unknown";
    const playerName = req.body?.playerName || "Jugador";
    const pkg = COIN_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: "Paquete no válido: " + packageId });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "STRIPE_SECRET_KEY no configurada" });
    const origin = `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: {
        currency: "mxn",
        product_data: { name: `EvoMon — ${pkg.coins + pkg.bonus} monedas` },
        unit_amount: pkg.price,
      }, quantity: 1 }],
      mode: "payment",
      success_url: `${origin}/?payment=success&pkg=${packageId}&player=${playerId}`,
      cancel_url:  `${origin}/`,
      metadata: { packageId, playerId, coins: String(pkg.coins + pkg.bonus) }
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/support", async (req, res) => {
  try {
    const amount     = req.body?.amount || 50;
    const playerName = req.body?.playerName || "Jugador";
    const origin = `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: {
        currency: "mxn",
        product_data: { name: "❤️ Apoyar al creador de EvoMon", description: `Donación de ${playerName}` },
        unit_amount: Math.max(1000, parseInt(amount) * 100),
      }, quantity: 1 }],
      mode: "payment",
      success_url: `${origin}/?payment=support_ok`,
      cancel_url:  `${origin}/`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/verify-payment", (req, res) => {
  const { packageId, playerId } = req.query;
  const pkg = COIN_PACKAGES.find(p => p.id === packageId);
  if (!pkg || !playerId) return res.json({ success: false });
  const total = pkg.coins + pkg.bonus;
  if (!playerCoins[playerId]) playerCoins[playerId] = 0;
  playerCoins[playerId] += total;
  io.to(playerId).emit("coinsAdded", { coins: total, message: `💰 +${total} monedas!` });
  res.json({ success: true, coins: total });
});

// ══════════════════════════════════════════
// SISTEMA DE SALAS AUTOMÁTICAS
// ══════════════════════════════════════════
const MAX_PLAYERS_PER_ROOM = 20;
const WORLD = 3000, TICK_RATE = 30;

let rooms = {}; // roomId -> { players, energyOrbs, powerupOrbs, bullets }

function createRoom(roomId) {
  const energyOrbs = [];
  for (let i = 0; i < 280; i++) {
    energyOrbs.push({ id: i, x: Math.random()*WORLD, y: Math.random()*WORLD, value: Math.floor(Math.random()*5)+1, alive: true });
  }
  rooms[roomId] = {
    id: roomId,
    players: {},
    energyOrbs,
    powerupOrbs: [],
    bullets: [],
    bulletId: 0,
    createdAt: Date.now()
  };
  console.log(`🏠 Sala creada: ${roomId}`);
  return rooms[roomId];
}

function getAvailableRoom() {
  // Buscar sala con espacio
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const count = Object.keys(room.players).length;
    if (count < MAX_PLAYERS_PER_ROOM) return room;
  }
  // Crear nueva sala
  const newId = "sala_" + (Object.keys(rooms).length + 1);
  return createRoom(newId);
}

function getRoomByPlayer(socketId) {
  for (const roomId in rooms) {
    if (rooms[roomId].players[socketId]) return rooms[roomId];
  }
  return null;
}

function cleanEmptyRooms() {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const count = Object.keys(room.players).length;
    // Mantener al menos sala_1, borrar vacías extras
    if (count === 0 && roomId !== "sala_1") {
      delete rooms[roomId];
      console.log(`🗑️ Sala eliminada: ${roomId}`);
    }
  }
}

// Crear sala inicial
createRoom("sala_1");

// Spawn powerups por sala
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (Object.keys(room.players).length === 0) continue;
    if (room.powerupOrbs.length < 5) {
      const t = ["speed","triple","shield","magnet","giant"];
      room.powerupOrbs.push({
        id: Date.now() + Math.random(),
        x: 100+Math.random()*(WORLD-200),
        y: 100+Math.random()*(WORLD-200),
        type: t[Math.floor(Math.random()*t.length)],
        alive: true
      });
    }
  }
}, 12000);

// API para ver salas activas
app.get("/api/rooms", (req, res) => {
  const info = Object.values(rooms).map(r => ({
    id: r.id,
    players: Object.keys(r.players).length,
    max: MAX_PLAYERS_PER_ROOM
  }));
  res.json(info);
});

// ══════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join", (data) => {
    currentRoom = getAvailableRoom();
    const roomId = currentRoom.id;
    socket.join(roomId);

    currentRoom.players[socket.id] = {
      id: socket.id, name: data.name||"Jugador", skinId: data.skinId||"s0",
      x: 200+Math.random()*(WORLD-400), y: 200+Math.random()*(WORLD-400),
      radius: 18, xp: 0, evoIdx: 0, kills: 0, score: 0, alive: true, vx: 0, vy: 0
    };

    const totalInRoom = Object.keys(currentRoom.players).length;
    console.log(`👾 ${data.name} → ${roomId} (${totalInRoom}/${MAX_PLAYERS_PER_ROOM})`);

    socket.emit("init", {
      id: socket.id,
      roomId,
      roomCount: Object.keys(rooms).length,
      playersInRoom: totalInRoom,
      players: currentRoom.players,
      energyOrbs: currentRoom.energyOrbs,
      powerupOrbs: currentRoom.powerupOrbs
    });

    socket.to(roomId).emit("playerJoined", currentRoom.players[socket.id]);
  });

  socket.on("ping_check", () => socket.emit("pong_check"));

  socket.on("move", (data) => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    if (!p || !p.alive) return;
    p.x = Math.max(p.radius, Math.min(WORLD-p.radius, data.x));
    p.y = Math.max(p.radius, Math.min(WORLD-p.radius, data.y));
    p.vx = data.vx||0; p.vy = data.vy||0;
    p.radius = data.radius||p.radius; p.xp = data.xp||p.xp;
    p.evoIdx = data.evoIdx||p.evoIdx; p.score = data.score||p.score;
  });

  socket.on("shoot", (data) => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    if (!p || !p.alive) return;
    const b = { id: currentRoom.bulletId++, ownerId: socket.id, ...data, life: 1.2 };
    currentRoom.bullets.push(b);
    socket.to(currentRoom.id).emit("bulletSpawned", b);
  });

  socket.on("eatOrb", (id) => {
    if (!currentRoom) return;
    const o = currentRoom.energyOrbs.find(o => o.id===id && o.alive);
    if (!o) return;
    o.alive = false;
    socket.to(currentRoom.id).emit("orbEaten", id);
    setTimeout(() => { o.x=Math.random()*WORLD; o.y=Math.random()*WORLD; o.alive=true; io.to(currentRoom.id).emit("orbRespawn", o); }, 3000+Math.random()*2000);
  });

  socket.on("eatPowerup", (id) => {
    if (!currentRoom) return;
    const p = currentRoom.powerupOrbs.find(p => p.id===id && p.alive);
    if (!p) return;
    p.alive = false;
    io.to(currentRoom.id).emit("powerupEaten", { powId: id, playerId: socket.id, type: p.type });
    currentRoom.powerupOrbs = currentRoom.powerupOrbs.filter(x => x.id !== id);
  });

  socket.on("killPlayer", (targetId) => {
    if (!currentRoom) return;
    const k = currentRoom.players[socket.id], t = currentRoom.players[targetId];
    if (!k || !t || !t.alive) return;
    t.alive = false; k.kills = (k.kills||0) + 1;
    io.to(currentRoom.id).emit("playerKilled", { killerId: socket.id, targetId, killerName: k.name, targetName: t.name });
    setTimeout(() => {
      if (currentRoom && currentRoom.players[targetId]) {
        currentRoom.players[targetId].alive = true;
        currentRoom.players[targetId].x = 200+Math.random()*(WORLD-400);
        currentRoom.players[targetId].y = 200+Math.random()*(WORLD-400);
        currentRoom.players[targetId].radius = 18;
        currentRoom.players[targetId].xp = 0;
        currentRoom.players[targetId].evoIdx = 0;
        io.to(currentRoom.id).emit("playerRespawned", currentRoom.players[targetId]);
      }
    }, 3000);
  });

  socket.on("chat", (msg) => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    if (!p) return;
    io.to(currentRoom.id).emit("chat", { name: p.name, msg: String(msg).slice(0,80) });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const p = currentRoom.players[socket.id];
    console.log(`❌ ${p?.name||socket.id} salió de ${currentRoom.id}`);
    delete currentRoom.players[socket.id];
    io.to(currentRoom.id).emit("playerLeft", socket.id);
    setTimeout(cleanEmptyRooms, 5000);
  });
});

// Tick por sala
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (Object.keys(room.players).length === 0) continue;
    io.to(roomId).emit("tick", {
      players: Object.values(room.players).map(p => ({
        id: p.id, x: p.x, y: p.y, radius: p.radius,
        evoIdx: p.evoIdx, xp: p.xp, score: p.score,
        kills: p.kills, alive: p.alive, name: p.name, skinId: p.skinId
      })),
      roomInfo: { id: roomId, count: Object.keys(room.players).length }
    });
  }
}, TICK_RATE);

http.listen(process.env.PORT || 3000, () => {
  console.log("🎮 EvoMon Server en puerto", process.env.PORT || 3000);
  console.log("💳 Stripe:", process.env.STRIPE_SECRET_KEY ? "✅ OK" : "❌ FALTA KEY");
  console.log("🏠 Sistema de salas automáticas activo — máx", MAX_PLAYERS_PER_ROOM, "por sala");
});
