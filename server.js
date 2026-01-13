/*
 * Serveur Proxy - Arduino IoT Cloud
 * 
 * Ce serveur reçoit les données HTTP de l'ESP32 (via WiFi ou GPRS)
 * et les transmet à Arduino IoT Cloud via l'API.
 * 
 * Fonctionnalités:
 * - Reçoit HTTP POST/GET de l'ESP32
 * - Met à jour les variables Arduino IoT Cloud
 * - Gère les alertes et notifications
 * - Journalise les données
 * - API REST pour consultation
 * 
 * Date: Janvier 2026
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION ARDUINO IOT CLOUD
// ═══════════════════════════════════════════════════════════════

// Ces informations sont obtenues depuis Arduino Cloud
// https://create.arduino.cc/iot/things
const ARDUINO_CONFIG = {
  // Client credentials (depuis Arduino Cloud → API Keys)
  CLIENT_ID: '16f92ff3-1d43-4945-8c58-427eef27baac',           // ← À configurer
  CLIENT_SECRET: 'zonmPEUkrfpZpgIylpRe98exw',   // ← À configurer
  
  // Thing ID (depuis l'URL de votre Thing)
  THING_ID: '659e4d98-8050-4d24-aafa-1c33d574dcaa',             // ← À configurer
  
  // IDs des variables (depuis Arduino Cloud → Thing → Variables)
  VARIABLES: {
    location: '8803b5df-5886-450a-807d-194a2d7ea8cb',      // ← À configurer
    heartRate: '14b9b907-3409-4bb0-b779-26f79347491c',    // ← À configurer
    cloud_sensors: 'VARIABLE_ID_SENSORS',  // ← À configurer
    cloud_alerts: 'VARIABLE_ID_ALERTS',    // ← À configurer
    cloud_command: 'VARIABLE_ID_COMMAND'   // ← À configurer
  },
  
  // URLs API Arduino
  AUTH_URL: 'https://api2.arduino.cc/iot/v1/clients/token',
  API_BASE: 'https://api2.arduino.cc/iot/v2'
};

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION NOTIFICATIONS (Optionnel)
// ═══════════════════════════════════════════════════════════════

const NOTIFICATION_CONFIG = {
  // Webhook pour notifications (Telegram, Discord, etc.)
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  
  // Numéros pour SMS (via service externe comme Twilio)
  SMS_ENABLED: false,
  TWILIO_SID: process.env.TWILIO_SID || '',
  TWILIO_TOKEN: process.env.TWILIO_TOKEN || '',
  TWILIO_FROM: process.env.TWILIO_FROM || '',
  PHONE_NUMBERS: ['+212707591033']
};

// ═══════════════════════════════════════════════════════════════
// VARIABLES GLOBALES
// ═══════════════════════════════════════════════════════════════

let accessToken = null;
let tokenExpiry = 0;

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
  satellites: 0,
  alerts: {
    fall: false,
    zone: false,
    bpm: false,
    code: 0
  },
  connectionMode: 'unknown',
  rssi: 0
};

// Historique (dernières 100 entrées)
let dataHistory = [];
const MAX_HISTORY = 100;

// Stats
let stats = {
  totalRequests: 0,
  successfulUpdates: 0,
  failedUpdates: 0,
  lastUpdate: null,
  uptime: Date.now()
};

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logger middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════════
// AUTHENTIFICATION ARDUINO CLOUD
// ═══════════════════════════════════════════════════════════════

async function getAccessToken() {
  // Vérifier si le token est encore valide
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken;
  }
  
  console.log('🔑 Obtention nouveau token Arduino Cloud...');
  
  try {
    const response = await axios.post(ARDUINO_CONFIG.AUTH_URL, 
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: ARDUINO_CONFIG.CLIENT_ID,
        client_secret: ARDUINO_CONFIG.CLIENT_SECRET,
        audience: 'https://api2.arduino.cc/iot'
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    accessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    
    console.log('✅ Token obtenu, expire dans', response.data.expires_in, 'secondes');
    return accessToken;
    
  } catch (error) {
    console.error('❌ Erreur authentification:', error.response?.data || error.message);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// MISE À JOUR ARDUINO CLOUD
// ═══════════════════════════════════════════════════════════════

async function updateArduinoCloud(data) {
  const token = await getAccessToken();
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  
  const thingId = ARDUINO_CONFIG.THING_ID;
  const baseUrl = `${ARDUINO_CONFIG.API_BASE}/things/${thingId}/properties`;
  
  const updates = [];
  
  // Variable 1: Location (CloudLocation)
  if (data.lat && data.lon) {
    updates.push(
      axios.put(`${baseUrl}/${ARDUINO_CONFIG.VARIABLES.location}/publish`, {
        value: { lat: data.lat, lon: data.lon }
      }, { headers })
    );
  }
  
  // Variable 2: Heart Rate (int)
  if (data.heartRate !== undefined) {
    updates.push(
      axios.put(`${baseUrl}/${ARDUINO_CONFIG.VARIABLES.heartRate}/publish`, {
        value: data.heartRate
      }, { headers })
    );
  }
  
  // Variable 3: Sensors JSON (String)
  const sensorsJson = JSON.stringify({
    temp: data.temperature || 0,
    ax: data.accelX || 0,
    ay: data.accelY || 0,
    az: data.accelZ || 0,
    mag: data.accelMag || 0,
    sat: data.satellites || 0,
    lat: data.lat || 0,
    lon: data.lon || 0,
    gps: data.gpsValid || false,
    mode: data.connectionMode || 'unknown',
    rssi: data.rssi || 0
  });
  
  updates.push(
    axios.put(`${baseUrl}/${ARDUINO_CONFIG.VARIABLES.cloud_sensors}/publish`, {
      value: sensorsJson
    }, { headers })
  );
  
  // Variable 4: Alerts JSON (String)
  const alertsJson = JSON.stringify({
    fall: data.alerts?.fall || false,
    zone: data.alerts?.zone || false,
    bpm: data.alerts?.bpm || false,
    code: data.alerts?.code || 0,
    active: (data.alerts?.code || 0) > 0
  });
  
  updates.push(
    axios.put(`${baseUrl}/${ARDUINO_CONFIG.VARIABLES.cloud_alerts}/publish`, {
      value: alertsJson
    }, { headers })
  );
  
  // Exécuter toutes les mises à jour
  const results = await Promise.allSettled(updates);
  
  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  
  if (failed > 0) {
    console.log(`⚠️ ${successful}/${results.length} variables mises à jour`);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`  Variable ${i}: ${r.reason.message}`);
      }
    });
  }
  
  return { successful, failed, total: results.length };
}

// ═══════════════════════════════════════════════════════════════
// GESTION DES ALERTES
// ═══════════════════════════════════════════════════════════════

async function handleAlerts(data, previousAlerts) {
  const currentAlerts = data.alerts || { fall: false, zone: false, bpm: false };
  
  // Détecter nouvelles alertes
  const newAlerts = [];
  
  if (currentAlerts.fall && !previousAlerts.fall) {
    newAlerts.push('🚨 CHUTE DÉTECTÉE!');
  }
  if (currentAlerts.zone && !previousAlerts.zone) {
    newAlerts.push('📍 SORTIE DE ZONE!');
  }
  if (currentAlerts.bpm && !previousAlerts.bpm) {
    newAlerts.push(`❤️ BPM ANORMAL: ${data.heartRate}`);
  }
  
  if (newAlerts.length > 0) {
    const message = `
⚠️ ALERTE ALZHEIMER
${newAlerts.join('\n')}

📍 Position: ${data.lat?.toFixed(6)}, ${data.lon?.toFixed(6)}
🗺️ https://maps.google.com/?q=${data.lat},${data.lon}
❤️ BPM: ${data.heartRate}
🌡️ Temp: ${data.temperature}°C
⏰ ${new Date().toLocaleString('fr-FR')}
    `.trim();
    
    console.log('\n' + message + '\n');
    
    // Envoyer notification webhook si configuré
    if (NOTIFICATION_CONFIG.WEBHOOK_URL) {
      try {
        await axios.post(NOTIFICATION_CONFIG.WEBHOOK_URL, {
          content: message,
          text: message  // Pour différents formats de webhook
        });
        console.log('✅ Notification webhook envoyée');
      } catch (error) {
        console.error('❌ Erreur webhook:', error.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES API
// ═══════════════════════════════════════════════════════════════

// Page d'accueil
app.get('/', (req, res) => {
  res.json({
    name: 'Alzheimer Monitor Proxy',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      'POST /api/data': 'Recevoir données ESP32 (JSON)',
      'GET /api/data': 'Recevoir données ESP32 (Query params)',
      'GET /api/status': 'Status du serveur',
      'GET /api/latest': 'Dernières données',
      'GET /api/history': 'Historique données',
      'POST /api/command': 'Envoyer commande à ESP32'
    },
    uptime: Math.floor((Date.now() - stats.uptime) / 1000) + 's'
  });
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT PRINCIPAL - Réception données ESP32
// ═══════════════════════════════════════════════════════════════

// POST /api/data - Réception JSON
app.post('/api/data', async (req, res) => {
  stats.totalRequests++;
  
  try {
    const data = req.body;
    
    console.log('📥 Données reçues:', JSON.stringify(data).substring(0, 200));
    
    // Sauvegarder alertes précédentes pour comparaison
    const previousAlerts = { ...latestData.alerts };
    
    // Parser les données
    const parsedData = {
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
        fall: data.fall === true || data.fall === 'true' || data.alerts?.fall === true,
        zone: data.zone === true || data.zone === 'true' || data.alerts?.zone === true,
        bpm: data.bpm === true || data.bpm === 'true' || data.alerts?.bpm === true,
        code: parseInt(data.alertCode) || parseInt(data.code) || parseInt(data.alerts?.code) || 0
      }
    };
    
    // Calculer code alerte si non fourni
    if (parsedData.alerts.code === 0) {
      parsedData.alerts.code = 
        (parsedData.alerts.fall ? 1 : 0) +
        (parsedData.alerts.zone ? 2 : 0) +
        (parsedData.alerts.bpm ? 4 : 0);
    }
    
    // Mettre à jour les données
    latestData = parsedData;
    
    // Ajouter à l'historique
    dataHistory.unshift(parsedData);
    if (dataHistory.length > MAX_HISTORY) {
      dataHistory.pop();
    }
    
    // Gérer les alertes
    await handleAlerts(parsedData, previousAlerts);
    
    // Envoyer à Arduino Cloud
    let cloudResult = { successful: 0, failed: 0, total: 0 };
    
    if (ARDUINO_CONFIG.CLIENT_ID !== 'VOTRE_CLIENT_ID') {
      try {
        cloudResult = await updateArduinoCloud(parsedData);
        stats.successfulUpdates++;
        console.log(`☁️ Arduino Cloud: ${cloudResult.successful}/${cloudResult.total} OK`);
      } catch (error) {
        stats.failedUpdates++;
        console.error('❌ Erreur Arduino Cloud:', error.message);
      }
    } else {
      console.log('⚠️ Arduino Cloud non configuré - données stockées localement');
    }
    
    stats.lastUpdate = new Date().toISOString();
    
    // Réponse à l'ESP32
    res.json({
      success: true,
      message: 'Data received',
      cloud: cloudResult,
      timestamp: parsedData.timestamp
    });
    
  } catch (error) {
    stats.failedUpdates++;
    console.error('❌ Erreur traitement:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/data - Réception via query params (pour SIM900 simple)
app.get('/api/data', async (req, res) => {
  // Convertir query params en body et traiter
  req.body = req.query;
  
  // Réutiliser la logique POST
  stats.totalRequests++;
  
  try {
    const data = req.query;
    
    console.log('📥 Données reçues (GET):', JSON.stringify(data).substring(0, 200));
    
    const previousAlerts = { ...latestData.alerts };
    
    const parsedData = {
      timestamp: new Date().toISOString(),
      lat: parseFloat(data.lat) || 0,
      lon: parseFloat(data.lon) || 0,
      heartRate: parseInt(data.hr) || 0,
      temperature: parseFloat(data.temp) || 0,
      accelX: parseFloat(data.ax) || 0,
      accelY: parseFloat(data.ay) || 0,
      accelZ: parseFloat(data.az) || 0,
      accelMag: parseFloat(data.mag) || 0,
      satellites: parseInt(data.sat) || 0,
      gpsValid: data.gps === 'true' || data.gps === '1',
      connectionMode: data.mode || 'gprs',
      rssi: parseInt(data.rssi) || 0,
      alerts: {
        fall: data.fall === 'true' || data.fall === '1',
        zone: data.zone === 'true' || data.zone === '1',
        bpm: data.bpm === 'true' || data.bpm === '1',
        code: parseInt(data.code) || 0
      }
    };
    
    if (parsedData.alerts.code === 0) {
      parsedData.alerts.code = 
        (parsedData.alerts.fall ? 1 : 0) +
        (parsedData.alerts.zone ? 2 : 0) +
        (parsedData.alerts.bpm ? 4 : 0);
    }
    
    latestData = parsedData;
    
    dataHistory.unshift(parsedData);
    if (dataHistory.length > MAX_HISTORY) {
      dataHistory.pop();
    }
    
    await handleAlerts(parsedData, previousAlerts);
    
    let cloudResult = { successful: 0, failed: 0, total: 0 };
    
    if (ARDUINO_CONFIG.CLIENT_ID !== 'VOTRE_CLIENT_ID') {
      try {
        cloudResult = await updateArduinoCloud(parsedData);
        stats.successfulUpdates++;
      } catch (error) {
        stats.failedUpdates++;
        console.error('❌ Erreur Arduino Cloud:', error.message);
      }
    }
    
    stats.lastUpdate = new Date().toISOString();
    
    // Réponse simple pour SIM900
    res.send('OK');
    
  } catch (error) {
    stats.failedUpdates++;
    console.error('❌ Erreur:', error.message);
    res.status(500).send('ERROR');
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS STATUS ET DONNÉES
// ═══════════════════════════════════════════════════════════════

// Status du serveur
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: Math.floor((Date.now() - stats.uptime) / 1000),
    stats: {
      totalRequests: stats.totalRequests,
      successfulUpdates: stats.successfulUpdates,
      failedUpdates: stats.failedUpdates,
      lastUpdate: stats.lastUpdate
    },
    arduinoCloud: {
      configured: ARDUINO_CONFIG.CLIENT_ID !== 'VOTRE_CLIENT_ID',
      tokenValid: accessToken && Date.now() < tokenExpiry
    },
    latestData: {
      timestamp: latestData.timestamp,
      hasGPS: latestData.lat !== 0,
      heartRate: latestData.heartRate,
      alertsActive: latestData.alerts.code > 0
    }
  });
});

// Dernières données
app.get('/api/latest', (req, res) => {
  res.json(latestData);
});

// Historique
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    count: dataHistory.length,
    data: dataHistory.slice(0, limit)
  });
});

// Envoyer commande (stockée pour l'ESP32)
let pendingCommand = '';

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }
  
  pendingCommand = command.toUpperCase();
  console.log(`📤 Commande enregistrée: ${pendingCommand}`);
  
  res.json({
    success: true,
    command: pendingCommand
  });
});

// L'ESP32 peut récupérer les commandes en attente
app.get('/api/command', (req, res) => {
  const cmd = pendingCommand;
  pendingCommand = '';  // Clear après lecture
  res.json({ command: cmd });
});

// ═══════════════════════════════════════════════════════════════
// PAGE WEB SIMPLE (Dashboard minimal)
// ═══════════════════════════════════════════════════════════════

app.get('/dashboard', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alzheimer Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 30px; color: #00d4ff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card { background: #16213e; border-radius: 15px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
    .card h2 { color: #00d4ff; margin-bottom: 15px; font-size: 1.2em; }
    .value { font-size: 2.5em; font-weight: bold; color: #fff; }
    .unit { font-size: 0.5em; color: #888; }
    .alert { background: #ff4757; animation: pulse 1s infinite; }
    .ok { background: #2ed573; }
    .status { display: inline-block; padding: 5px 15px; border-radius: 20px; margin: 5px; font-size: 0.9em; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
    #map { height: 300px; border-radius: 10px; }
    .timestamp { text-align: center; color: #666; margin-top: 20px; }
    .command-input { display: flex; gap: 10px; margin-top: 15px; }
    .command-input input { flex: 1; padding: 10px; border-radius: 8px; border: none; background: #0f3460; color: #fff; }
    .command-input button { padding: 10px 20px; border-radius: 8px; border: none; background: #00d4ff; color: #000; cursor: pointer; font-weight: bold; }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</head>
<body>
  <div class="container">
    <h1>🧠 Alzheimer Monitor</h1>
    
    <div class="grid">
      <div class="card">
        <h2>❤️ Rythme Cardiaque</h2>
        <div class="value" id="heartRate">--<span class="unit"> BPM</span></div>
      </div>
      
      <div class="card">
        <h2>🌡️ Température</h2>
        <div class="value" id="temperature">--<span class="unit"> °C</span></div>
      </div>
      
      <div class="card">
        <h2>📡 Connexion</h2>
        <div class="value" id="connection">--</div>
      </div>
      
      <div class="card">
        <h2>🛰️ GPS</h2>
        <div class="value" id="satellites">--<span class="unit"> sat</span></div>
      </div>
    </div>
    
    <div class="card" style="margin-top: 20px;">
      <h2>⚠️ Alertes</h2>
      <div id="alerts">
        <span class="status ok" id="alertFall">Chute: OK</span>
        <span class="status ok" id="alertZone">Zone: OK</span>
        <span class="status ok" id="alertBpm">BPM: OK</span>
      </div>
    </div>
    
    <div class="card" style="margin-top: 20px;">
      <h2>📍 Position</h2>
      <div id="map"></div>
      <div id="coordinates" style="margin-top: 10px; color: #888;"></div>
    </div>
    
    <div class="card" style="margin-top: 20px;">
      <h2>🎮 Commandes</h2>
      <div class="command-input">
        <input type="text" id="commandInput" placeholder="RESET, SMS, LOCATE, FALL...">
        <button onclick="sendCommand()">Envoyer</button>
      </div>
    </div>
    
    <div class="timestamp">
      Dernière mise à jour: <span id="lastUpdate">--</span>
    </div>
  </div>
  
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    // Carte
    const map = L.map('map').setView([34.0331, -5.0003], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    let marker = L.marker([34.0331, -5.0003]).addTo(map);
    
    // Mise à jour données
    async function updateData() {
      try {
        const response = await fetch('/api/latest');
        const data = await response.json();
        
        document.getElementById('heartRate').innerHTML = (data.heartRate || '--') + '<span class="unit"> BPM</span>';
        document.getElementById('temperature').innerHTML = (data.temperature?.toFixed(1) || '--') + '<span class="unit"> °C</span>';
        document.getElementById('connection').textContent = data.connectionMode?.toUpperCase() || '--';
        document.getElementById('satellites').innerHTML = (data.satellites || '--') + '<span class="unit"> sat</span>';
        
        // Alertes
        const alertFall = document.getElementById('alertFall');
        const alertZone = document.getElementById('alertZone');
        const alertBpm = document.getElementById('alertBpm');
        
        alertFall.className = 'status ' + (data.alerts?.fall ? 'alert' : 'ok');
        alertFall.textContent = 'Chute: ' + (data.alerts?.fall ? '⚠️ ALERTE' : 'OK');
        
        alertZone.className = 'status ' + (data.alerts?.zone ? 'alert' : 'ok');
        alertZone.textContent = 'Zone: ' + (data.alerts?.zone ? '⚠️ ALERTE' : 'OK');
        
        alertBpm.className = 'status ' + (data.alerts?.bpm ? 'alert' : 'ok');
        alertBpm.textContent = 'BPM: ' + (data.alerts?.bpm ? '⚠️ ALERTE' : 'OK');
        
        // Carte
        if (data.lat && data.lon && data.lat !== 0) {
          marker.setLatLng([data.lat, data.lon]);
          map.setView([data.lat, data.lon], 15);
          document.getElementById('coordinates').textContent = data.lat.toFixed(6) + ', ' + data.lon.toFixed(6);
        }
        
        document.getElementById('lastUpdate').textContent = data.timestamp ? new Date(data.timestamp).toLocaleString('fr-FR') : '--';
        
      } catch (error) {
        console.error('Erreur:', error);
      }
    }
    
    // Envoyer commande
    async function sendCommand() {
      const input = document.getElementById('commandInput');
      const command = input.value.trim();
      
      if (!command) return;
      
      try {
        await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command })
        });
        input.value = '';
        alert('Commande envoyée: ' + command);
      } catch (error) {
        alert('Erreur: ' + error.message);
      }
    }
    
    // Mise à jour auto toutes les 5 secondes
    updateData();
    setInterval(updateData, 5000);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

// ═══════════════════════════════════════════════════════════════
// DÉMARRAGE SERVEUR
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   Alzheimer Monitor - Proxy Server                    ║');
  console.log('║   Arduino IoT Cloud Bridge                            ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log('');
  console.log('📡 Endpoints:');
  console.log(`   POST http://localhost:${PORT}/api/data    - Recevoir JSON`);
  console.log(`   GET  http://localhost:${PORT}/api/data    - Recevoir query params`);
  console.log(`   GET  http://localhost:${PORT}/api/status  - Status serveur`);
  console.log(`   GET  http://localhost:${PORT}/api/latest  - Dernières données`);
  console.log(`   GET  http://localhost:${PORT}/dashboard   - Dashboard web`);
  console.log('');
  
  if (ARDUINO_CONFIG.CLIENT_ID === 'VOTRE_CLIENT_ID') {
    console.log('⚠️  Arduino Cloud non configuré!');
    console.log('   Modifiez ARDUINO_CONFIG dans server.js');
    console.log('');
  } else {
    console.log('✅ Arduino Cloud configuré');
    console.log(`   Thing ID: ${ARDUINO_CONFIG.THING_ID}`);
    console.log('');
  }
});
