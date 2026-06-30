# Feuille de route déploiement infrastructure (US10.7)

Cette page cadre l'**US10.7 — Socle d'infrastructure et de déploiement VM / Docker pour TLPE**.

> Statut actuel : **issue ouverte / requis en phase P7 — socle à implémenter avant mise en production**.

Le dépôt TLPE Manager livre aujourd'hui un socle fonctionnel complet (backend Express + frontend React) exécutable en local via `npm start` ou `npm run dev`. La présente feuille de route décrit l'infrastructure cible de production et les étapes pour industrialiser le déploiement.

## Architecture cible

### Vue d'ensemble

```ascii
┌─────────────────────────────────────────────────┐
│                   Internet                       │
└─────────────────────┬───────────────────────────┘
                      │ HTTPS (80/443)
┌─────────────────────▼───────────────────────────┐
│            Reverse Proxy (Caddy)                 │
│   - Terminaison TLS (Let's Encrypt automatique)  │
│   - Routage HTTP → application sur port 4000     │
│   - Headers sécurité (HSTS, CSP)                 │
└─────────────────────┬───────────────────────────┘
                      │ HTTP (reverse proxy → app)
┌─────────────────────▼───────────────────────────┐
│          TLPE App Container (Node.js)            │
│   - Express serveur API                          │
│   - Sert le frontend client/dist                 │
│   - Port : 4000 (interne)                        │
│   - WAL mode SQLite                              │
└─────────────────────┬───────────────────────────┘
                      │ volume mount
┌─────────────────────▼───────────────────────────┐
│           Stockage persistant (volume)           │
│   - Base SQLite : server/data/tlpe.db            │
│   - Pièces jointes : server/data/uploads/        │
│   - Reçus PDF : server/data/receipts/            │
│   - Sauvegardes : server/data/backups/           │
│   - Artefacts d'export                          │
└─────────────────────────────────────────────────┘
```

### VM hôte

- Distribution : **Debian 12** (recommandée) ou **Ubuntu 22.04 LTS**
- Ressources minimales : 2 vCPU, 4 Go RAM, 20 Go SSD
- Hyperviseur : Proxmox VE (ou équivalent KVM/VMware)
- Connexion : clé SSH uniquement, pas de mot de passe
- Pare-feu : `ufw` ou `nftables`, ports 22, 80, 443 ouverts

### Stack conteneurisée

| Composant | Image | Rôle |
|-----------|-------|------|
| `tlpe-app` | `ghcr.io/kikifunstyle/tlpe-app` (Node.js 20-slim) | Application TLPE |
| `tlpe-reverse-proxy` | `caddy:2-alpine` | Reverse proxy TLS + routage |
| Réseau | Bridge `tlpe-net` | Communication interne |

---

## Pré-requis à lever avant déploiement

### Nom de domaine et réseau

