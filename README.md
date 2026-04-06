# NearMe 📍

> Real-time people discovery app — find people with shared interests around you using live location on an interactive Leaflet map.

---

## Features

- **Google OAuth Login** — sign in with Gmail, zero password hassle
- **Live Location Map** — Leaflet dark map with real-time user markers
- **Interest Profiles** — tag your interests, find people with similar ones
- **Real-time Presence** — Socket.IO shows who's online right now
- **Adjustable Radius** — search from 500m to 50km
- **Visibility Toggle** — go invisible anytime
- **Mobile-First** — fully responsive with flex/viewport units

---

## Quick Start (Local)

### 1. Clone & install

```bash
git clone <your-repo>
cd nearme
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values (see below)
```

### 3. Set up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Google+ API** and **Google Identity**
4. Go to **Credentials → Create OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback` (development)
   - `https://your-app.koyeb.app/auth/google/callback` (production)
7. Copy `Client ID` and `Client Secret` into `.env`

### 4. Run

```bash
npm start
# or for development with hot reload:
npx nodemon server.js
```

Visit: http://localhost:3000

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | `production` or `development` |
| `SESSION_SECRET` | Long random string for session encryption |
| `MONGODB_URI` | Full MongoDB connection string |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_CALLBACK_URL` | Full URL: `https://your-domain/auth/google/callback` |
| `APP_URL` | Your app's public URL |

---

## Deploy to Koyeb

### Method 1: Docker (Recommended)

1. **Push to GitHub** (make sure `.env` is in `.gitignore`!)

2. **Create Koyeb account** at [koyeb.com](https://koyeb.com)

3. **New Service → GitHub**
   - Select your repo
   - Build method: **Dockerfile** (auto-detected)
   - Port: `3000`

4. **Add Environment Variables** in Koyeb dashboard:
   ```
   NODE_ENV=production
   PORT=3000
   MONGODB_URI=mongodb+srv://farmManagement:farmManagement@farmmanagement.frzmzu8.mongodb.net/nearme?appName=farmManagement
   SESSION_SECRET=<generate a long random string>
   GOOGLE_CLIENT_ID=<your google client id>
   GOOGLE_CLIENT_SECRET=<your google client secret>
   GOOGLE_CALLBACK_URL=https://<your-koyeb-subdomain>.koyeb.app/auth/google/callback
   APP_URL=https://<your-koyeb-subdomain>.koyeb.app
   ```

5. **Deploy!** Koyeb will build the Docker image and deploy automatically.

6. **Update Google OAuth** — go back to Google Cloud Console and add your Koyeb URL to the authorized redirect URIs.

### Method 2: Docker CLI locally first

```bash
# Build
docker build -t nearme .

# Run locally
docker run -p 3000:3000 --env-file .env nearme

# Or with docker-compose
docker-compose up
```

---

## Architecture

```
nearme/
├── server.js           # Express + Socket.IO + Passport setup
├── models/
│   └── User.js         # MongoDB user schema with geo index
├── routes/
│   ├── auth.js         # Google OAuth routes
│   └── users.js        # Profile & nearby user API
├── public/
│   ├── index.html      # Landing page
│   ├── onboarding.html # Profile setup (new users)
│   └── app.html        # Main map app
├── Dockerfile
├── docker-compose.yml
└── package.json
```

### Real-time Flow

```
User opens app → Geolocation API → PUT /api/users/location
                                  → socket.emit('user:location')
                                  → broadcast to all clients
Other users → fetchNearby() every 30s → update map markers
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | OAuth callback |
| GET | `/auth/logout` | Log out |
| GET | `/auth/me` | Get current user |
| PUT | `/api/users/profile` | Update profile |
| PUT | `/api/users/location` | Update location |
| GET | `/api/users/nearby` | Get nearby users |
| GET | `/api/users/:id` | Get user by ID |

---

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Auth**: Passport.js + Google OAuth 2.0
- **Database**: MongoDB Atlas (Mongoose + 2dsphere geo index)
- **Sessions**: express-session + connect-mongo
- **Frontend**: Vanilla HTML/CSS/JS, Leaflet.js
- **Map Tiles**: CartoDB Dark Matter (free, no API key)
- **Hosting**: Koyeb (Docker)

---

## Security Notes

- Sessions stored in MongoDB (not in-memory)
- Helmet.js for HTTP security headers
- Rate limiting (300 req/15min)
- Non-root Docker user
- Location only shared while `isOnline: true`
- Users can toggle visibility off at any time

---

## License

MIT
