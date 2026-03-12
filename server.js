require("dotenv").config();
console.log("STRIPE KEY:", process.env.STRIPE_SECRET_KEY);
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "REEMPLAZA_CON_TU_SK_LIVE");

const path = require("path");

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});                                                            
                                                                    
const COIN_PACKAGES = [
 { id: "pkg_500", coins: 500, bonus: 0, price: 1000 },
 { id: "pkg_1200", coins: 1200, bonus: 200, price: 2000 },
 { id: "pkg_3000", coins: 3000, bonus: 600, price: 4000 },
 { id: "pkg_8000", coins: 8000, bonus: 2000, price: 10000 }
];

let playerCoins = {};

// ── Comprar monedas ──
app.post("/api/buy-coins", async (req, res) => {
  try {
    const { packageId, playerId, playerName } = req.body;
    const pkg = COIN_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: "Paquete no válido" });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: {
        currency: "mxn",
        product_data: { name: `EvoMon — ${pkg.coins + pkg.bonus} monedas` },
        unit_amount: pkg.price,
      }, quantity: 1 }],
      mode: "payment",
      success_url: `${req.headers.origin || "http://localhost:3000"}/?payment=success&pkg=${packageId}&player=${playerId}`,
      cancel_url: `${req.headers.origin || "http://localhost:3000"}/`,
      metadata: { packageId, playerId, coins: String(pkg.coins + pkg.bonus) }
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Apoyar al creador ──
app.post("/api/support", async (req, res) => {
  try {
    const { amount, playerName } = req.body;
    const amountCents = Math.max(1000, parseInt(amount) * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: {
        currency: "mxn",
        product_data: { name: "❤️ Apoyar al creador de EvoMon", description: `Donación de ${playerName || "un jugador"}` },
        unit_amount: amountCents,
      }, quantity: 1 }],
      mode: "payment",
      success_url: `${req.headers.origin || "http://localhost:3000"}/?payment=support_ok`,
      cancel_url: `${req.headers.origin || "http://localhost:3000"}/`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Verificar pago ──
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

// ── Juego ──
const WORLD = 3000, TICK_RATE = 30;
let players = {}, energyOrbs = [], powerupOrbs = [], bullets = [], bulletId = 0;

for (let i = 0; i < 280; i++) energyOrbs.push({ id: i, x: Math.random()*WORLD, y: Math.random()*WORLD, value: Math.floor(Math.random()*5)+1, alive: true });
setInterval(() => { if (powerupOrbs.length < 5) { const t=["speed","triple","shield","magnet","giant"]; powerupOrbs.push({ id: Date.now(), x: 100+Math.random()*(WORLD-200), y: 100+Math.random()*(WORLD-200), type: t[Math.floor(Math.random()*t.length)], alive: true }); } }, 12000);

io.on("connection", (socket) => {
  console.log("✅ Conectado:", socket.id);
  socket.on("join", (data) => {
    players[socket.id] = { id: socket.id, name: data.name||"Jugador", skinId: data.skinId||"s0", x: 200+Math.random()*(WORLD-400), y: 200+Math.random()*(WORLD-400), radius: 18, xp: 0, evoIdx: 0, kills: 0, score: 0, alive: true, vx: 0, vy: 0 };
    socket.emit("init", { id: socket.id, players, energyOrbs, powerupOrbs });
    socket.broadcast.emit("playerJoined", players[socket.id]);
  });
  socket.on("ping_check", () => socket.emit("pong_check"));
  socket.on("move", (data) => { const p=players[socket.id]; if(!p||!p.alive)return; p.x=Math.max(p.radius,Math.min(WORLD-p.radius,data.x)); p.y=Math.max(p.radius,Math.min(WORLD-p.radius,data.y)); p.vx=data.vx||0; p.vy=data.vy||0; p.radius=data.radius||p.radius; p.xp=data.xp||p.xp; p.evoIdx=data.evoIdx||p.evoIdx; p.score=data.score||p.score; });
  socket.on("shoot", (data) => { const p=players[socket.id]; if(!p||!p.alive)return; const b={id:bulletId++,ownerId:socket.id,...data,life:1.2}; bullets.push(b); io.emit("bulletSpawned",b); });
  socket.on("eatOrb", (id) => { const o=energyOrbs.find(o=>o.id===id&&o.alive); if(!o)return; o.alive=false; io.emit("orbEaten",id); setTimeout(()=>{o.x=Math.random()*WORLD;o.y=Math.random()*WORLD;o.alive=true;io.emit("orbRespawn",o);},3000+Math.random()*2000); });
  socket.on("eatPowerup", (id) => { const p=powerupOrbs.find(p=>p.id===id&&p.alive); if(!p)return; p.alive=false; io.emit("powerupEaten",{powId:id,playerId:socket.id,type:p.type}); powerupOrbs=powerupOrbs.filter(x=>x.id!==id); });
  socket.on("killPlayer", (targetId) => { const k=players[socket.id],t=players[targetId]; if(!k||!t||!t.alive)return; t.alive=false; k.kills=(k.kills||0)+1; io.emit("playerKilled",{killerId:socket.id,targetId,killerName:k.name,targetName:t.name}); setTimeout(()=>{ if(players[targetId]){players[targetId].alive=true;players[targetId].x=200+Math.random()*(WORLD-400);players[targetId].y=200+Math.random()*(WORLD-400);players[targetId].radius=18;players[targetId].xp=0;players[targetId].evoIdx=0;io.emit("playerRespawned",players[targetId]);} },3000); });
  socket.on("chat", (msg) => { const p=players[socket.id]; if(!p)return; io.emit("chat",{name:p.name,msg:String(msg).slice(0,80)}); });
  socket.on("disconnect", () => { delete players[socket.id]; io.emit("playerLeft",socket.id); });
});

setInterval(() => { if(!Object.keys(players).length)return; io.emit("tick",{players:Object.values(players).map(p=>({id:p.id,x:p.x,y:p.y,radius:p.radius,evoIdx:p.evoIdx,xp:p.xp,score:p.score,kills:p.kills,alive:p.alive,name:p.name,skinId:p.skinId}))}); }, TICK_RATE);


http.listen(process.env.PORT || 3000, () => {
  console.log("Evomon Server en puerto", process.env.PORT || 3000);
});                                                                                                                                       