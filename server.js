/*
 * Serveur Proxy - Alzheimer Monitor
 * Version Standalone (sans Arduino Cloud API)
 * 
 * Ce serveur:
 * - Reçoit les données HTTP de l'ESP32 (WiFi ou GPRS)
 * - Stocke les données localement
 * - Affiche un dashboard web complet
 * - Gère les alertes et notifications
 * 
 * Date: Janvier 2026
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Seuils d'alerte
  HEART_RATE_MIN: 50,
  HEART_RATE_MAX: 120,
  
  // Position de référence (domicile)
  HOME_LAT: 34.0331,
  HOME_LON: -5.0003,
  GEOFENCE_RADIUS: 100,  // mètres
  
  // Numéros pour alertes
  PHONE_NUMBERS: ['+212707591033'],
  
  // Webhook pour notifications (optionnel)
  WEBHOOK_URL: process.env.WEBHOOK_URL || ''
};

// ═══════════════════════════════════════════════════════════════
// STOCKAGE DES DONNÉES
// ═══════════════════════════════════════════════════════════════

// Dernières données reçues
let latestData = {
  timestamp: null,
  lat: 0,
  lon: 0,
  heartRate: 0,
  temperature: 0,
  accelX: 0,
  accelY: 0,
  accelZ: 0,
  accelMag: 0,
  satellites: 0,
  gpsValid: false,
  connectionMode: 'unknown',
  rssi: 0,
  alerts: {
    fall: false,
    zone: false,
    bpm: false,
    code: 0
  }
};

// Historique (dernières 1000 entrées)
let dataHistory = [];
const MAX_HISTORY = 1000;

// Historique des alertes
let alertHistory = [];
const MAX_ALERT_HISTORY = 100;

// Stats
let stats = {
  totalRequests: 0,
  successfulUpdates: 0,
  failedUpdates: 0,
  lastUpdate: null,
  uptime: Date.now(),
  wifiUpdates: 0,
  gprsUpdates: 0
};

// Commande en attente pour l'ESP32
let pendingCommand = '';

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logger
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════════
// GESTION DES ALERTES
// ═══════════════════════════════════════════════════════════════

async function handleAlerts(data, previousAlerts) {
  const currentAlerts = data.alerts || { fall: false, zone: false, bpm: false };
  const newAlerts = [];
  
  // Détecter nouvelles alertes
  if (currentAlerts.fall && !previousAlerts.fall) {
    newAlerts.push({ type: 'fall', message: '🚨 CHUTE DÉTECTÉE!' });
  }
  if (currentAlerts.zone && !previousAlerts.zone) {
    newAlerts.push({ type: 'zone', message: '📍 SORTIE DE ZONE!' });
  }
  if (currentAlerts.bpm && !previousAlerts.bpm) {
    newAlerts.push({ type: 'bpm', message: `❤️ BPM ANORMAL: ${data.heartRate}` });
  }
  
  if (newAlerts.length > 0) {
    const alertEntry = {
      timestamp: new Date().toISOString(),
      alerts: newAlerts,
      position: { lat: data.lat, lon: data.lon },
      heartRate: data.heartRate,
      temperature: data.temperature
    };
    
    // Ajouter à l'historique des alertes
    alertHistory.unshift(alertEntry);
    if (alertHistory.length > MAX_ALERT_HISTORY) {
      alertHistory.pop();
    }
    
    // Log
    console.log('\n⚠️ ════════════════════════════════════════');
    console.log('   NOUVELLE ALERTE!');
    newAlerts.forEach(a => console.log('   ' + a.message));
    console.log('   Position:', data.lat?.toFixed(6), ',', data.lon?.toFixed(6));
    console.log('   BPM:', data.heartRate, '| Temp:', data.temperature, '°C');
    console.log('════════════════════════════════════════════\n');
    
    // Webhook si configuré
    if (CONFIG.WEBHOOK_URL) {
      try {
        const axios = require('axios');
        await axios.post(CONFIG.WEBHOOK_URL, {
          content: `⚠️ ALERTE ALZHEIMER\n${newAlerts.map(a => a.message).join('\n')}\n📍 https://maps.google.com/?q=${data.lat},${data.lon}`,
          text: `ALERTE: ${newAlerts.map(a => a.message).join(', ')}`
        });
      } catch (error) {
        console.error('Erreur webhook:', error.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES API
// ═══════════════════════════════════════════════════════════════

// Page d'accueil - Redirection vers dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Info API
app.get('/api', (req, res) => {
  res.json({
    name: 'Alzheimer Monitor - Standalone Server',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      'POST /api/data': 'Recevoir données ESP32 (JSON)',
      'GET /api/data': 'Recevoir données ESP32 (Query params)',
      'GET /api/status': 'Status du serveur',
      'GET /api/latest': 'Dernières données',
      'GET /api/history': 'Historique données',
      'GET /api/alerts': 'Historique alertes',
      'POST /api/command': 'Envoyer commande',
      'GET /api/command': 'Récupérer commande en attente',
      'GET /dashboard': 'Dashboard web complet'
    },
    uptime: Math.floor((Date.now() - stats.uptime) / 1000) + 's'
  });
});

// ═══════════════════════════════════════════════════════════════
// RÉCEPTION DES DONNÉES
// ═══════════════════════════════════════════════════════════════

// POST /api/data - Réception JSON
app.post('/api/data', async (req, res) => {
  stats.totalRequests++;
  
  try {
    const data = req.body;
    console.log('📥 Données reçues (POST):', JSON.stringify(data).substring(0, 150) + '...');
    
    const previousAlerts = { ...latestData.alerts };
    
    // Parser les données
    const parsedData = parseIncomingData(data);
    
    // Mettre à jour
    latestData = parsedData;
    
    // Ajouter à l'historique
    dataHistory.unshift(parsedData);
    if (dataHistory.length > MAX_HISTORY) {
      dataHistory.pop();
    }
    
    // Gérer les alertes
    await handleAlerts(parsedData, previousAlerts);
    
    // Stats
    stats.successfulUpdates++;
    stats.lastUpdate = new Date().toISOString();
    if (parsedData.connectionMode === 'wifi') {
      stats.wifiUpdates++;
    } else {
      stats.gprsUpdates++;
    }
    
    console.log(`✅ Données enregistrées | Mode: ${parsedData.connectionMode} | BPM: ${parsedData.heartRate} | Alertes: ${parsedData.alerts.code}`);
    
    res.json({
      success: true,
      message: 'Data received',
      timestamp: parsedData.timestamp,
      command: pendingCommand  // Renvoyer commande en attente
    });
    
    // Clear commande après envoi
    if (pendingCommand) {
      console.log(`📤 Commande envoyée à ESP32: ${pendingCommand}`);
      pendingCommand = '';
    }
    
  } catch (error) {
    stats.failedUpdates++;
    console.error('❌ Erreur:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/data - Réception via query params (pour SIM900)
app.get('/api/data', async (req, res) => {
  stats.totalRequests++;
  
  try {
    const data = req.query;
    console.log('📥 Données reçues (GET):', JSON.stringify(data).substring(0, 150) + '...');
    
    const previousAlerts = { ...latestData.alerts };
    const parsedData = parseIncomingData(data);
    
    latestData = parsedData;
    
    dataHistory.unshift(parsedData);
    if (dataHistory.length > MAX_HISTORY) {
      dataHistory.pop();
    }
    
    await handleAlerts(parsedData, previousAlerts);
    
    stats.successfulUpdates++;
    stats.lastUpdate = new Date().toISOString();
    if (parsedData.connectionMode === 'wifi') {
      stats.wifiUpdates++;
    } else {
      stats.gprsUpdates++;
    }
    
    console.log(`✅ OK | Mode: ${parsedData.connectionMode} | BPM: ${parsedData.heartRate}`);
    
    // Réponse simple pour SIM900
    res.send('OK');
    
  } catch (error) {
    stats.failedUpdates++;
    console.error('❌ Erreur:', error.message);
    res.status(500).send('ERROR');
  }
});

// Parser les données entrantes
function parseIncomingData(data) {
  const parsed = {
    timestamp: new Date().toISOString(),
    lat: parseFloat(data.lat) || 0,
    lon: parseFloat(data.lon) || 0,
    heartRate: parseInt(data.heartRate) || parseInt(data.hr) || 0,
    temperature: parseFloat(data.temperature) || parseFloat(data.temp) || 0,
    accelX: parseFloat(data.accelX) || parseFloat(data.ax) || 0,
    accelY: parseFloat(data.accelY) || parseFloat(data.ay) || 0,
    accelZ: parseFloat(data.accelZ) || parseFloat(data.az) || 0,
    accelMag: parseFloat(data.accelMag) || parseFloat(data.mag) || 0,
    satellites: parseInt(data.satellites) || parseInt(data.sat) || 0,
    gpsValid: data.gpsValid === true || data.gps === 'true' || data.gps === true,
    connectionMode: data.mode || data.connectionMode || 'unknown',
    rssi: parseInt(data.rssi) || 0,
    alerts: {
      fall: data.fall === true || data.fall === 'true',
      zone: data.zone === true || data.zone === 'true',
      bpm: data.bpm === true || data.bpm === 'true',
      code: parseInt(data.alertCode) || parseInt(data.code) || 0
    }
  };
  
  // Calculer code alerte si non fourni
  if (parsed.alerts.code === 0) {
    parsed.alerts.code = 
      (parsed.alerts.fall ? 1 : 0) +
      (parsed.alerts.zone ? 2 : 0) +
      (parsed.alerts.bpm ? 4 : 0);
  }
  
  return parsed;
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS DONNÉES
// ═══════════════════════════════════════════════════════════════

// Status du serveur
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: Math.floor((Date.now() - stats.uptime) / 1000),
    uptimeFormatted: formatUptime(Date.now() - stats.uptime),
    stats: {
      totalRequests: stats.totalRequests,
      successfulUpdates: stats.successfulUpdates,
      failedUpdates: stats.failedUpdates,
      wifiUpdates: stats.wifiUpdates,
      gprsUpdates: stats.gprsUpdates,
      lastUpdate: stats.lastUpdate
    },
    latestData: {
      timestamp: latestData.timestamp,
      hasGPS: latestData.lat !== 0,
      heartRate: latestData.heartRate,
      temperature: latestData.temperature,
      connectionMode: latestData.connectionMode,
      alertsActive: latestData.alerts.code > 0
    },
    historyCount: dataHistory.length,
    alertCount: alertHistory.length
  });
});

// Dernières données
app.get('/api/latest', (req, res) => {
  res.json(latestData);
});

// Historique
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_HISTORY);
  res.json({
    count: dataHistory.length,
    limit: limit,
    data: dataHistory.slice(0, limit)
  });
});

// Historique des alertes
app.get('/api/alerts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_ALERT_HISTORY);
  res.json({
    count: alertHistory.length,
    limit: limit,
    alerts: alertHistory.slice(0, limit)
  });
});

// Envoyer commande
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  pendingCommand = command.toUpperCase();
  console.log(`📤 Commande enregistrée: ${pendingCommand}`);
  
  res.json({
    success: true,
    command: pendingCommand,
    message: 'Command will be sent on next ESP32 request'
  });
});

// Récupérer commande en attente
app.get('/api/command', (req, res) => {
  const cmd = pendingCommand;
  pendingCommand = '';
  res.json({ command: cmd });
});

// Reset alertes (via API)
app.post('/api/reset', (req, res) => {
  latestData.alerts = { fall: false, zone: false, bpm: false, code: 0 };
  pendingCommand = 'RESET';
  res.json({ success: true, message: 'Alerts reset, command queued' });
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD WEB COMPLET
// ═══════════════════════════════════════════════════════════════

app.get('/dashboard', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>🧠 Alzheimer Monitor</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      min-height: 100vh;
    }
    
    .header {
      background: rgba(0, 212, 255, 0.1);
      padding: 15px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(0, 212, 255, 0.3);
    }
    
    .header h1 {
      font-size: 1.5em;
      color: #00d4ff;
    }
    
    .header .status {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #2ed573;
      animation: pulse 2s infinite;
    }
    
    .status-dot.offline { background: #ff4757; animation: none; }
    .status-dot.warning { background: #ffa502; }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.1); }
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    
    .card {
      background: rgba(22, 33, 62, 0.8);
      border-radius: 15px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(0, 212, 255, 0.1);
      transition: transform 0.3s, box-shadow 0.3s;
    }
    
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(0, 212, 255, 0.2);
    }
    
    .card h2 {
      color: #00d4ff;
      margin-bottom: 15px;
      font-size: 1.1em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .card .value {
      font-size: 3em;
      font-weight: bold;
      color: #fff;
    }
    
    .card .unit {
      font-size: 0.4em;
      color: #888;
      margin-left: 5px;
    }
    
    .card .subtitle {
      color: #666;
      font-size: 0.9em;
      margin-top: 5px;
    }
    
    .card-wide {
      grid-column: span 2;
    }
    
    @media (max-width: 768px) {
      .card-wide { grid-column: span 1; }
    }
    
    /* Alertes */
    .alerts-container {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    
    .alert-badge {
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.9em;
      font-weight: 500;
      transition: all 0.3s;
    }
    
    .alert-badge.ok {
      background: rgba(46, 213, 115, 0.2);
      color: #2ed573;
      border: 1px solid #2ed573;
    }
    
    .alert-badge.danger {
      background: rgba(255, 71, 87, 0.3);
      color: #ff4757;
      border: 1px solid #ff4757;
      animation: alertPulse 1s infinite;
    }
    
    @keyframes alertPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    
    /* Carte */
    #map {
      height: 350px;
      border-radius: 10px;
      border: 1px solid rgba(0, 212, 255, 0.2);
    }
    
    .coordinates {
      margin-top: 10px;
      color: #888;
      font-family: monospace;
      font-size: 0.9em;
    }
    
    /* Commandes */
    .command-section {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    
    .command-btn {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.3s;
    }
    
    .command-btn.primary {
      background: #00d4ff;
      color: #000;
    }
    
    .command-btn.danger {
      background: #ff4757;
      color: #fff;
    }
    
    .command-btn.secondary {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    
    .command-btn:hover {
      transform: scale(1.05);
    }
    
    .command-input {
      flex: 1;
      min-width: 150px;
      padding: 10px 15px;
      border-radius: 8px;
      border: 1px solid rgba(0, 212, 255, 0.3);
      background: rgba(0, 0, 0, 0.3);
      color: #fff;
      font-size: 1em;
    }
    
    .command-input::placeholder {
      color: #666;
    }
    
    /* Stats */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 15px;
    }
    
    .stat-item {
      text-align: center;
      padding: 15px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 10px;
    }
    
    .stat-item .stat-value {
      font-size: 1.8em;
      font-weight: bold;
      color: #00d4ff;
    }
    
    .stat-item .stat-label {
      font-size: 0.8em;
      color: #888;
      margin-top: 5px;
    }
    
    /* Historique alertes */
    .alert-history {
      max-height: 200px;
      overflow-y: auto;
    }
    
    .alert-item {
      padding: 10px;
      margin-bottom: 8px;
      background: rgba(255, 71, 87, 0.1);
      border-radius: 8px;
      border-left: 3px solid #ff4757;
      font-size: 0.9em;
    }
    
    .alert-item .time {
      color: #888;
      font-size: 0.8em;
    }
    
    /* Footer */
    .footer {
      text-align: center;
      padding: 20px;
      color: #666;
      font-size: 0.9em;
    }
    
    /* Responsive */
    @media (max-width: 600px) {
      .header { flex-direction: column; gap: 10px; }
      .card .value { font-size: 2.5em; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧠 Alzheimer Monitor</h1>
    <div class="status">
      <span id="connectionStatus">Connexion...</span>
      <div class="status-dot" id="statusDot"></div>
      <span id="lastUpdate">--</span>
    </div>
  </div>
  
  <div class="container">
    <!-- Alertes -->
    <div class="card" id="alertCard" style="margin-bottom: 20px;">
      <h2>⚠️ État des Alertes</h2>
      <div class="alerts-container" id="alertsContainer">
        <span class="alert-badge ok" id="alertFall">✓ Chute</span>
        <span class="alert-badge ok" id="alertZone">✓ Zone</span>
        <span class="alert-badge ok" id="alertBpm">✓ BPM</span>
      </div>
    </div>
    
    <!-- Données principales -->
    <div class="grid">
      <div class="card">
        <h2>❤️ Rythme Cardiaque</h2>
        <div class="value" id="heartRate">--<span class="unit">BPM</span></div>
        <div class="subtitle">Normal: 50-120 BPM</div>
      </div>
      
      <div class="card">
        <h2>🌡️ Température</h2>
        <div class="value" id="temperature">--<span class="unit">°C</span></div>
        <div class="subtitle">Température corporelle</div>
      </div>
      
      <div class="card">
        <h2>📡 Mode Connexion</h2>
        <div class="value" id="connectionMode">--</div>
        <div class="subtitle" id="rssi">Signal: --</div>
      </div>
      
      <div class="card">
        <h2>🛰️ GPS</h2>
        <div class="value" id="satellites">--<span class="unit">sat</span></div>
        <div class="subtitle" id="gpsStatus">En attente...</div>
      </div>
    </div>
    
    <!-- Carte -->
    <div class="card card-wide">
      <h2>📍 Position GPS</h2>
      <div id="map"></div>
      <div class="coordinates" id="coordinates">Coordonnées: --</div>
    </div>
    
    <!-- Accélération -->
    <div class="card">
      <h2>📊 Accélération</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center;">
        <div>
          <div style="font-size: 1.5em; color: #ff6b6b;" id="accelX">0.00</div>
          <div style="color: #888; font-size: 0.8em;">X</div>
        </div>
        <div>
          <div style="font-size: 1.5em; color: #4ecdc4;" id="accelY">0.00</div>
          <div style="color: #888; font-size: 0.8em;">Y</div>
        </div>
        <div>
          <div style="font-size: 1.5em; color: #45b7d1;" id="accelZ">0.00</div>
          <div style="color: #888; font-size: 0.8em;">Z</div>
        </div>
      </div>
      <div style="margin-top: 15px; text-align: center;">
        <span style="font-size: 0.9em; color: #888;">Magnitude:</span>
        <span style="font-size: 1.2em; font-weight: bold;" id="accelMag">0.00</span>
        <span style="color: #888;">g</span>
      </div>
    </div>
    
    <!-- Commandes -->
    <div class="card">
      <h2>🎮 Commandes</h2>
      <div class="command-section">
        <button class="command-btn primary" onclick="sendCommand('RESET')">Reset Alertes</button>
        <button class="command-btn secondary" onclick="sendCommand('STATUS')">Status</button>
        <button class="command-btn secondary" onclick="sendCommand('LOCATE')">Localiser</button>
        <button class="command-btn danger" onclick="sendCommand('FALL_TEST')">Test Chute</button>
      </div>
      <div class="command-section" style="margin-top: 10px;">
        <input type="text" class="command-input" id="customCommand" placeholder="Commande personnalisée...">
        <button class="command-btn primary" onclick="sendCustomCommand()">Envoyer</button>
      </div>
    </div>
    
    <!-- Stats -->
    <div class="card">
      <h2>📈 Statistiques</h2>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-value" id="statTotal">0</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="statWifi">0</div>
          <div class="stat-label">WiFi</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="statGprs">0</div>
          <div class="stat-label">GPRS</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="statUptime">0</div>
          <div class="stat-label">Uptime (h)</div>
        </div>
      </div>
    </div>
    
    <!-- Historique alertes -->
    <div class="card">
      <h2>🔔 Historique Alertes</h2>
      <div class="alert-history" id="alertHistory">
        <p style="color: #666; text-align: center;">Aucune alerte récente</p>
      </div>
    </div>
  </div>
  
  <div class="footer">
    Alzheimer Monitor v2.0 | Proxy Server Standalone<br>
    Dernière mise à jour: <span id="footerTime">--</span>
  </div>
  
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    // Initialisation carte
    const map = L.map('map').setView([34.0331, -5.0003], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    
    let marker = L.marker([34.0331, -5.0003]).addTo(map);
    let pathCoords = [];
    let pathLine = null;
    
    // Mise à jour des données
    async function updateData() {
      try {
        const response = await fetch('/api/latest');
        const data = await response.json();
        
        // Status connexion
        const now = new Date();
        const lastUpdate = data.timestamp ? new Date(data.timestamp) : null;
        const diffSeconds = lastUpdate ? (now - lastUpdate) / 1000 : 999;
        
        const statusDot = document.getElementById('statusDot');
        const connectionStatus = document.getElementById('connectionStatus');
        
        if (diffSeconds < 30) {
          statusDot.className = 'status-dot';
          connectionStatus.textContent = 'En ligne';
        } else if (diffSeconds < 120) {
          statusDot.className = 'status-dot warning';
          connectionStatus.textContent = 'Retard';
        } else {
          statusDot.className = 'status-dot offline';
          connectionStatus.textContent = 'Hors ligne';
        }
        
        // Valeurs
        document.getElementById('heartRate').innerHTML = (data.heartRate || '--') + '<span class="unit">BPM</span>';
        document.getElementById('temperature').innerHTML = (data.temperature?.toFixed(1) || '--') + '<span class="unit">°C</span>';
        document.getElementById('connectionMode').textContent = (data.connectionMode || '--').toUpperCase();
        document.getElementById('rssi').textContent = data.rssi ? 'Signal: ' + data.rssi + ' dBm' : 'Signal: --';
        document.getElementById('satellites').innerHTML = (data.satellites || '--') + '<span class="unit">sat</span>';
        document.getElementById('gpsStatus').textContent = data.gpsValid ? 'GPS actif' : 'Recherche...';
        
        // Accélération
        document.getElementById('accelX').textContent = data.accelX?.toFixed(2) || '0.00';
        document.getElementById('accelY').textContent = data.accelY?.toFixed(2) || '0.00';
        document.getElementById('accelZ').textContent = data.accelZ?.toFixed(2) || '0.00';
        document.getElementById('accelMag').textContent = data.accelMag?.toFixed(2) || '0.00';
        
        // Alertes
        updateAlert('alertFall', 'Chute', data.alerts?.fall);
        updateAlert('alertZone', 'Zone', data.alerts?.zone);
        updateAlert('alertBpm', 'BPM', data.alerts?.bpm);
        
        // Card alerte
        const alertCard = document.getElementById('alertCard');
        if (data.alerts?.code > 0) {
          alertCard.style.borderColor = '#ff4757';
          alertCard.style.background = 'rgba(255, 71, 87, 0.1)';
        } else {
          alertCard.style.borderColor = 'rgba(0, 212, 255, 0.1)';
          alertCard.style.background = 'rgba(22, 33, 62, 0.8)';
        }
        
        // Carte
        if (data.lat && data.lon && data.lat !== 0) {
          const newPos = [data.lat, data.lon];
          marker.setLatLng(newPos);
          map.setView(newPos, 16);
          document.getElementById('coordinates').textContent = 
            'Coordonnées: ' + data.lat.toFixed(6) + ', ' + data.lon.toFixed(6);
          
          // Tracer le chemin
          pathCoords.push(newPos);
          if (pathCoords.length > 100) pathCoords.shift();
          if (pathLine) map.removeLayer(pathLine);
          if (pathCoords.length > 1) {
            pathLine = L.polyline(pathCoords, {color: '#00d4ff', weight: 3, opacity: 0.7}).addTo(map);
          }
        }
        
        // Timestamp
        document.getElementById('lastUpdate').textContent = 
          lastUpdate ? lastUpdate.toLocaleTimeString('fr-FR') : '--';
        document.getElementById('footerTime').textContent = 
          now.toLocaleString('fr-FR');
        
      } catch (error) {
        console.error('Erreur update:', error);
      }
    }
    
    // Mise à jour stats
    async function updateStats() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        document.getElementById('statTotal').textContent = data.stats.successfulUpdates || 0;
        document.getElementById('statWifi').textContent = data.stats.wifiUpdates || 0;
        document.getElementById('statGprs').textContent = data.stats.gprsUpdates || 0;
        document.getElementById('statUptime').textContent = Math.floor(data.uptime / 3600);
        
      } catch (error) {
        console.error('Erreur stats:', error);
      }
    }
    
    // Mise à jour historique alertes
    async function updateAlertHistory() {
      try {
        const response = await fetch('/api/alerts?limit=10');
        const data = await response.json();
        
        const container = document.getElementById('alertHistory');
        
        if (data.alerts && data.alerts.length > 0) {
          container.innerHTML = data.alerts.map(alert => {
            const time = new Date(alert.timestamp).toLocaleString('fr-FR');
            const messages = alert.alerts.map(a => a.message).join(', ');
            return '<div class="alert-item"><div class="time">' + time + '</div>' + messages + '</div>';
          }).join('');
        } else {
          container.innerHTML = '<p style="color: #666; text-align: center;">Aucune alerte récente</p>';
        }
        
      } catch (error) {
        console.error('Erreur alertHistory:', error);
      }
    }
    
    function updateAlert(id, label, isActive) {
      const el = document.getElementById(id);
      if (isActive) {
        el.className = 'alert-badge danger';
        el.textContent = '⚠️ ' + label;
      } else {
        el.className = 'alert-badge ok';
        el.textContent = '✓ ' + label;
      }
    }
    
    async function sendCommand(cmd) {
      try {
        const response = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const data = await response.json();
        alert('Commande envoyée: ' + cmd);
      } catch (error) {
        alert('Erreur: ' + error.message);
      }
    }
    
    function sendCustomCommand() {
      const input = document.getElementById('customCommand');
      const cmd = input.value.trim();
      if (cmd) {
        sendCommand(cmd);
        input.value = '';
      }
    }
    
    // Mise à jour automatique
    updateData();
    updateStats();
    updateAlertHistory();
    setInterval(updateData, 3000);
    setInterval(updateStats, 10000);
    setInterval(updateAlertHistory, 15000);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

// ═══════════════════════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════════════════════

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return days + 'j ' + (hours % 24) + 'h';
  if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
  if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
  return seconds + 's';
}

// ═══════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   Alzheimer Monitor - Standalone Server               ║');
  console.log('║   Version 2.0 (Sans Arduino Cloud API)                ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('🚀 Serveur démarré sur le port ' + PORT);
  console.log('');
  console.log('📡 Endpoints:');
  console.log('   POST/GET /api/data  - Recevoir données ESP32');
  console.log('   GET /api/status     - Status serveur');
  console.log('   GET /api/latest     - Dernières données');
  console.log('   GET /api/history    - Historique');
  console.log('   GET /api/alerts     - Historique alertes');
  console.log('   GET /dashboard      - Dashboard web complet');
  console.log('');
  console.log('✅ Prêt à recevoir des données!');
  console.log('');
});
