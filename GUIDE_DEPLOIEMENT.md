# Guide Complet - Serveur Proxy Arduino IoT Cloud

## 📋 Table des Matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Prérequis](#2-prérequis)
3. [Obtenir les Credentials Arduino Cloud](#3-obtenir-les-credentials-arduino-cloud)
4. [Configurer le Serveur Proxy](#4-configurer-le-serveur-proxy)
5. [Déployer sur Render.com (Gratuit)](#5-déployer-sur-rendercom-gratuit)
6. [Alternative: Railway.app](#6-alternative-railwayapp)
7. [Configurer l'ESP32-S3](#7-configurer-lesp32-s3)
8. [Test du Système](#8-test-du-système)
9. [Dashboard Web Intégré](#9-dashboard-web-intégré)
10. [Dépannage](#10-dépannage)

---

## 1. Vue d'ensemble

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐   │
│  │              │  HTTP   │              │  HTTPS  │              │   │
│  │   ESP32-S3   │────────►│    Proxy     │────────►│   Arduino    │   │
│  │   + SIM900   │  Simple │   (Node.js)  │  + API  │  IoT Cloud   │   │
│  │              │         │              │         │              │   │
│  └──────────────┘         └──────────────┘         └──────────────┘   │
│        │                         │                        │           │
│        │                         │                        │           │
│   WiFi ou GPRS              Render.com               Dashboard +      │
│   (pas de SSL)               (gratuit)              App Mobile        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Avantages
- ✅ Une seule plateforme (Arduino IoT Cloud)
- ✅ SIM900 compatible (pas besoin de SSL)
- ✅ WiFi + GPRS même code
- ✅ Hébergement gratuit (Render.com)
- ✅ Dashboard web bonus inclus

---

## 2. Prérequis

### Matériel
- ESP32-S3 avec les capteurs (déjà configuré)
- SIM900 avec carte SIM active
- Connexion Internet

### Comptes (gratuits)
- [Arduino Cloud](https://create.arduino.cc) - Déjà créé
- [GitHub](https://github.com) - Pour le déploiement
- [Render.com](https://render.com) - Hébergement gratuit

### Logiciels
- Node.js 16+ (pour test local)
- Git
- Arduino IDE

---

## 3. Obtenir les Credentials Arduino Cloud

### Étape 3.1: Créer une API Key

1. Allez sur https://cloud.arduino.cc
2. Cliquez sur votre profil (en haut à droite)
3. **API Keys** → **Create API Key**
4. Nom: `alzheimer-proxy`
5. **Notez:**
   - **Client ID**: `xxxxxxxxxxxxxxxxxxxxxx`
   - **Client Secret**: `xxxxxxxxxxxxxxxxxxxxxx`

> ⚠️ Le Client Secret n'est affiché qu'une fois! Copiez-le immédiatement!

### Étape 3.2: Récupérer le Thing ID

1. Allez dans **Things**
2. Cliquez sur votre Thing `Surveillance_Alzheimer`
3. Regardez l'URL: `https://cloud.arduino.cc/iot/things/XXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`
4. Le Thing ID est la partie après `/things/`

### Étape 3.3: Récupérer les Variable IDs

1. Dans votre Thing, cliquez sur chaque variable
2. Dans l'URL ou les paramètres, trouvez l'ID de chaque variable:
   - `location`
   - `heartRate`
   - `cloud_sensors`
   - `cloud_alerts`
   - `cloud_command`

**Alternative plus simple:** Utilisez l'API pour lister les variables:
```bash
# Après avoir obtenu un token, listez les propriétés:
curl -X GET "https://api2.arduino.cc/iot/v2/things/VOTRE_THING_ID/properties" \
  -H "Authorization: Bearer VOTRE_TOKEN"
```

---

## 4. Configurer le Serveur Proxy

### Étape 4.1: Modifier server.js

Ouvrez `server.js` et modifiez la section `ARDUINO_CONFIG`:

```javascript
const ARDUINO_CONFIG = {
  // Vos credentials API
  CLIENT_ID: 'votre_client_id_ici',
  CLIENT_SECRET: 'votre_client_secret_ici',
  
  // ID de votre Thing
  THING_ID: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  
  // IDs des variables (à récupérer depuis Arduino Cloud)
  VARIABLES: {
    location: 'id-variable-location',
    heartRate: 'id-variable-heartrate',
    cloud_sensors: 'id-variable-sensors',
    cloud_alerts: 'id-variable-alerts',
    cloud_command: 'id-variable-command'
  },
  
  AUTH_URL: 'https://api2.arduino.cc/iot/v1/clients/token',
  API_BASE: 'https://api2.arduino.cc/iot/v2'
};
```

### Étape 4.2: Test Local (Optionnel)

```bash
# Installer les dépendances
cd proxy_arduino_cloud
npm install

# Lancer le serveur
npm start

# Tester
curl http://localhost:3000/api/status
```

---

## 5. Déployer sur Render.com (Gratuit)

### Étape 5.1: Créer un Repository GitHub

1. Allez sur https://github.com/new
2. Nom: `alzheimer-proxy`
3. **Create repository**

### Étape 5.2: Upload les fichiers

```bash
# Dans le dossier proxy_arduino_cloud
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/VOTRE_USERNAME/alzheimer-proxy.git
git push -u origin main
```

Ou uploadez manuellement:
1. Sur GitHub, cliquez **Add file** → **Upload files**
2. Glissez `server.js` et `package.json`
3. **Commit changes**

### Étape 5.3: Déployer sur Render

1. Allez sur https://render.com
2. **Sign up** avec GitHub
3. **New** → **Web Service**
4. Connectez votre repository `alzheimer-proxy`
5. Configuration:
   - **Name**: `alzheimer-proxy`
   - **Region**: Frankfurt (ou le plus proche)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**

6. **Environment Variables** (cliquez "Advanced"):
   ```
   NODE_ENV = production
   ```

7. **Create Web Service**

### Étape 5.4: Récupérer l'URL

Après déploiement (2-3 minutes):
- Votre URL sera: `https://alzheimer-proxy.onrender.com`

> ⚠️ Sur le plan gratuit Render, le serveur s'endort après 15min d'inactivité. 
> Le premier appel prendra ~30 secondes pour le réveiller.

---

## 6. Alternative: Railway.app

Si vous préférez Railway (également gratuit):

1. Allez sur https://railway.app
2. **Start a New Project** → **Deploy from GitHub repo**
3. Sélectionnez `alzheimer-proxy`
4. Railway détecte automatiquement Node.js
5. Cliquez **Deploy**
6. Dans **Settings** → **Domains** → **Generate Domain**
7. Votre URL: `https://alzheimer-proxy.up.railway.app`

---

## 7. Configurer l'ESP32-S3

### Étape 7.1: Modifier l'URL du Proxy

Dans `esp32_proxy_client.ino`, modifiez:

```cpp
// URL de votre serveur proxy déployé
const char* PROXY_URL = "http://alzheimer-proxy.onrender.com/api/data";

// Pour GPRS, séparez host et path:
const char* PROXY_HOST = "alzheimer-proxy.onrender.com";
const char* PROXY_PATH = "/api/data";
const int PROXY_PORT = 80;
```

> ⚠️ Utilisez `http://` (pas https) car le SIM900 ne supporte pas SSL!
> Le proxy Render accepte HTTP et HTTPS.

### Étape 7.2: Configurer WiFi

```cpp
const char* WIFI_SSID = "desktop";      // Votre WiFi
const char* WIFI_PASSWORD = "00000000"; // Votre mot de passe
```

### Étape 7.3: Upload

1. Ouvrez `esp32_proxy_client.ino`
2. Sélectionnez **ESP32S3 Dev Module**
3. Upload

---

## 8. Test du Système

### Test 1: Vérifier le Proxy

```bash
# Status du serveur
curl https://alzheimer-proxy.onrender.com/api/status

# Envoyer des données test
curl -X POST https://alzheimer-proxy.onrender.com/api/data \
  -H "Content-Type: application/json" \
  -d '{"lat":34.0331,"lon":-5.0003,"hr":72,"temp":25.5,"code":0}'
```

### Test 2: Vérifier Arduino Cloud

1. Allez sur https://cloud.arduino.cc
2. Ouvrez votre Thing
3. Les variables doivent se mettre à jour!

### Test 3: Via ESP32

1. Ouvrez Serial Monitor (115200)
2. Vous devriez voir:
```
📶 Envoi WiFi → Proxy... ✓ OK
```
ou
```
📱 Envoi GPRS → Proxy... ✓ OK
```

---

## 9. Dashboard Web Intégré

Le proxy inclut un dashboard web simple:

**URL**: `https://alzheimer-proxy.onrender.com/dashboard`

### Fonctionnalités:
- Carte GPS en temps réel
- Affichage BPM et température
- État des alertes
- Envoi de commandes
- Mise à jour auto toutes les 5 secondes

---

## 10. Dépannage

### Le proxy ne répond pas

```bash
# Vérifier si le serveur est actif
curl https://alzheimer-proxy.onrender.com/

# Si erreur 502/503, le serveur dort
# Attendez 30 secondes et réessayez
```

### Arduino Cloud ne se met pas à jour

1. Vérifiez les logs Render:
   - Render Dashboard → votre service → **Logs**

2. Vérifiez les credentials:
   ```bash
   curl https://alzheimer-proxy.onrender.com/api/status
   ```
   Regardez `arduinoCloud.configured` et `tokenValid`

3. Erreur "401 Unauthorized":
   - Vérifiez CLIENT_ID et CLIENT_SECRET
   - Recréez une API Key si nécessaire

### ESP32 ne peut pas se connecter

1. **WiFi**: Vérifiez SSID et password
2. **GPRS**: 
   ```
   # Dans Serial Monitor:
   AT+CREG?    # Doit répondre 0,1 ou 0,5
   AT+CSQ      # Signal (>10 = OK)
   ```

3. **Proxy**: Testez l'URL manuellement depuis un navigateur

### GPRS timeout

Le plan gratuit Render peut être lent. Options:
1. Augmenter le timeout dans le code ESP32
2. Passer à un plan payant (~7$/mois)
3. Utiliser Railway (parfois plus rapide)

---

## 📊 Résumé des URLs

| Service | URL |
|---------|-----|
| Proxy API | `https://alzheimer-proxy.onrender.com/api/data` |
| Status | `https://alzheimer-proxy.onrender.com/api/status` |
| Dashboard | `https://alzheimer-proxy.onrender.com/dashboard` |
| Arduino Cloud | `https://cloud.arduino.cc` |

---

## ✅ Checklist Finale

- [ ] API Key Arduino Cloud créée
- [ ] Thing ID et Variable IDs notés
- [ ] server.js configuré avec credentials
- [ ] Repository GitHub créé
- [ ] Déployé sur Render.com
- [ ] URL du proxy notée
- [ ] ESP32 configuré avec URL proxy
- [ ] Test envoi données OK
- [ ] Arduino Cloud se met à jour
- [ ] Dashboard web fonctionne

**Félicitations! Votre système utilise maintenant une seule plateforme (Arduino IoT Cloud) avec WiFi + GPRS! 🎉**
