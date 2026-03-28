// ============================================
// Middledeh — Backend API
// ============================================

const express = require('express')
const cors    = require('cors')
const crypto  = require('crypto')
const fs      = require('fs')
const path    = require('path')

const app = express()
app.use(cors())
app.use(express.json())

// ── DATA FILE (simple JSON storage for now) ──
const DB_FILE = path.join(__dirname, 'db.json')

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { projects: {}, players: {}, leaderboards: {}, flags: [], logs: [] }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

// ── MIDDLEWARE: verify API key ──
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key
  if (!key) return res.status(401).json({ error: 'No API key provided' })
  const db = loadDB()
  const project = Object.values(db.projects).find(p => p.apiKey === key)
  if (!project) return res.status(401).json({ error: 'Invalid API key' })
  req.project = project
  next()
}

function addLog(db, projectId, type, msg) {
  if (!db.logs) db.logs = []
  db.logs.unshift({
    projectId,
    type,
    msg,
    time: new Date().toISOString()
  })
  // keep only last 500 logs
  db.logs = db.logs.slice(0, 500)
}

// ══════════════════════════════════════════
// PROJECT ROUTES (dashboard uses these)
// ══════════════════════════════════════════

// Create a new project
app.post('/projects/create', (req, res) => {
  const { name, email } = req.body
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' })

  const db = loadDB()
  const id  = 'proj_' + crypto.randomBytes(6).toString('hex')
  const key = 'mde_'  + crypto.randomBytes(20).toString('hex')

  db.projects[id] = {
    id,
    name,
    email,
    apiKey: key,
    createdAt: new Date().toISOString(),
    features: {
      saveData:     true,
      leaderboards: true,
      antiCheat:    false,
      discord:      true,
    },
    webhookUrl: '',
    webhookEvents: {
      playerJoin:    true,
      playerLeave:   false,
      cheatFlag:     true,
      leaderboardRecord: true,
    },
    anticheatThresholds: {
      maxCoinsPerMin: 500,
      maxXpPerMin:    1000,
      maxSpeed:       32,
      action:         'log',
    }
  }

  saveDB(db)
  res.json({ id, apiKey: key, name })
})

// Get project info (dashboard)
app.get('/projects/me', auth, (req, res) => {
  const db = loadDB()
  const logs = (db.logs || []).filter(l => l.projectId === req.project.id).slice(0, 50)
  const players = db.players[req.project.id] || {}
  const lb = db.leaderboards[req.project.id] || {}
  const flags = (db.flags || []).filter(f => f.projectId === req.project.id)

  res.json({
    project: req.project,
    stats: {
      totalPlayers: Object.keys(players).length,
      activePlayers: Object.values(players).filter(p => p.online).length,
      totalSaves: (db.logs||[]).filter(l=>l.projectId===req.project.id&&l.type==='save').length,
      totalFlags: flags.length,
    },
    logs,
    leaderboard: Object.values(lb).sort((a,b)=>b.score-a.score).slice(0,10),
  })
})

// Update features
app.post('/projects/features', auth, (req, res) => {
  const db = loadDB()
  db.projects[req.project.id].features = {
    ...db.projects[req.project.id].features,
    ...req.body
  }
  saveDB(db)
  res.json({ ok: true, features: db.projects[req.project.id].features })
})

// Update webhook
app.post('/projects/webhook', auth, (req, res) => {
  const db = loadDB()
  if (req.body.webhookUrl !== undefined) db.projects[req.project.id].webhookUrl = req.body.webhookUrl
  if (req.body.webhookEvents) db.projects[req.project.id].webhookEvents = { ...db.projects[req.project.id].webhookEvents, ...req.body.webhookEvents }
  saveDB(db)
  res.json({ ok: true })
})

// Update anticheat thresholds
app.post('/projects/anticheat', auth, (req, res) => {
  const db = loadDB()
  db.projects[req.project.id].anticheatThresholds = {
    ...db.projects[req.project.id].anticheatThresholds,
    ...req.body
  }
  saveDB(db)
  res.json({ ok: true })
})

// Rotate API key
app.post('/projects/rotate-key', auth, (req, res) => {
  const db = loadDB()
  const newKey = 'mde_' + crypto.randomBytes(20).toString('hex')
  db.projects[req.project.id].apiKey = newKey
  saveDB(db)
  res.json({ apiKey: newKey })
})

// Update project name
app.post('/projects/rename', auth, (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'Name required' })
  const db = loadDB()
  db.projects[req.project.id].name = name
  saveDB(db)
  res.json({ ok: true, name })
})

// ══════════════════════════════════════════
// PLAYER DATA (Roblox game calls these)
// ══════════════════════════════════════════

// Save player data
app.post('/players/save', auth, (req, res) => {
  const { player, data } = req.body
  if (!player || !data) return res.status(400).json({ error: 'player and data required' })

  const db = loadDB()
  if (!db.players[req.project.id]) db.players[req.project.id] = {}
  db.players[req.project.id][player] = {
    ...data,
    player,
    lastSaved: new Date().toISOString(),
    online: true,
  }

  addLog(db, req.project.id, 'save', `${player} data saved`)
  saveDB(db)

  // Discord webhook
  if (req.project.features.discord && req.project.webhookUrl && req.project.webhookEvents?.playerJoin) {
    sendWebhook(req.project.webhookUrl, `**${player}** data saved.`)
  }

  res.json({ ok: true })
})