- [ ] Nom de domaine dédié (ex. `tlpe.collectivite.fr`) avec enregistrement DNS A pointant vers la VM
- [ ] Ports **80/443** ouverts dans le pare-feu et le réseau (reverse proxy nécessite Let's Encrypt)
- [ ] Sous-domaine ou domaine séparé pour la documentation VS l'application

### Secrets et variables d'environnement

| Variable | Description | Source |
|----------|-------------|--------|
| `NODE_ENV=production` | Mode production | Fixe |
| `PORT=4000` | Port d'écoute interne | Fixe |
| `TLPE_JWT_SECRET` | Clé de signature JWT (min 32 chars) | Générer |
| `TLPE_DATA_KEY` | Clé AES-256 pour chiffrement au repos | Générer |
| `TLPE_DATA_KEY_VERSION` | Version de la clé (incrémenter en rotation) | Incrémental |
| `SMTP_HOST` | Serveur SMTP transactionnel | Config |
| `SMTP_PORT` | Port SMTP | Config |
| `SMTP_USER` | Utilisateur SMTP | Config |
| `SMTP_PASS` | Mot de passe SMTP | Config |
| `SMTP_FROM` | Adresse d'envoi | Config |
| `FCM_SERVER_KEY` | Clé serveur FCM (notifications push) | Optionnel |

Toutes les variables sont externalisées via `.env.production` **jamais commité** dans le dépôt.

### Stockage persistant

Les données doivent survivre au redémarrage des conteneurs. Volumes Docker à créer :

| Volume | Chemin conteneur | Contenu |
|--------|------------------|---------|
| `tlpe-data` | `/app/server/data` | Base SQLite, uploads, reçus, sauvegardes |

### Certificats TLS

- Gérés automatiquement par Caddy via Let's Encrypt (HTTP-01 challenge)
- Renouvellement automatique
- Pas de manipulation manuelle de certificats

---

## Infrastructure Docker

### Dockerfile

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./
COPY server/package.json server/package-lock.json ./
RUN npm run install:all
COPY . .
RUN npm run build
EXPOSE 4000
VOLUME ["/app/server/data"]
CMD ["node", "server/dist/index.js"]
```

### Docker Compose

```yaml
version: "3.8"

networks:
  tlpe-net:
    driver: bridge

volumes:
  tlpe-data:

services:
  tlpe-app:
    build: .
    image: ghcr.io/kikifunstyle/tlpe-app:latest
    restart: unless-stopped
    networks:
      - tlpe-net
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - tlpe-data:/app/server/data
    env_file:
      - .env.production
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:4000/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

  tlpe-reverse-proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    networks:
      - tlpe-net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      tlpe-app:
        condition: service_healthy

volumes:
  caddy-data:
  caddy-config:
```

### Caddyfile

```caddy
tlpe.collectivite.fr {
    reverse_proxy tlpe-app:4000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    encode gzip

    log {
        output file /data/logs/access.log
    }
}
```

### .env.production.example

```bash
# App
NODE_ENV=production
PORT=4000

# Auth
TLPE_JWT_SECRET=changer_cette_cle_minimum_32_caracteres

# Chiffrement au repos
TLPE_DATA_KEY=changer_cette_cle_aes_256
TLPE_DATA_KEY_VERSION=1

# SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@collectivite.fr
SMTP_PASS=changer_le_mot_de_passe
SMTP_FROM="TLPE Manager <noreply@collectivite.fr>"
```

---

## Procédures opérationnelles

### Installation initiale

```bash
# 1. Cloner le dépôt
git clone https://github.com/KikiFUNstyle/TLPE.git /opt/tlpe
cd /opt/tlpe

# 2. Créer le fichier d'environnement
cp .env.production.example .env.production
# Éditer .env.production avec les valeurs réelles

# 3. Lancer la stack
docker compose up -d

# 4. Vérifier le démarrage
docker compose ps
docker compose logs tlpe-app
curl -s http://localhost:4000/api/health
```

### Démarrage / arrêt

```bash
# Démarrer
docker compose up -d

# Arrêter
docker compose down

# Redémarrer
docker compose restart

# Voir les logs
docker compose logs -f
```

### Mise à jour applicative

```bash
# 1. Se placer dans le répertoire du déploiement
cd /opt/tlpe

# 2. Récupérer la dernière version
git pull origin main

# 3. Reconstruire et redémarrer
docker compose build --pull tlpe-app
docker compose up -d

# 4. Vérifier
docker compose ps
curl -s http://localhost:4000/api/health
```

### Sauvegarde et restauration

**Sauvegarde :**

```bash
#!/usr/bin/env bash
# scripts/backup-production.sh
set -euo pipefail
BACKUP_DIR="/opt/backups/tlpe"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR/$DATE"
docker compose exec -T tlpe-app \
  sqlite3 /app/server/data/tlpe.db ".backup '/app/server/data/backup.tlpe.db'"
docker cp "$(docker compose ps -q tlpe-app)":/app/server/data/backup.tlpe.db \
  "$BACKUP_DIR/$DATE/tlpe.db"
docker compose exec -T tlpe-app \
  tar czf - -C /app/server/data uploads receipts \
  > "$BACKUP_DIR/$DATE/assets.tar.gz"
echo "Sauvegarde terminée : $BACKUP_DIR/$DATE"
# Rétention : garder 30 jours, supprimer les plus anciennes
find "$BACKUP_DIR" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
```

**Test de restauration :**

```bash
#!/usr/bin/env bash
# scripts/restore-test-production.sh
set -euo pipefail
BACKUP_PATH="$1"
docker compose exec -T tlpe-app \
  sqlite3 /app/server/data/tlpe.db ".restore '/app/server/data/backup.tlpe.db'"
docker cp "$BACKUP_PATH/tlpe.db" "$(docker compose ps -q tlpe-app):/app/server/data/"
tar xzf "$BACKUP_PATH/assets.tar.gz" -C /tmp/tlpe-restore-test/
echo "Restauration test effectuée depuis : $BACKUP_PATH"
```

**Script de backup existant à adapter :** les scripts `scripts/backup.sh` et `scripts/restore-test.sh` existent déjà pour le contexte local ; ils devront être adaptés au contexte Docker pour la production.

### Service systemd (auto-démarrage au boot)

```ini
# /etc/systemd/system/tlpe.service
[Unit]
Description=TLPE Manager Docker stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tlpe
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
StandardOutput=journal

[Install]
WantedBy=multi-user.target
```

```bash
# Activer le démarrage automatique
sudo systemctl daemon-reload
sudo systemctl enable tlpe.service
sudo systemctl start tlpe.service
```

---

## Observabilité et maintenance

### Healthcheck

- Endpoint : `GET /api/health`
- Réponse attendue : `200 OK` avec `{"status":"ok","uptime":...,"db":"connected"}`
- Fréquence Caddy : toutes les 30 s (intégré au healthcheck Docker)

### Logs

- Logs applicatifs : `docker compose logs tlpe-app`
- Logs reverse proxy : `docker compose logs tlpe-reverse-proxy`
- Logs système : `journalctl -u tlpe.service`
- Conservation : rotation via `logrotate` pour les logs système

### Diagnostics rapides

```bash
# État des conteneurs
docker compose ps

# État de la base
docker compose exec tlpe-app node -e "require('./server/dist/db.js')"

# Test de connexion
curl -s https://tlpe.collectivite.fr/api/health

# Utilisation disque
docker system df

# Espace disponible
df -h /opt/tlpe /opt/backups
```

---

## Séparation documentation GitHub Pages VS déploiement applicatif

La **documentation utilisateur** est publiée sur GitHub Pages via MkDocs (branche `main`, dossier `docs/` → `gh-pages`). Elle est accessible à l'adresse :
- `https://kikifunstyle.github.io/TLPE/`

L'**application TLPE Manager** est déployée sur la VM Proxmox et accessible au nom de domaine dédié :
- `https://tlpe.collectivite.fr/`

Cette séparation garantit :
- La documentation reste publique et versionnée avec le code source
- L'application est sur un nom de domaine contrôlé par la collectivité
- Pas de confusion entre documentation et instance applicative

---

## Jalons proposés

1. **Définition et validation de l'infrastructure cible**
   - Valider les choix techniques (Debian, Docker, Caddy, SQLite)
   - Valider les pré-requis réseau et DNS avec l'exploitant

2. **Conteneurisation de l'application**
   - Créer le Dockerfile et docker-compose
   - Tester le build et le démarrage en conteneur
   - Ajouter les healthchecks

3. **Déploiement guide + scripts**
   - Rédiger le guide d'exploitation complet
   - Créer les scripts de déploiement, backup, restauration
   - Configurer systemd

4. **Validation et documentation**
   - Tester l'installation complète sur VM vierge
   - Documenter le runbook d'exploitation
   - Mettre à jour la documentation utilisateur si nécessaire

---

## Définition de terminé

L'US sera considérée comme livrée lorsque les éléments suivants seront disponibles :

- [ ] Dockerfile et docker-compose.yml fonctionnels dans le dépôt
- [ ] Guide d'exploitation détaillé (installation, configuration, mise à jour, sauvegarde/restauration)
- [ ] Scripts de déploiement et de maintenance
- [ ] Configuration du reverse proxy (Caddyfile)
- [ ] Service systemd pour démarrage automatique
- [ ] Fichier `.env.production.example` documenté
- [ ] Documentation d'exploitation distincte de la documentation utilisateur
- [ ] Validation d'une installation complète sur VM vierge

## Références croisées

- `docs/installation.md` → guide d'installation locale actuel
- `docs/administrateur.md` → guide administrateur (supervision, audit)
- `scripts/backup.sh` → script de sauvegarde local existant
- `scripts/restore-test.sh` → script de test de restauration local existant
- `CLAUDE.md` → commandes locales de l'application
- `mkdocs.yml` → configuration du site de documentation GitHub Pages
- Issue GitHub : [#102 — US10.7 Socle d'infrastructure et de déploiement VM/Docker](https://github.com/KikiFUNstyle/TLPE/issues/102)

## Hors périmètre immédiat

- Haute disponibilité / multi-nœuds / cluster
- Orchestration Kubernetes / Swarm
- CI/CD complet de déploiement automatisé
- Monitoring avancé (Prometheus, Grafana, alerting)
- Sauvegarde externalisée (S3, SFTP, etc.)
