/*
 * Système Alzheimer - ESP32-S3
 * Envoi vers Serveur Proxy → Arduino IoT Cloud
 * 
 * ARCHITECTURE:
 * ESP32 ──► HTTP (simple) ──► Proxy Server ──► Arduino IoT Cloud
 * 
 * Avantages:
 * - Même code pour WiFi et GPRS
 * - Pas besoin de SSL sur SIM900
 * - Une seule plateforme (Arduino Cloud)
 * 
 * Date: Janvier 2026
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <TinyGPS++.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// ==================== CONFIGURATION WIFI ====================

const char* WIFI_SSID = "desktop";
const char* WIFI_PASSWORD = "00000000";

// ==================== CONFIGURATION PROXY SERVER ====================
// URL de votre serveur proxy (à modifier après déploiement)

// Option 1: Serveur local (test)
// const char* PROXY_URL = "http://192.168.1.100:3000/api/data";

// Option 2: Serveur Render.com (production)
const char* PROXY_URL = "http://votre-app.onrender.com/api/data";

// Option 3: Serveur Railway.app
// const char* PROXY_URL = "http://votre-app.up.railway.app/api/data";

// ==================== CONFIGURATION GPRS (SIM900) ====================

const char* GPRS_APN = "www.inwi.ma";
// const char* GPRS_APN = "internet.orange.ma";
// const char* GPRS_APN = "www.iam.net.ma";
const char* GPRS_USER = "";
const char* GPRS_PASS = "";

// Extraire host et path de PROXY_URL pour GPRS
// Exemple: "http://votre-app.onrender.com/api/data"
// Host: "votre-app.onrender.com"
// Path: "/api/data"
const char* PROXY_HOST = "votre-app.onrender.com";  // ← À modifier
const char* PROXY_PATH = "/api/data";
const int PROXY_PORT = 80;

// ==================== CONFIGURATION SMS ====================

const char* PHONE_NUMBER_1 = "+212707591033";
const char* PHONE_NUMBER_2 = "+212XXXXXXXXX";

// ==================== PINS ESP32-S3 ====================

#define GPS_RX_PIN 18
#define GPS_TX_PIN 17
#define SIM900_RX_PIN 16
#define SIM900_TX_PIN 15
#define I2C_SDA 8
#define I2C_SCL 9
#define PULSE_SENSOR_PIN 4
#define LED_STATUS 48
#define BUTTON_PIN 0

// ==================== SEUILS ====================

#define FALL_THRESHOLD 2.5
#define HEART_RATE_MIN 50
#define HEART_RATE_MAX 120
#define GEOFENCE_RADIUS 100

double HOME_LAT = 34.0331;
double HOME_LON = -5.0003;

// ==================== OBJETS ====================

TinyGPSPlus gps;
Adafruit_MPU6050 mpu;
HardwareSerial gpsSerial(1);
HardwareSerial sim900Serial(2);

// ==================== MODE CONNEXION ====================

enum ConnectionMode {
  CONN_NONE,
  CONN_WIFI,
  CONN_GPRS
};

ConnectionMode currentConnection = CONN_NONE;
bool wifiConnected = false;
bool gprsConnected = false;
bool sim900Ready = false;

// ==================== VARIABLES CAPTEURS ====================

double currentLat = 0.0;
double currentLon = 0.0;
int satellites = 0;
bool gpsValid = false;

float accelX, accelY, accelZ;
float gyroX, gyroY, gyroZ;
float temperature = 0.0;
int heartRate = 0;

bool fallDetected = false;
bool outsideGeofence = false;
bool heartRateAlert = false;

int pulseReadings[10];
int pulseIndex = 0;
unsigned long lastPulseTime = 0;

// ==================== TIMERS ====================

unsigned long lastDataSend = 0;
unsigned long lastWiFiCheck = 0;
unsigned long lastStatusPrint = 0;

const unsigned long SEND_INTERVAL = 5000;         // 5 secondes
const unsigned long WIFI_CHECK_INTERVAL = 30000;  // 30 secondes
const unsigned long STATUS_INTERVAL = 10000;      // 10 secondes

// ==================== STATS ====================

int successfulSends = 0;
int failedSends = 0;
int wifiSends = 0;
int gprsSends = 0;

// ==================== SETUP ====================

void setup() {
  Serial.begin(115200);
  
  while (!Serial && millis() < 3000) delay(10);
  delay(1000);
  
  Serial.println();
  Serial.println("╔═══════════════════════════════════════════════════════════╗");
  Serial.println("║   Alzheimer Monitor - Proxy Version                       ║");
  Serial.println("║   ESP32-S3 → Proxy Server → Arduino IoT Cloud             ║");
  Serial.println("╚═══════════════════════════════════════════════════════════╝");
  Serial.println();
  
  // Pins
  pinMode(LED_STATUS, OUTPUT);
  pinMode(PULSE_SENSOR_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  // Test LED
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_STATUS, HIGH);
    delay(200);
    digitalWrite(LED_STATUS, LOW);
    delay(200);
  }
  
  // I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  
  // Composants
  initMPU6050();
  initGPS();
  initSIM900();
  
  // Connexion
  Serial.println();
  Serial.println("═══════════════════════════════════════════════════════════");
  Serial.println("  INITIALISATION CONNEXION");
  Serial.println("═══════════════════════════════════════════════════════════");
  
  // Essayer WiFi
  Serial.println();
  Serial.println("📶 Étape 1: Tentative WiFi...");
  initWiFi();
  
  // Si pas de WiFi, essayer GPRS
  if (!wifiConnected) {
    Serial.println();
    Serial.println("📱 Étape 2: Activation GPRS...");
    initGPRS();
  }
  
  // Résumé
  Serial.println();
  Serial.println("═══════════════════════════════════════════════════════════");
  printConnectionStatus();
  Serial.println("═══════════════════════════════════════════════════════════");
  
  Serial.println();
  Serial.print("🎯 Proxy URL: ");
  Serial.println(PROXY_URL);
  Serial.println();
  Serial.println("✓ Système prêt!");
  Serial.println("  Tapez 'help' pour les commandes");
  Serial.println();
}

// ==================== LOOP ====================

void loop() {
  // Vérifier connexion WiFi
  if (currentConnection == CONN_WIFI && WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ WiFi perdu!");
    wifiConnected = false;
    currentConnection = CONN_NONE;
    initGPRS();
  }
  
  // Vérifier WiFi périodiquement si en GPRS
  if (currentConnection == CONN_GPRS && millis() - lastWiFiCheck >= WIFI_CHECK_INTERVAL) {
    checkWiFiAvailability();
    lastWiFiCheck = millis();
  }
  
  // Lecture capteurs
  readGPS();
  readMPU6050();
  readHeartRate();
  
  // Vérification alertes
  checkFallDetection();
  checkGeofence();
  checkHeartRate();
  checkButton();
  
  // Envoi données vers proxy
  if (millis() - lastDataSend >= SEND_INTERVAL) {
    sendDataToProxy();
    lastDataSend = millis();
  }
  
  // Gestion alertes
  handleAlerts();
  
  // Status périodique
  if (millis() - lastStatusPrint >= STATUS_INTERVAL) {
    printStatus();
    lastStatusPrint = millis();
  }
  
  // Commandes série
  processSerialCommands();
  
  delay(50);
}

// ==================== ENVOI DONNÉES VERS PROXY ====================

void sendDataToProxy() {
  if (currentConnection == CONN_WIFI) {
    sendViaWiFi();
  } else if (currentConnection == CONN_GPRS) {
    sendViaGPRS();
  } else {
    Serial.println("⚠️ Pas de connexion - Tentative...");
    initGPRS();
    if (gprsConnected) {
      sendViaGPRS();
    } else {
      failedSends++;
    }
  }
}

void sendViaWiFi() {
  Serial.print("📶 Envoi WiFi → Proxy... ");
  
  // Construire JSON
  String jsonData = buildJsonData();
  
  HTTPClient http;
  http.begin(PROXY_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);
  
  int httpCode = http.POST(jsonData);
  
  if (httpCode > 0) {
    String response = http.getString();
    
    if (httpCode == 200) {
      successfulSends++;
      wifiSends++;
      Serial.println("✓ OK");
    } else {
      failedSends++;
      Serial.print("✗ Code: ");
      Serial.println(httpCode);
    }
  } else {
    failedSends++;
    Serial.print("✗ Erreur: ");
    Serial.println(http.errorToString(httpCode));
  }
  
  http.end();
}

void sendViaGPRS() {
  Serial.print("📱 Envoi GPRS → Proxy... ");
  
  // Construire les paramètres GET (plus simple que POST avec SIM900)
  String params = buildQueryParams();
  
  // Fermer connexion précédente
  sendATCommand("AT+CIPCLOSE", "OK", 2000);
  delay(500);
  
  // Ouvrir connexion TCP
  String connectCmd = "AT+CIPSTART=\"TCP\",\"" + String(PROXY_HOST) + "\",\"" + String(PROXY_PORT) + "\"";
  sim900Serial.println(connectCmd);
  
  if (!waitForResponse("CONNECT OK", 15000)) {
    Serial.println("✗ TCP échoué");
    failedSends++;
    checkGPRSConnection();
    return;
  }
  
  delay(500);
  
  // Construire requête HTTP GET
  String httpRequest = "GET " + String(PROXY_PATH) + "?" + params + " HTTP/1.1\r\n";
  httpRequest += "Host: " + String(PROXY_HOST) + "\r\n";
  httpRequest += "Connection: close\r\n\r\n";
  
  // Envoyer taille
  sim900Serial.println("AT+CIPSEND=" + String(httpRequest.length()));
  
  if (!waitForResponse(">", 5000)) {
    Serial.println("✗ CIPSEND échoué");
    failedSends++;
    return;
  }
  
  // Envoyer requête
  sim900Serial.print(httpRequest);
  
  if (waitForResponse("SEND OK", 10000)) {
    // Attendre réponse
    delay(2000);
    
    // Lire réponse
    String response = "";
    while (sim900Serial.available()) {
      response += (char)sim900Serial.read();
    }
    
    if (response.indexOf("OK") != -1 || response.indexOf("200") != -1) {
      successfulSends++;
      gprsSends++;
      Serial.println("✓ OK");
    } else {
      failedSends++;
      Serial.println("✗ Réponse invalide");
    }
  } else {
    failedSends++;
    Serial.println("✗ Timeout");
  }
  
  sendATCommand("AT+CIPCLOSE", "OK", 2000);
}

// ==================== CONSTRUCTION DONNÉES ====================

String buildJsonData() {
  float accelMag = sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);
  int alertCode = (fallDetected ? 1 : 0) + (outsideGeofence ? 2 : 0) + (heartRateAlert ? 4 : 0);
  
  String json = "{";
  json += "\"lat\":" + String(currentLat, 6);
  json += ",\"lon\":" + String(currentLon, 6);
  json += ",\"hr\":" + String(heartRate);
  json += ",\"temp\":" + String(temperature, 1);
  json += ",\"ax\":" + String(accelX, 2);
  json += ",\"ay\":" + String(accelY, 2);
  json += ",\"az\":" + String(accelZ, 2);
  json += ",\"mag\":" + String(accelMag, 2);
  json += ",\"sat\":" + String(satellites);
  json += ",\"gps\":" + String(gpsValid ? "true" : "false");
  json += ",\"fall\":" + String(fallDetected ? "true" : "false");
  json += ",\"zone\":" + String(outsideGeofence ? "true" : "false");
  json += ",\"bpm\":" + String(heartRateAlert ? "true" : "false");
  json += ",\"code\":" + String(alertCode);
  json += ",\"mode\":\"" + String(currentConnection == CONN_WIFI ? "wifi" : "gprs") + "\"";
  json += ",\"rssi\":" + String(currentConnection == CONN_WIFI ? WiFi.RSSI() : 0);
  json += "}";
  
  return json;
}

String buildQueryParams() {
  float accelMag = sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);
  int alertCode = (fallDetected ? 1 : 0) + (outsideGeofence ? 2 : 0) + (heartRateAlert ? 4 : 0);
  
  String params = "";
  params += "lat=" + String(currentLat, 6);
  params += "&lon=" + String(currentLon, 6);
  params += "&hr=" + String(heartRate);
  params += "&temp=" + String(temperature, 1);
  params += "&ax=" + String(accelX, 2);
  params += "&ay=" + String(accelY, 2);
  params += "&az=" + String(accelZ, 2);
  params += "&mag=" + String(accelMag, 2);
  params += "&sat=" + String(satellites);
  params += "&gps=" + String(gpsValid ? "true" : "false");
  params += "&fall=" + String(fallDetected ? "true" : "false");
  params += "&zone=" + String(outsideGeofence ? "true" : "false");
  params += "&bpm=" + String(heartRateAlert ? "true" : "false");
  params += "&code=" + String(alertCode);
  params += "&mode=gprs";
  
  return params;
}

// ==================== INITIALISATION WIFI ====================

void initWiFi() {
  Serial.print("  Connexion WiFi '" + String(WIFI_SSID) + "'");
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    currentConnection = CONN_WIFI;
    Serial.println(" ✓");
    Serial.print("  IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("  RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    wifiConnected = false;
    Serial.println(" ✗");
  }
}

void checkWiFiAvailability() {
  Serial.println("🔍 Vérification WiFi...");
  
  int n = WiFi.scanNetworks(false, false, false, 300);
  
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == WIFI_SSID) {
      Serial.println("📶 WiFi détecté! Reconnexion...");
      
      if (gprsConnected) {
        disconnectGPRS();
      }
      
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      
      int attempts = 0;
      while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        attempts++;
      }
      
      if (WiFi.status() == WL_CONNECTED) {
        wifiConnected = true;
        currentConnection = CONN_WIFI;
        Serial.println("✓ Basculé sur WiFi!");
      }
      break;
    }
  }
  
  WiFi.scanDelete();
}

// ==================== INITIALISATION SIM900 ====================

void initSIM900() {
  Serial.print("SIM900... ");
  sim900Serial.begin(9600, SERIAL_8N1, SIM900_RX_PIN, SIM900_TX_PIN);
  delay(1000);
  
  if (!sendATCommand("AT", "OK", 2000)) {
    Serial.println("✗");
    return;
  }
  
  sendATCommand("ATE0", "OK", 1000);
  
  if (!sendATCommand("AT+CPIN?", "READY", 2000)) {
    Serial.println("✗ SIM");
    return;
  }
  
  delay(2000);
  if (!sendATCommand("AT+CREG?", "0,1", 5000) && !sendATCommand("AT+CREG?", "0,5", 5000)) {
    Serial.println("✗ Réseau");
    return;
  }
  
  sendATCommand("AT+CMGF=1", "OK", 1000);
  
  sim900Ready = true;
  Serial.println("✓");
  
  // Opérateur
  sim900Serial.println("AT+COPS?");
  delay(1000);
  if (sim900Serial.available()) {
    String resp = sim900Serial.readString();
    int start = resp.indexOf("\"");
    int end = resp.lastIndexOf("\"");
    if (start > 0 && end > start) {
      Serial.print("  Opérateur: ");
      Serial.println(resp.substring(start + 1, end));
    }
  }
}

// ==================== INITIALISATION GPRS ====================

void initGPRS() {
  if (!sim900Ready) {
    Serial.println("  ✗ SIM900 non prêt");
    return;
  }
  
  Serial.println("  Configuration GPRS...");
  
  sendATCommand("AT+CIPSHUT", "SHUT OK", 3000);
  delay(1000);
  
  if (!sendATCommand("AT+CIPMUX=0", "OK", 2000)) {
    Serial.println("  ✗ CIPMUX");
    return;
  }
  
  String apnCmd = "AT+CSTT=\"" + String(GPRS_APN) + "\",\"" + String(GPRS_USER) + "\",\"" + String(GPRS_PASS) + "\"";
  if (!sendATCommand(apnCmd.c_str(), "OK", 3000)) {
    Serial.println("  ✗ APN");
    return;
  }
  Serial.print("  APN: ");
  Serial.println(GPRS_APN);
  
  Serial.print("  Connexion GPRS");
  if (!sendATCommand("AT+CIICR", "OK", 30000)) {
    Serial.println(" ✗");
    return;
  }
  Serial.println(" ✓");
  
  delay(2000);
  sim900Serial.println("AT+CIFSR");
  delay(2000);
  
  String ip = "";
  while (sim900Serial.available()) {
    char c = sim900Serial.read();
    if ((c >= '0' && c <= '9') || c == '.') {
      ip += c;
    }
  }
  
  if (ip.length() > 6) {
    gprsConnected = true;
    currentConnection = CONN_GPRS;
    Serial.print("  IP: ");
    Serial.println(ip);
    Serial.println("  ✓ GPRS connecté!");
  } else {
    Serial.println("  ✗ Pas d'IP");
  }
}

void disconnectGPRS() {
  sendATCommand("AT+CIPSHUT", "SHUT OK", 3000);
  gprsConnected = false;
}

void checkGPRSConnection() {
  if (!sendATCommand("AT+CIPSTATUS", "OK", 2000)) {
    gprsConnected = false;
    currentConnection = CONN_NONE;
    Serial.println("⚠️ GPRS déconnecté - Reconnexion...");
    initGPRS();
  }
}

// ==================== COMMANDES AT ====================

bool sendATCommand(const char* cmd, const char* expected, unsigned long timeout) {
  while (sim900Serial.available()) sim900Serial.read();
  sim900Serial.println(cmd);
  return waitForResponse(expected, timeout);
}

bool waitForResponse(const char* expected, unsigned long timeout) {
  String response = "";
  unsigned long start = millis();
  
  while (millis() - start < timeout) {
    if (sim900Serial.available()) {
      char c = sim900Serial.read();
      response += c;
      if (response.indexOf(expected) != -1) return true;
      if (response.indexOf("ERROR") != -1) return false;
    }
  }
  return false;
}

// ==================== INITIALISATIONS CAPTEURS ====================

void initMPU6050() {
  Serial.print("MPU6050... ");
  if (!mpu.begin()) {
    Serial.println("✗");
    return;
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.println("✓");
}

void initGPS() {
  Serial.print("GPS... ");
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("✓");
}

// ==================== LECTURE CAPTEURS ====================

void readGPS() {
  while (gpsSerial.available() > 0) {
    if (gps.encode(gpsSerial.read())) {
      if (gps.location.isValid()) {
        currentLat = gps.location.lat();
        currentLon = gps.location.lng();
        gpsValid = true;
      }
      satellites = gps.satellites.value();
    }
  }
}

void readMPU6050() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  accelX = a.acceleration.x / 9.81;
  accelY = a.acceleration.y / 9.81;
  accelZ = a.acceleration.z / 9.81;
  gyroX = g.gyro.x;
  gyroY = g.gyro.y;
  gyroZ = g.gyro.z;
  temperature = temp.temperature;
}

void readHeartRate() {
  int rawValue = analogRead(PULSE_SENSOR_PIN);
  pulseReadings[pulseIndex] = rawValue;
  pulseIndex = (pulseIndex + 1) % 10;
  
  int avg = 0;
  for (int i = 0; i < 10; i++) avg += pulseReadings[i];
  avg /= 10;
  
  static int lastAvg = 0;
  static bool isPeak = false;
  
  if (avg > lastAvg + 50 && !isPeak) {
    isPeak = true;
    unsigned long now = millis();
    if (lastPulseTime > 0) {
      unsigned long interval = now - lastPulseTime;
      if (interval > 300 && interval < 2000) {
        heartRate = 60000 / interval;
      }
    }
    lastPulseTime = now;
  } else if (avg < lastAvg - 30) {
    isPeak = false;
  }
  lastAvg = avg;
}

// ==================== DÉTECTION ALERTES ====================

void checkFallDetection() {
  float totalAccel = sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);
  if (totalAccel > FALL_THRESHOLD && !fallDetected) {
    fallDetected = true;
    Serial.println("⚠️ CHUTE DÉTECTÉE!");
  }
}

void checkGeofence() {
  if (!gpsValid) return;
  double distance = calculateDistance(currentLat, currentLon, HOME_LAT, HOME_LON);
  if (distance > GEOFENCE_RADIUS && !outsideGeofence) {
    outsideGeofence = true;
    Serial.print("⚠️ SORTIE ZONE! ");
    Serial.print(distance);
    Serial.println("m");
  } else if (distance <= GEOFENCE_RADIUS) {
    outsideGeofence = false;
  }
}

double calculateDistance(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371000;
  double dLat = (lat2 - lat1) * PI / 180;
  double dLon = (lon2 - lon1) * PI / 180;
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(lat1 * PI / 180) * cos(lat2 * PI / 180) *
             sin(dLon / 2) * sin(dLon / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return R * c;
}

void checkHeartRate() {
  if (heartRate > 0) {
    if ((heartRate < HEART_RATE_MIN || heartRate > HEART_RATE_MAX) && !heartRateAlert) {
      heartRateAlert = true;
      Serial.print("⚠️ BPM ANORMAL: ");
      Serial.println(heartRate);
    } else if (heartRate >= HEART_RATE_MIN && heartRate <= HEART_RATE_MAX) {
      heartRateAlert = false;
    }
  }
}

void checkButton() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50);
    if (digitalRead(BUTTON_PIN) == LOW) {
      fallDetected = false;
      outsideGeofence = false;
      heartRateAlert = false;
      Serial.println("✓ Alertes reset (bouton)");
      while (digitalRead(BUTTON_PIN) == LOW) delay(10);
    }
  }
}

// ==================== GESTION ALERTES ====================

void handleAlerts() {
  static bool smsSent = false;
  
  if (fallDetected || outsideGeofence || heartRateAlert) {
    if (!smsSent && sim900Ready) {
      sendSMSAlert();
      smsSent = true;
    }
    digitalWrite(LED_STATUS, (millis() / 100) % 2);
  } else {
    smsSent = false;
    digitalWrite(LED_STATUS, HIGH);
  }
  
  // Auto-reset chute
  static unsigned long fallTime = 0;
  if (fallDetected && fallTime == 0) fallTime = millis();
  if (fallDetected && millis() - fallTime > 30000) {
    fallDetected = false;
    fallTime = 0;
  }
}

void sendSMSAlert() {
  Serial.println("📱 SMS alerte...");
  
  String msg = "ALERTE ALZHEIMER!\n";
  msg += "Mode: " + String(currentConnection == CONN_WIFI ? "WiFi" : "GPRS") + "\n";
  if (fallDetected) msg += "- CHUTE!\n";
  if (outsideGeofence) msg += "- SORTIE ZONE!\n";
  if (heartRateAlert) msg += "- BPM: " + String(heartRate) + "\n";
  if (gpsValid) {
    msg += "maps.google.com/?q=" + String(currentLat, 6) + "," + String(currentLon, 6);
  }
  
  sendSMS(PHONE_NUMBER_1, msg);
  delay(3000);
  sendSMS(PHONE_NUMBER_2, msg);
}

void sendSMS(const char* number, String message) {
  sim900Serial.println("AT+CMGF=1");
  delay(500);
  sim900Serial.print("AT+CMGS=\"");
  sim900Serial.print(number);
  sim900Serial.println("\"");
  delay(500);
  sim900Serial.print(message);
  sim900Serial.write(26);
  delay(5000);
  Serial.print("  SMS → ");
  Serial.println(number);
}

// ==================== AFFICHAGE ====================

void printStatus() {
  Serial.println();
  Serial.println("╔════════════════════════ STATUS ════════════════════════╗");
  
  Serial.print("║ Mode: ");
  switch (currentConnection) {
    case CONN_WIFI:
      Serial.print("📶 WiFi (");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm)");
      break;
    case CONN_GPRS:
      Serial.println("📱 GPRS");
      break;
    default:
      Serial.println("❌ Aucune connexion");
  }
  
  Serial.print("║ GPS: ");
  if (gpsValid) {
    Serial.print(currentLat, 6);
    Serial.print(", ");
    Serial.print(currentLon, 6);
    Serial.print(" (");
    Serial.print(satellites);
    Serial.println(" sat)");
  } else {
    Serial.println("Recherche...");
  }
  
  Serial.print("║ BPM: ");
  Serial.print(heartRate);
  Serial.print(" | Temp: ");
  Serial.print(temperature, 1);
  Serial.println("°C");
  
  Serial.print("║ Alertes: ");
  if (!fallDetected && !outsideGeofence && !heartRateAlert) {
    Serial.println("Aucune ✓");
  } else {
    if (fallDetected) Serial.print("CHUTE ");
    if (outsideGeofence) Serial.print("ZONE ");
    if (heartRateAlert) Serial.print("BPM ");
    Serial.println("⚠️");
  }
  
  Serial.print("║ Stats: ");
  Serial.print(successfulSends);
  Serial.print(" OK (W:");
  Serial.print(wifiSends);
  Serial.print(" G:");
  Serial.print(gprsSends);
  Serial.print(") | ");
  Serial.print(failedSends);
  Serial.println(" échecs");
  
  Serial.println("╚══════════════════════════════════════════════════════════╝");
}

void printConnectionStatus() {
  Serial.println("  STATUS:");
  Serial.print("  • WiFi: ");
  Serial.println(wifiConnected ? "✓" : "✗");
  Serial.print("  • GPRS: ");
  Serial.println(gprsConnected ? "✓" : (sim900Ready ? "○ Dispo" : "✗"));
  Serial.print("  • Mode: ");
  switch (currentConnection) {
    case CONN_WIFI: Serial.println("WiFi"); break;
    case CONN_GPRS: Serial.println("GPRS"); break;
    default: Serial.println("Aucun");
  }
}

// ==================== COMMANDES SÉRIE ====================

void processSerialCommands() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.toLowerCase();
    
    if (cmd == "help" || cmd == "?") {
      Serial.println("\n═══════════ COMMANDES ═══════════");
      Serial.println("status - État complet");
      Serial.println("send   - Forcer envoi");
      Serial.println("wifi   - Forcer WiFi");
      Serial.println("gprs   - Forcer GPRS");
      Serial.println("reset  - Reset alertes");
      Serial.println("fall   - Simuler chute");
      Serial.println("sms    - SMS test");
      Serial.println("gps    - Position GPS");
      Serial.println("scan   - Scanner WiFi");
      Serial.println("AT...  - Commande AT");
      Serial.println("═════════════════════════════════");
    }
    else if (cmd == "status" || cmd == "s") printStatus();
    else if (cmd == "send") {
      sendDataToProxy();
      lastDataSend = millis();
    }
    else if (cmd == "wifi") {
      if (gprsConnected) disconnectGPRS();
      initWiFi();
    }
    else if (cmd == "gprs") {
      if (wifiConnected) {
        WiFi.disconnect();
        wifiConnected = false;
        currentConnection = CONN_NONE;
      }
      initGPRS();
    }
    else if (cmd == "reset") {
      fallDetected = false;
      outsideGeofence = false;
      heartRateAlert = false;
      Serial.println("✓ Reset OK");
    }
    else if (cmd == "fall") {
      fallDetected = true;
      Serial.println("⚠️ Chute simulée!");
    }
    else if (cmd == "sms") {
      if (sim900Ready) sendSMS(PHONE_NUMBER_1, "Test Proxy ESP32-S3");
    }
    else if (cmd == "gps") {
      if (gpsValid) {
        Serial.println(String(currentLat, 6) + "," + String(currentLon, 6));
        Serial.println("maps.google.com/?q=" + String(currentLat, 6) + "," + String(currentLon, 6));
      } else Serial.println("GPS non dispo");
    }
    else if (cmd == "scan") {
      Serial.println("Scan WiFi...");
      int n = WiFi.scanNetworks();
      for (int i = 0; i < n; i++) {
        Serial.print("  ");
        Serial.print(WiFi.SSID(i));
        Serial.print(" (");
        Serial.print(WiFi.RSSI(i));
        Serial.println(")");
      }
    }
    else if (cmd.startsWith("at")) {
      cmd.toUpperCase();
      sim900Serial.println(cmd);
      delay(1000);
      while (sim900Serial.available()) Serial.write(sim900Serial.read());
      Serial.println();
    }
  }
}