// Load player data
app.get('/players/load', auth, (req, res) => {
  const { player } = req.query
  if (!player) return res.status(400).json({ error: 'player required' })

  const db = loadDB()
  const data = db.players?.[req.project.id]?.[player] || null
  res.json({ player, data })
})

// Player online/offline
app.post('/players/online', auth, (req, res) => {
  const { player, online } = req.body
  if (!player) return res.status(400).json({ error: 'player required' })

  const db = loadDB()
  if (!db.players[req.project.id]) db.players[req.project.id] = {}
  if (!db.players[req.project.id][player]) db.players[req.project.id][player] = { player }
  db.players[req.project.id][player].online = online
  db.players[req.project.id][player].lastSeen = new Date().toISOString()

  addLog(db, req.project.id, 'hook', `${player} ${online ? 'joined' : 'left'}`)

  // Discord webhook
  if (req.project.features.discord && req.project.webhookUrl) {
    if (online && req.project.webhookEvents?.playerJoin) sendWebhook(req.project.webhookUrl, `**${player}** joined the game.`)
    if (!online && req.project.webhookEvents?.playerLeave) sendWebhook(req.project.webhookUrl, `**${player}** left the game.`)
  }

  saveDB(db)
  res.json({ ok: true })
})

// ══════════════════════════════════════════
// LEADERBOARDS
// ══════════════════════════════════════════

// Post score
app.post('/leaderboard/score', auth, (req, res) => {
  const { player, score } = req.body
  if (!player || score === undefined) return res.status(400).json({ error: 'player and score required' })

  const db = loadDB()
  if (!db.leaderboards[req.project.id]) db.leaderboards[req.project.id] = {}

  const prev = db.leaderboards[req.project.id][player]?.score || 0
  const isRecord = score > prev

  db.leaderboards[req.project.id][player] = {
    player,
    score,
    updatedAt: new Date().toISOString()
  }

  addLog(db, req.project.id, 'score', `${player} posted score ${score}${isRecord ? ' (new best)' : ''}`)

  // Discord webhook for leaderboard record
  if (isRecord && req.project.features.discord && req.project.webhookUrl && req.project.webhookEvents?.leaderboardRecord) {
    sendWebhook(req.project.webhookUrl, `**${player}** set a new personal best: **${score}**`)
  }

  saveDB(db)
  res.json({ ok: true, isRecord })
})

// Get leaderboard
app.get('/leaderboard/top', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 10
  const db = loadDB()
  const lb = db.leaderboards?.[req.project.id] || {}
  const top = Object.values(lb).sort((a,b)=>b.score-a.score).slice(0, limit)
  res.json({ leaderboard: top })
})

// ══════════════════════════════════════════
// ANTI-CHEAT
// ══════════════════════════════════════════

// Report player stats for checking
app.post('/anticheat/check', auth, (req, res) => {
  const { player, stats } = req.body
  if (!player || !stats) return res.status(400).json({ error: 'player and stats required' })

  const thresholds = req.project.anticheatThresholds
  const flags = []

  if (stats.coinsPerMin  && stats.coinsPerMin  > thresholds.maxCoinsPerMin) flags.push(`coins/min too high (${stats.coinsPerMin} > ${thresholds.maxCoinsPerMin})`)
  if (stats.xpPerMin     && stats.xpPerMin     > thresholds.maxXpPerMin)    flags.push(`xp/min too high (${stats.xpPerMin} > ${thresholds.maxXpPerMin})`)
  if (stats.speed        && stats.speed        > thresholds.maxSpeed)        flags.push(`speed too high (${stats.speed} > ${thresholds.maxSpeed})`)

  const flagged = flags.length > 0

  if (flagged) {
    const db = loadDB()
    if (!db.flags) db.flags = []
    db.flags.push({
      projectId: req.project.id,
      player,
      flags,
      stats,
      time: new Date().toISOString()
    })
    addLog(db, req.project.id, 'flag', `${player} flagged — ${flags[0]}`)

    // Discord webhook
    if (req.project.features.discord && req.project.webhookUrl && req.project.webhookEvents?.cheatFlag) {
      sendWebhook(req.project.webhookUrl, `**${player}** flagged by anti-cheat:\n${flags.map(f=>`- ${f}`).join('\n')}`)
    }

    saveDB(db)
  }

  const action = flagged ? thresholds.action : 'none'
  res.json({ flagged, flags, action })
})

// Get flagged players
app.get('/anticheat/flags', auth, (req, res) => {
  const db = loadDB()
  const flags = (db.flags || []).filter(f => f.projectId === req.project.id)
  res.json({ flags })
})

// ══════════════════════════════════════════
// DISCORD WEBHOOK HELPER
// ══════════════════════════════════════════

function sendWebhook(url, message) {
  if (!url || !url.startsWith('https://discord.com/api/webhooks/')) return
  const https = require('https')
  const body  = JSON.stringify({ content: message, username: 'Middledeh' })
  const urlObj = new URL(url)
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }
  const req = https.request(options)
  req.on('error', () => {})
  req.write(body)
  req.end()
}

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'online', name: 'Middledeh API', version: '1.0.0' })
})

// ── START ──
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('=====================================')
  console.log('  Middledeh API running!')
  console.log(`  http://localhost:${PORT}`)
  console.log('=====================================')
})

